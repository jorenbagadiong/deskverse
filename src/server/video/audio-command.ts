import "server-only"

import {
  AUDIO_OUTPUT,
  SAMPLES_PER_FRAME,
  VIDEO_FORMAT,
} from "@/lib/video/format"
import {
  narrationWindow,
  videoSamples,
  type NarrationWindow,
} from "@/lib/video/audio-timing"
import type {
  AudioAsset,
  AudioConfig,
  MusicLevel,
  VoiceoverTiming,
} from "@/lib/video/types"

/**
 * Builds the audio stage (DV-003C; trim, offset and crossfaded loops since
 * DV-003D3) as plain argument arrays (pure, no I/O).
 *
 * The verified silent video's H.264 stream is copied unchanged (`-c:v copy`);
 * only the new audio is encoded. User files are never part of a filter graph:
 * they are argv inputs (`-f <demuxer> -i file:<stored path>`), and every
 * number in the graph is computed and validated here.
 *
 * Timing is exact: the video lasts N frames at 30 fps, so the audio is made
 * exactly N × 1600 samples at 48 kHz (apad pads, atrim cuts), and nothing a
 * short or long audio file does can change the video's length.
 */

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

/**
 * Loudness targets (EBU R128 / ITU-R BS.1770 integrated loudness).
 * -16 LUFS is a common target for speech on mobile platforms; -1.5 dBTP
 * leaves headroom for AAC encoding. Music under narration sits well below
 * the speech and is additionally ducked while someone speaks.
 */
export const LOUDNESS = {
  speech: { I: -16, TP: -1.5, LRA: 11 },
  musicOnly: { I: -16, TP: -1.5, LRA: 11 },
  musicUnderSpeech: { low: -30, medium: -26, high: -23 } satisfies Record<
    MusicLevel,
    number
  >,
} as const

/** Ducking: music drops further while narration is above about -30 dBFS. */
const DUCKING = "threshold=0.03:ratio=6:attack=20:release=400"
/** Final peak protection: about -1.5 dBFS, delay-compensated. */
const LIMITER = "alimiter=limit=0.84:level=0:latency=1"
const MUSIC_FADE_OUT_SECONDS = 1.5
const MUSIC_FADE_IN_SECONDS = 0.05
const END_FADE_SECONDS = 0.05

// ---------------------------------------------------------------------------
// AAC encoder
// ---------------------------------------------------------------------------

/** Preference: FFmpeg's native encoder first (always LGPL-compatible). */
export const AAC_PREFERENCE = ["aac", "libfdk_aac", "aac_at", "aac_mf"] as const

/** Fixed AAC-LC options per encoder (never from the client). */
export function aacEncoderOptions(name: string): string[] {
  const bitrate = `${AUDIO_OUTPUT.bitrate / 1000}k`
  if (name === "aac" || name === "libfdk_aac")
    return ["-profile:a", "aac_low", "-b:a", bitrate]
  return ["-b:a", bitrate]
}

/** A real half-second AAC encode with the output options, to the null muxer. */
export function testAacEncodeArgs(encoder: string) {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:sample_rate=${AUDIO_OUTPUT.sampleRate}:duration=0.5`,
    "-ac",
    String(AUDIO_OUTPUT.channels),
    "-c:a",
    encoder,
    ...aacEncoderOptions(encoder),
    "-ar",
    String(AUDIO_OUTPUT.sampleRate),
    "-f",
    "null",
    "-",
  ]
}

// ---------------------------------------------------------------------------
// Inputs and loudness measurement
// ---------------------------------------------------------------------------

const DEMUXER: Record<AudioAsset["container"], string> = {
  mp3: "mp3",
  wav: "wav",
  m4a: "mov",
}

/** Forces the demuxer that FFprobe confirmed at upload: no format guessing. */
function audioInput(asset: AudioAsset, path: string) {
  return [
    "-protocol_whitelist",
    "file",
    "-f",
    DEMUXER[asset.container],
    "-i",
    `file:${path}`,
  ]
}

/** Converts to 48 kHz float stereo (mono is duplicated to both channels). */
const TO_STEREO_48K = `aresample=${AUDIO_OUTPUT.sampleRate},aformat=sample_fmts=fltp:sample_rates=${AUDIO_OUTPUT.sampleRate}:channel_layouts=stereo`

export interface LoudnessMeasurement {
  inputI: number
  inputTp: number
  inputLra: number
  inputThresh: number
  targetOffset: number
}

/** Samples of a music file used per loop: the whole file, or one video length. */
export function musicLoopSamples(music: AudioAsset, totalFrames: number) {
  return Math.max(
    1,
    Math.min(
      // Whole samples, ignoring float noise (2.3 s × 48 000 = 110 399.99…).
      Math.floor(music.durationSeconds * AUDIO_OUTPUT.sampleRate + 1e-6),
      videoSamples(totalFrames),
    ),
  )
}

/** Exactly `samples` long: pads with silence or cuts (after any resampling). */
const exactly = (samples: number) =>
  `apad=whole_len=${samples},atrim=end_sample=${samples}`

/**
 * The part of the voiceover recording that plays (DV-003D3), as 48 kHz
 * float stereo of exactly the selection's length. Used verbatim by both the
 * loudness measurement and the mix, so the measured audio is exactly the
 * audio that is normalized and heard.
 */
export function voiceoverSelection(window: NarrationWindow) {
  return `${TO_STEREO_48K},atrim=start_sample=${window.trimStartSample}:end_sample=${window.trimEndSample},asetpts=PTS-STARTPTS,${exactly(window.lengthSamples)}`
}

/** The part of the music file that loops (or plays once), likewise shared. */
export function musicSelection(loopSamples: number) {
  return `${TO_STEREO_48K},atrim=end_sample=${loopSamples},asetpts=PTS-STARTPTS,${exactly(loopSamples)}`
}

/**
 * Music looping (DV-003D3). A track shorter than the video repeats with a
 * short crossfade at every seam instead of a hard cut:
 *
 * - the first pass plays the track's start untouched, up to its last
 *   `crossfadeSamples`;
 * - every repeat starts with the track's last `crossfadeSamples` fading out
 *   (equal-power) over its first ones fading in, then continues from there.
 *
 * So the music repeats every `periodSamples` (= track − crossfade) exactly,
 * with no drift. The crossfade adapts to the track: 20 % of it, at most
 * 1 s. It smooths the level and removes clicks at the seam; it can't make
 * unrelated musical phrases line up.
 */
export interface MusicLoopPlan {
  sourceSamples: number
  /** False when the track covers the whole video (no seams). */
  loops: boolean
  crossfadeSamples: number
  periodSamples: number
  /** Output samples where each crossfade starts. */
  seams: number[]
}

export const MUSIC_CROSSFADE = { maxSeconds: 1, fraction: 0.2 } as const

export function musicLoopPlan(
  music: AudioAsset,
  totalFrames: number,
): MusicLoopPlan {
  const total = videoSamples(totalFrames)
  const sourceSamples = musicLoopSamples(music, totalFrames)
  if (sourceSamples >= total)
    return {
      sourceSamples,
      loops: false,
      crossfadeSamples: 0,
      periodSamples: sourceSamples,
      seams: [],
    }
  const crossfadeSamples = Math.max(
    1,
    Math.round(
      Math.min(
        MUSIC_CROSSFADE.maxSeconds * AUDIO_OUTPUT.sampleRate,
        sourceSamples * MUSIC_CROSSFADE.fraction,
      ),
    ),
  )
  const periodSamples = sourceSamples - crossfadeSamples
  const seams: number[] = []
  for (let at = periodSamples; at < total; at += periodSamples) seams.push(at)
  return { sourceSamples, loops: true, crossfadeSamples, periodSamples, seams }
}

/**
 * First loudnorm pass (measurement only, discarded output). It analyses
 * exactly the audio the second pass will process (the same selection
 * filters), and the JSON statistics it prints are parsed by
 * `parseLoudnormJson`.
 */
export function loudnessMeasureArgs(
  asset: AudioAsset,
  path: string,
  totalFrames: number,
  target: { I: number; TP: number; LRA: number },
  voiceoverTiming?: VoiceoverTiming,
) {
  const selection =
    asset.role === "music"
      ? musicSelection(musicLoopSamples(asset, totalFrames))
      : voiceoverSelection(
          narrationWindow(voiceoverTiming, asset.durationSeconds, totalFrames),
        )
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "info",
    "-nostats",
    ...audioInput(asset, path),
    "-map",
    "0:a:0",
    "-af",
    `${selection},loudnorm=I=${target.I}:TP=${target.TP}:LRA=${target.LRA}:print_format=json`,
    "-f",
    "null",
    "-",
  ]
}

const RANGES: Record<keyof LoudnessMeasurement, [number, number]> = {
  inputI: [-99, 0],
  inputTp: [-99, 99],
  inputLra: [0, 99],
  inputThresh: [-99, 0],
  targetOffset: [-99, 99],
}

/**
 * Reads loudnorm's JSON block from FFmpeg's log. Returns null for silent or
 * unmeasurable audio ("-inf"), so it can be rejected instead of amplified.
 */
export function parseLoudnormJson(log: string): LoudnessMeasurement | null {
  const start = log.lastIndexOf("{")
  const end = log.indexOf("}", start)
  if (start === -1 || end === -1) return null
  let json: Record<string, unknown>
  try {
    json = JSON.parse(log.slice(start, end + 1))
  } catch {
    return null
  }
  const values: LoudnessMeasurement = {
    inputI: Number(json.input_i),
    inputTp: Number(json.input_tp),
    inputLra: Number(json.input_lra),
    inputThresh: Number(json.input_thresh),
    targetOffset: Number(json.target_offset),
  }
  for (const [key, [min, max]] of Object.entries(RANGES) as [
    keyof LoudnessMeasurement,
    [number, number],
  ][]) {
    const value = values[key]
    if (!Number.isFinite(value) || value < min || value > max) return null
  }
  return values
}

/** Second loudnorm pass: linear gain from the measurement (numbers only). */
function loudnormLinear(
  target: { I: number; TP: number; LRA: number },
  m: LoudnessMeasurement,
) {
  const n = (value: number) => {
    if (!Number.isFinite(value)) throw new Error("Invalid loudness value.")
    return value.toFixed(2)
  }
  return `loudnorm=I=${target.I}:TP=${target.TP}:LRA=${target.LRA}:measured_I=${n(m.inputI)}:measured_TP=${n(m.inputTp)}:measured_LRA=${n(m.inputLra)}:measured_thresh=${n(m.inputThresh)}:offset=${n(m.targetOffset)}:linear=true`
}

// ---------------------------------------------------------------------------
// Mix + mux
// ---------------------------------------------------------------------------

export interface AudioSource {
  asset: AudioAsset
  /** Stored file path (an argv element only). */
  path: string
  measurement: LoudnessMeasurement
}

export interface AudioPlan {
  args: string[]
  output: string
  /** Exact length of the audio in samples (= video frames × 1600). */
  samples: number
  totalSeconds: number
}

/** The loudness target for each source in a given mode. */
export function loudnessTarget(
  role: "voiceover" | "music",
  config: AudioConfig,
) {
  if (role === "voiceover") return LOUDNESS.speech
  return config.mode === "voiceover-and-music"
    ? { ...LOUDNESS.musicOnly, I: LOUDNESS.musicUnderSpeech[config.musicLevel] }
    : LOUDNESS.musicOnly
}

/**
 * Builds the audio stage for a verified silent video. The resulting MP4 has
 * the original H.264 stream (copied) and exactly one AAC-LC 48 kHz stereo
 * stream of exactly the video's length.
 */
export function buildAudioPlan({
  config,
  voiceover,
  music,
  totalFrames,
  aacEncoder,
  videoFile = "render.mp4",
  output = "final.mp4",
}: {
  config: AudioConfig
  voiceover: AudioSource | null
  music: AudioSource | null
  totalFrames: number
  aacEncoder: string
  videoFile?: string
  output?: string
}): AudioPlan {
  if (config.mode === "none")
    throw new Error("Silent videos have no audio stage.")
  const wantsVoice =
    config.mode === "voiceover" || config.mode === "voiceover-and-music"
  const wantsMusic =
    config.mode === "music" || config.mode === "voiceover-and-music"
  if (wantsVoice !== (voiceover !== null) || wantsMusic !== (music !== null))
    throw new Error("Audio sources don't match the audio mode.")
  if (!Number.isInteger(totalFrames) || totalFrames <= 0)
    throw new Error("Invalid video length.")

  const samples = totalFrames * SAMPLES_PER_FRAME
  const totalSeconds = totalFrames / VIDEO_FORMAT.fps
  const seconds = (value: number) => Math.max(value, 0).toFixed(3)
  const exactLength = exactly(samples)

  const inputs = ["-protocol_whitelist", "file", "-i", `file:${videoFile}`]
  const chains: string[] = []
  let next = 1

  if (voiceover) {
    inputs.push(...audioInput(voiceover.asset, voiceover.path))
    const index = next++
    const window = narrationWindow(
      config.voiceoverTiming,
      voiceover.asset.durationSeconds,
      totalFrames,
    )
    if (window.endSample > samples && !window.legacy)
      throw new Error("The narration doesn't fit the video.")
    // The selection (trimmed exactly as it was measured), normalized, then
    // delayed by the offset with real silence (sample-exact: adelay in
    // samples) and padded with silence to the end of the video. Older
    // projects play from 0:00, cut at the video boundary as before.
    const delay =
      window.startSample > 0
        ? `,adelay=delays=${window.startSample}S:all=1`
        : ""
    chains.push(
      `[${index}:a]${voiceoverSelection(window)},${loudnormLinear(loudnessTarget("voiceover", config), voiceover.measurement)},aresample=${AUDIO_OUTPUT.sampleRate},${exactly(window.lengthSamples)}${delay},${exactLength}[voice]`,
    )
  }

  if (music) {
    inputs.push(...audioInput(music.asset, music.path))
    const index = next++
    const plan = musicLoopPlan(music.asset, totalFrames)
    const L = plan.sourceSamples
    const fades = `afade=t=in:d=${seconds(MUSIC_FADE_IN_SECONDS)},afade=t=out:st=${seconds(totalSeconds - MUSIC_FADE_OUT_SECONDS)}:d=${seconds(MUSIC_FADE_OUT_SECONDS)}`
    const normalized = `[${index}:a]${musicSelection(L)},${loudnormLinear(loudnessTarget("music", config), music.measurement)},aresample=${AUDIO_OUTPUT.sampleRate},${exactly(L)}`
    if (!plan.loops) chains.push(`${normalized},${exactLength},${fades}[music]`)
    else {
      // A fixed-size graph however many times the track repeats: one
      // crossfaded seam, looped by aloop (finite; the final atrim ends it).
      const X = plan.crossfadeSamples
      const P = plan.periodSamples
      const repeats = Math.ceil((samples - P) / P) + 1
      const part = (label: string, trim: string, then = "") =>
        `[m${label}]atrim=${trim},asetpts=PTS-STARTPTS${then}[${label}]`
      chains.push(
        `${normalized},asplit=4[mfirst][mtail][mhead][mmiddle]`,
        part("first", `end_sample=${P}`),
        part(
          "tail",
          `start_sample=${P}`,
          `,afade=t=out:ss=0:ns=${X}:curve=qsin`,
        ),
        part("head", `end_sample=${X}`, `,afade=t=in:ss=0:ns=${X}:curve=qsin`),
        part("middle", `start_sample=${X}:end_sample=${P}`),
        // Equal-power crossfade, built from two fades and a plain sum so it
        // is exactly X samples. (acrossfade returns nothing when both of
        // its inputs are exactly as long as the fade, as here.)
        `[tail][head]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[seam]`,
        `[seam][middle]concat=n=2:v=0:a=1,aloop=loop=${repeats}:size=${P},asetpts=N/SR/TB[repeat]`,
        `[first][repeat]concat=n=2:v=0:a=1,asetpts=N/SR/TB,${exactLength},${fades}[music]`,
      )
    }
  }

  const finish = `${LIMITER},aresample=${AUDIO_OUTPUT.sampleRate},${exactLength},afade=t=out:st=${seconds(totalSeconds - END_FADE_SECONDS)}:d=${seconds(END_FADE_SECONDS)},aformat=sample_fmts=fltp:sample_rates=${AUDIO_OUTPUT.sampleRate}:channel_layouts=stereo[aout]`
  if (voiceover && music)
    chains.push(
      "[voice]asplit=2[vmix][vkey]",
      `[music][vkey]sidechaincompress=${DUCKING}[ducked]`,
      `[vmix][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${finish}`,
    )
  else chains.push(`[${voiceover ? "voice" : "music"}]${finish}`)

  return {
    samples,
    totalSeconds,
    output,
    args: [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostats",
      "-progress",
      "pipe:1",
      ...inputs,
      "-filter_complex",
      chains.join(";"),
      "-map",
      "0:v:0",
      "-map",
      "[aout]",
      "-map_metadata",
      "0",
      "-map_chapters",
      "-1",
      "-c:v",
      "copy",
      "-c:a",
      aacEncoder,
      ...aacEncoderOptions(aacEncoder),
      "-ar",
      String(AUDIO_OUTPUT.sampleRate),
      "-ac",
      String(AUDIO_OUTPUT.channels),
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "-y",
      `file:${output}`,
    ],
  }
}
