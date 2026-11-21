/**
 * Real FFmpeg tests for voiceover trimming, narration offsets, crossfaded
 * music loops and MP3 cover art (DV-003D3). Run with `yarn test:integration`.
 *
 * Audio is checked on decoded samples, not just metadata:
 * - marker tones placed at known samples in a recording must land at the
 *   exact sample the timing predicts (trim + offset), and audio outside the
 *   selection must never appear;
 * - the part of the recording that is trimmed away is much louder than the
 *   selection, so measuring the wrong section would miss the loudness target;
 * - music seams are compared with a hard-cut loop of the same track: clicks
 *   (sample-to-sample jumps) and level jumps must shrink to steady-state.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { videoSamples } from "@/lib/video/audio-timing"
import type { FfmpegCapabilityReport } from "@/lib/video/capabilities"
import { STATIC_EFFECTS } from "@/lib/video/effects"
import type {
  AudioAsset,
  AudioConfig,
  ProductInfo,
  VoiceoverTiming,
} from "@/lib/video/types"
import {
  createRunner,
  spawnTool,
  type Spawner,
} from "@/server/process/run-executable"
import {
  buildAudioPlan,
  loudnessMeasureArgs,
  loudnessTarget,
  musicLoopPlan,
  parseLoudnormJson,
  type AudioSource,
} from "@/server/video/audio-command"
import { detectFfmpegCapabilities } from "@/server/video/ffmpeg-capabilities"
import { fontDirectory, loadVideoFont } from "@/server/video/font-metrics"
import { buildTrustedProject } from "@/server/video/project"
import { RenderQueue } from "@/server/video/render-queue"
import { renderVideo } from "@/server/video/render-service"
import { createVideoStorage, type VideoStorage } from "@/server/video/storage"
import {
  createAudioInspector,
  createUploadVerifier,
} from "@/server/video/upload-verify"

const commands = { ffmpeg: "ffmpeg", ffprobe: "ffprobe" }
const fonts = { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") }
const SR = 48_000
const FRAMES = 570 // 19 s
const product: ProductInfo = {
  name: "Trailblazer travel mug",
  headline: "Hot coffee for 12 hours",
  // Three benefits: a 19 s video (3 + 3 × 4 + 4).
  benefits: [
    "Leak-proof lid for your bag",
    "Fits every cup holder",
    "Keeps ice for a day",
  ],
  callToAction: "Tap the link to shop",
  disclosure: "#ad · I may earn a commission if you buy through my link.",
}

let base: string
let media: string
let capabilities: FfmpegCapabilityReport

function ffmpeg(args: string[], cwd?: string) {
  return execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args], {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
  })
}

function durationOf(file: string) {
  return Number(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      file,
    ])
      .toString()
      .trim(),
  )
}

/** Decoded mono float samples of a file's first audio stream. */
function pcm(file: string) {
  const out = ffmpeg([
    "-i",
    file,
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    String(SR),
    "-f",
    "f32le",
    "-",
  ])
  return new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4)
}

/** Integrated loudness (LUFS) and true peak (dBTP) of a file's audio. */
function ebur128(file: string) {
  const { stderr } = spawnSync(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-i",
      file,
      "-map",
      "0:a",
      "-af",
      "ebur128=peak=true",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"))
  return {
    integrated: Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]),
    truePeak: Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]),
  }
}

/**
 * The audio is made exactly `samples` long, and the MP4 says so; decoding
 * AAC returns whole 1024-sample frames, so the decoded tail may carry up to
 * 1023 samples of encoder padding, which must be silent.
 */
function expectAacLength(x: Float32Array, samples: number) {
  expect(x.length).toBeGreaterThanOrEqual(samples)
  expect(x.length - samples).toBeLessThan(1024)
  expect(peak(x, samples)).toBeLessThan(0.01)
}

const firstAbove = (x: Float32Array, threshold: number, from = 0) => {
  for (let i = from; i < x.length; i++) if (Math.abs(x[i]) > threshold) return i
  return -1
}
const lastAbove = (x: Float32Array, threshold: number) => {
  for (let i = x.length - 1; i >= 0; i--)
    if (Math.abs(x[i]) > threshold) return i
  return -1
}
const peak = (x: Float32Array, from = 0, to = x.length) => {
  let m = 0
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(x[i]))
  return m
}

/** Largest sample-to-sample jump in [from, to). */
function maxJump(x: Float32Array, from: number, to: number) {
  let m = 0
  for (let i = Math.max(from, 1); i < Math.min(to, x.length); i++)
    m = Math.max(m, Math.abs(x[i] - x[i - 1]))
  return m
}

/** 99.9th percentile of sample-to-sample jumps outside the given windows. */
function steadyJump(
  x: Float32Array,
  exclude: [number, number][],
  from: number,
  to: number,
) {
  const jumps: number[] = []
  for (let i = Math.max(from, 1); i < to; i += 3) {
    if (exclude.some(([a, b]) => i >= a && i < b)) continue
    jumps.push(Math.abs(x[i] - x[i - 1]))
  }
  jumps.sort((a, b) => a - b)
  return jumps[Math.floor(jumps.length * 0.999)]
}

/** Largest change (dB) between consecutive 50 ms RMS windows in [from, to). */
function maxLevelStep(x: Float32Array, from: number, to: number) {
  const w = SR / 20
  const levels: number[] = []
  for (let i = from; i + w <= to; i += w) {
    let sum = 0
    for (let j = i; j < i + w; j++) sum += x[j] * x[j]
    levels.push(10 * Math.log10(sum / w + 1e-12))
  }
  let m = 0
  for (let i = 1; i < levels.length; i++)
    m = Math.max(m, Math.abs(levels[i] - levels[i - 1]))
  return m
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A 25 s, 48 kHz recording with sample-exact markers:
 * - 0.5–2.5 s and 19–24 s: a LOUD tone (amplitude 0.9), outside the selection;
 * - 3.0 s: a 1 kHz burst starting at full amplitude (cosine) — selection start;
 * - 3.5–17.0 s: a moderate 300 Hz "speech" tone (0.3);
 * - 17.9–18.0 s: a burst ending exactly at 18.0 s at full amplitude — selection end.
 */
async function markedRecording(file: string) {
  const expr = [
    "0.9*sin(2*PI*500*t)*(between(t,0.5,2.5)+between(t,19,24))",
    "0.5*cos(2*PI*1000*(t-3))*gte(t,3)*lt(t,3.1)",
    "0.3*sin(2*PI*300*t)*between(t,3.5,17)",
    "0.5*cos(2*PI*1000*(t-17.9))*gte(t,17.9)*lt(t,18)",
  ].join("+")
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `aevalsrc='${expr}':s=${SR}:d=25`,
    "-c:a",
    "pcm_s16le",
    file,
  ])
}

/** Band-limited noise that rises from quiet to loud: worst case for seams. */
async function musicTrack(file: string, seconds: number) {
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `anoisesrc=color=pink:amplitude=0.6:d=${seconds}:r=${SR}:seed=7`,
    "-af",
    `lowpass=f=1500,lowpass=f=1500,volume='0.25+0.75*t/${seconds}':eval=frame`,
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    file,
  ])
}

/** A tiny silent H.264 video of FRAMES frames, for plan-level mixes. */
async function tinyVideo(dir: string) {
  ffmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      `color=c=gray:s=64x64:r=30:d=${FRAMES / 30}`,
      "-frames:v",
      String(FRAMES),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "render.mp4",
    ],
    dir,
  )
}

function asset(
  role: "voiceover" | "music",
  file: string,
  container: AudioAsset["container"] = "wav",
): AudioAsset {
  return {
    id: `asset_${role === "voiceover" ? "a" : "b"}${"0".repeat(31)}` as AudioAsset["id"],
    kind: "audio",
    role,
    container,
    codec: container === "mp3" ? "mp3" : "pcm_s16le",
    sizeBytes: 1000,
    durationSeconds: durationOf(file),
    sampleRate: SR,
    channels: 2,
    displayName: path.basename(file),
  }
}

/** Runs the real two-pass audio stage (measure, then mix) in `dir`. */
async function mix(
  dir: string,
  config: AudioConfig,
  files: { voiceover?: string; music?: string },
) {
  const source = async (
    role: "voiceover" | "music",
    file: string | undefined,
  ): Promise<AudioSource | null> => {
    if (!file) return null
    const a = asset(role, file)
    const measured = await spawnTool(
      "ffmpeg",
      loudnessMeasureArgs(
        a,
        file,
        FRAMES,
        loudnessTarget(role, config),
        role === "voiceover" ? config.voiceoverTiming : undefined,
      ),
      { cwd: dir, timeoutMs: 60_000 },
    )
    const measurement = measured.ok
      ? parseLoudnormJson(measured.stderrTail)
      : null
    if (!measurement)
      throw new Error(`measurement failed: ${measured.stderrTail}`)
    return { asset: a, path: file, measurement }
  }
  const plan = buildAudioPlan({
    config,
    voiceover: await source("voiceover", files.voiceover),
    music: await source("music", files.music),
    totalFrames: FRAMES,
    aacEncoder: "aac",
  })
  const result = await spawnTool("ffmpeg", plan.args, {
    cwd: dir,
    timeoutMs: 120_000,
  })
  if (!result.ok) throw new Error(`mix failed: ${result.stderrTail}`)
  return { file: path.join(dir, plan.output), plan }
}

/**
 * The same filter graph, written losslessly (float WAV, audio only), to
 * check timing at the exact sample without the AAC codec's smearing.
 */
async function losslessMix(dir: string, args: string[]) {
  const graph = args[args.indexOf("-filter_complex") + 1]
  const inputs = args.slice(
    args.indexOf("-progress") + 2,
    args.indexOf("-filter_complex"),
  )
  const result = await spawnTool(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      ...inputs,
      "-filter_complex",
      graph,
      "-map",
      "[aout]",
      "-c:a",
      "pcm_f32le",
      "-f",
      "wav",
      "-y",
      "file:lossless.wav",
    ],
    { cwd: dir, timeoutMs: 120_000 },
  )
  if (!result.ok) throw new Error(`lossless mix failed: ${result.stderrTail}`)
  return pcm(path.join(dir, "lossless.wav"))
}

const VOICE_ONLY = (timing?: VoiceoverTiming): AudioConfig => ({
  mode: "voiceover",
  voiceoverAssetId: asset("voiceover", path.join(media, "marked.wav")).id,
  musicAssetId: null,
  musicLevel: "low",
  ...(timing ? { voiceoverTiming: timing } : {}),
})

beforeAll(async () => {
  capabilities = await detectFfmpegCapabilities({
    run: createRunner({ timeoutMs: 30_000 }),
  })
  if (capabilities.status !== "ready" || !capabilities.audio.ready)
    throw new Error("FFmpeg with audio support is required for these tests.")
  base = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-audio-timing-"))
  media = path.join(base, "media")
  await fs.mkdir(media)
  await markedRecording(path.join(media, "marked.wav"))
  await musicTrack(path.join(media, "short-music.wav"), 2.3)
  await musicTrack(path.join(media, "long-music.wav"), 40)
})

afterAll(async () => {
  if (base) await fs.rm(base, { recursive: true, force: true })
})

async function workDir(name: string) {
  const dir = path.join(base, name)
  await fs.mkdir(dir)
  await tinyVideo(dir)
  return dir
}

// ---------------------------------------------------------------------------
// Voiceover timing
// ---------------------------------------------------------------------------

describe("voiceover trim and offset (real FFmpeg)", () => {
  it("plays exactly the selection, at the offset, sample-accurately", async () => {
    const dir = await workDir("trim-offset")
    const timing = { trimStartMs: 3000, trimEndMs: 18_000, offsetMs: 2000 }
    const { file, plan } = await mix(dir, VOICE_ONLY(timing), {
      voiceover: path.join(media, "marked.wav"),
    })

    // Lossless: exactly the video's samples, selection at the exact sample.
    const exact = await losslessMix(dir, plan.args)
    expect(exact.length).toBe(videoSamples(FRAMES))
    const exactPeak = peak(exact)
    expect(firstAbove(exact, exactPeak * 0.25)).toBe(2 * SR)
    expect(lastAbove(exact, exactPeak * 0.25)).toBe(17 * SR - 1)
    expect(peak(exact, 0, 2 * SR - 48)).toBeLessThan(exactPeak * 0.001)
    expect(peak(exact, 17 * SR + 48)).toBeLessThan(exactPeak * 0.001)

    // The published AAC track: the same timing within the codec's smearing.
    const x = pcm(file)
    expectAacLength(x, videoSamples(FRAMES))
    const loudest = peak(x)
    // Nothing before the offset: the loud excluded tone never appears. (The
    // burst starts with a full-amplitude step, which band-limited
    // resampling and AAC ring a few samples ahead of; skip those 2 ms.)
    expect(peak(x, 0, 2 * SR - 96)).toBeLessThan(loudest * 0.01)
    // The start burst begins at 2.000 s (sample 96 000) and the end burst
    // stops at 2.0 + 15.0 = 17.000 s, within 5 samples (0.1 ms).
    const onset = firstAbove(x, loudest * 0.25)
    expect(Math.abs(onset - 2 * SR)).toBeLessThanOrEqual(5)
    const end = lastAbove(x, loudest * 0.25)
    expect(Math.abs(end - 17 * SR)).toBeLessThanOrEqual(5)
    expect(peak(x, 17 * SR + 48)).toBeLessThan(loudest * 0.01)
    console.info(
      `[audio-timing] onset at sample ${onset} (expected ${2 * SR}), last narration sample ${end} (expected ${17 * SR - 1})`,
    )
  })

  it("measures loudness on the selection only: the trimmed-away loud parts don't skew it", async () => {
    const dir = await workDir("trim-loudness")
    const { file } = await mix(
      dir,
      VOICE_ONLY({ trimStartMs: 3000, trimEndMs: 18_000, offsetMs: 0 }),
      { voiceover: path.join(media, "marked.wav") },
    )
    const { integrated, truePeak } = ebur128(file)
    expect(integrated).toBeGreaterThan(-17.5)
    expect(integrated).toBeLessThan(-14.5)
    expect(truePeak).toBeLessThan(-0.5)
  })

  it("keeps the old behaviour without timing: the whole recording from 0:00, cut at the video's end", async () => {
    const dir = await workDir("legacy")
    const { file } = await mix(dir, VOICE_ONLY(), {
      voiceover: path.join(media, "marked.wav"),
    })
    const x = pcm(file)
    expectAacLength(x, videoSamples(FRAMES))
    // The loud tone at 0.5 s is part of the (untrimmed) recording.
    const onset = firstAbove(x, peak(x) * 0.25)
    expect(Math.abs(onset - 0.5 * SR)).toBeLessThan(SR / 100)
  })
})

// ---------------------------------------------------------------------------
// Music loops
// ---------------------------------------------------------------------------

describe("crossfaded music loops (real FFmpeg)", () => {
  it("loops a short track with crossfades: no clicks or level jumps at any seam, exact length", async () => {
    const dir = await workDir("loops")
    const music = path.join(media, "short-music.wav")
    const config: AudioConfig = {
      mode: "music",
      voiceoverAssetId: null,
      musicAssetId: asset("music", music).id,
      musicLevel: "low",
    }
    const { file } = await mix(dir, config, { music })
    const x = pcm(file)
    expectAacLength(x, videoSamples(FRAMES))
    const plan = musicLoopPlan(asset("music", music), FRAMES)
    expect(plan.loops).toBe(true)
    expect(plan.seams.length).toBeGreaterThanOrEqual(5)
    // Seams every period exactly, no drift: last seam = n × period.
    plan.seams.forEach((at, i) => expect(at).toBe((i + 1) * plan.periodSamples))

    // The same track looped with hard cuts, for comparison.
    ffmpeg(
      [
        "-i",
        music,
        "-af",
        `aresample=${SR},aloop=loop=20:size=${plan.sourceSamples},atrim=end_sample=${videoSamples(FRAMES)}`,
        "-ac",
        "1",
        "hard.wav",
      ],
      dir,
    )
    const hard = pcm(path.join(dir, "hard.wav"))
    const hardSeams: number[] = []
    for (
      let at = plan.sourceSamples;
      at < hard.length;
      at += plan.sourceSamples
    )
      hardSeams.push(at)

    const fadeEnd = x.length - 2 * SR // ignore the final fade-out
    const window = (at: number, width: number) =>
      [at - 480, at + width + 480] as [number, number]
    const steady = steadyJump(
      x,
      plan.seams.map((s) => window(s, plan.crossfadeSamples)),
      SR / 10,
      fadeEnd,
    )
    const hardSteady = steadyJump(
      hard,
      hardSeams.map((s) => window(s, 0)),
      SR / 10,
      fadeEnd,
    )
    // The track's own window-to-window level fluctuation, away from seams.
    const levelSteps = (
      signal: Float32Array,
      seams: number[],
      width: number,
    ) => {
      const steps: number[] = []
      for (let at = SR / 2; at + SR / 2 < fadeEnd; at += SR / 4) {
        if (seams.some((s) => at > s - SR / 2 && at < s + width + SR / 2))
          continue
        steps.push(maxLevelStep(signal, at, at + SR / 4))
      }
      return Math.max(...steps)
    }
    const natural = levelSteps(x, plan.seams, plan.crossfadeSamples)
    const report: string[] = []
    const levels: number[] = []
    for (const at of plan.seams.filter(
      (s) => s + plan.crossfadeSamples < fadeEnd,
    )) {
      const [a, b] = window(at, plan.crossfadeSamples)
      const click = maxJump(x, a, b) / steady
      const level = maxLevelStep(
        x,
        at - SR / 10,
        at + plan.crossfadeSamples + SR / 10,
      )
      expect(click, `click at ${at}`).toBeLessThan(1.6)
      levels.push(level)
      report.push(
        `${(at / SR).toFixed(2)}s click×${click.toFixed(2)} step ${level.toFixed(1)}dB`,
      )
    }
    // The hard-cut version really has the artifacts the crossfade removes.
    const hardClicks = hardSeams
      .filter((s) => s < fadeEnd)
      .map((at) => maxJump(hard, at - 480, at + 480) / hardSteady)
    const hardSteps = hardSeams
      .filter((s) => s < fadeEnd)
      .map((at) => maxLevelStep(hard, at - SR / 10, at + SR / 10))
    const hardNatural = levelSteps(hard, hardSeams, 0)
    // The fixture ramps 12 dB from start to end, so every hard seam jumps
    // from loud to quiet at once. The crossfade spreads that change over
    // its length: each 50 ms step is at most half the hard cut's.
    expect(Math.max(...hardSteps)).toBeGreaterThan(hardNatural + 3)
    for (const level of levels)
      expect(level).toBeLessThan(Math.max(...hardSteps) / 2)
    console.info(
      `[audio-timing] natural 50 ms level steps ≤ ${natural.toFixed(1)} dB; crossfaded seams: ${report.join(", ")}; hard cuts: click×${Math.max(...hardClicks).toFixed(2)}, step ${Math.max(...hardSteps).toFixed(1)} dB (natural ${hardNatural.toFixed(1)} dB)`,
    )
  })

  it("plays a track longer than the video once (no seams), fading out, exact length", async () => {
    const dir = await workDir("long-music")
    const music = path.join(media, "long-music.wav")
    const config: AudioConfig = {
      mode: "music",
      voiceoverAssetId: null,
      musicAssetId: asset("music", music).id,
      musicLevel: "low",
    }
    expect(musicLoopPlan(asset("music", music), FRAMES).loops).toBe(false)
    const { file } = await mix(dir, config, { music })
    const x = pcm(file)
    expectAacLength(x, videoSamples(FRAMES))
    // Fade-out: the last 50 ms are near silent, the middle isn't.
    expect(peak(x, x.length - SR / 20)).toBeLessThan(
      peak(x, 5 * SR, 6 * SR) * 0.1,
    )
  })

  it("voiceover + looping music: narration at its offset, music ducked under it, peaks protected", async () => {
    const dir = await workDir("voice-music")
    const music = path.join(media, "short-music.wav")
    const config: AudioConfig = {
      mode: "voiceover-and-music",
      voiceoverAssetId: asset("voiceover", path.join(media, "marked.wav")).id,
      musicAssetId: asset("music", music).id,
      musicLevel: "medium",
      voiceoverTiming: { trimStartMs: 3000, trimEndMs: 18_000, offsetMs: 2000 },
    }
    const { file } = await mix(dir, config, {
      voiceover: path.join(media, "marked.wav"),
      music,
    })
    const x = pcm(file)
    expectAacLength(x, videoSamples(FRAMES))
    const rms = (a: number, b: number) => {
      let s = 0
      for (let i = a; i < b; i++) s += x[i] * x[i]
      return 10 * Math.log10(s / (b - a))
    }
    // Before the narration, music alone; during it, speech dominates.
    const musicAlone = rms(Math.round(0.5 * SR), Math.round(1.8 * SR))
    const withSpeech = rms(Math.round(8 * SR), Math.round(12 * SR))
    expect(withSpeech - musicAlone).toBeGreaterThan(6)
    expect(ebur128(file).truePeak).toBeLessThan(-0.5)
  })
})

// ---------------------------------------------------------------------------
// MP3 cover art
// ---------------------------------------------------------------------------

describe("MP3 cover art (real FFmpeg)", () => {
  async function fixtures() {
    const dir = path.join(media, "mp3")
    await fs.mkdir(dir, { recursive: true })
    const tone = path.join(dir, "tone.wav")
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "sine=f=330:d=6:sample_rate=44100",
      "-ac",
      "2",
      tone,
    ])
    for (const [name, size] of [
      ["cover.jpg", "300x300"],
      ["cover.png", "200x200"],
      ["cover.gif", "200x200"],
    ])
      ffmpeg([
        "-f",
        "lavfi",
        "-i",
        `testsrc2=s=${size}`,
        "-frames:v",
        "1",
        path.join(dir, name),
      ])
    const withPictures = (
      out: string,
      pictures: string[],
      extra: string[] = [],
    ) => {
      ffmpeg([
        "-i",
        tone,
        ...pictures.flatMap((p) => ["-i", path.join(dir, p)]),
        "-map",
        "0:a",
        ...pictures.flatMap((_, i) => ["-map", `${i + 1}:v`]),
        "-c:a",
        out.endsWith(".m4a") ? "aac" : "libmp3lame",
        "-c:v",
        "copy",
        ...(out.endsWith(".mp3") ? ["-id3v2_version", "3"] : []),
        "-disposition:v",
        "attached_pic",
        ...extra,
        path.join(dir, out),
      ])
      return fs.readFile(path.join(dir, out))
    }
    return {
      jpg: await withPictures("cover-jpg.mp3", ["cover.jpg"]),
      png: await withPictures("cover-png.mp3", ["cover.png"]),
      two: await withPictures("two-covers.mp3", ["cover.jpg", "cover.png"]),
      gif: await withPictures("gif-cover.mp3", ["cover.gif"]),
      m4a: await withPictures("cover.m4a", ["cover.jpg"]),
    }
  }

  async function uploadAudio(
    storage: VideoStorage,
    jobId: string,
    bytes: Buffer,
    fileName: string,
    role: "voiceover" | "music" = "music",
  ) {
    return storage.addAudioAsset(
      jobId,
      {
        bytes: new Uint8Array(bytes),
        declaredType: fileName.endsWith(".m4a") ? "audio/mp4" : "audio/mpeg",
        fileName,
        role,
      },
      {
        inspect: createAudioInspector(
          createRunner({ timeoutMs: 30_000 }),
          commands,
        ),
      },
    )
  }

  it("accepts one ordinary JPEG or PNG cover; rejects two pictures, odd pictures and covers outside MP3", async () => {
    const f = await fixtures()
    const storage = createVideoStorage(path.join(base, "cover-uploads"))
    for (const [bytes, name] of [
      [f.jpg, "cover-jpg.mp3"],
      [f.png, "cover-png.mp3"],
    ] as const) {
      const job = await storage.createJob()
      const stored = await uploadAudio(storage, job.id, bytes, name)
      expect(stored).toMatchObject({
        container: "mp3",
        codec: "mp3",
        channels: 2,
      })
      expect(stored.durationSeconds).toBeGreaterThan(5.9)
    }
    for (const [bytes, name, reason] of [
      [f.two, "two-covers.mp3", /more than one embedded picture/],
      [f.gif, "gif-cover.mp3", /isn't an ordinary JPEG or PNG/],
      [f.m4a, "cover.m4a", /embedded cover art/],
    ] as const) {
      const job = await storage.createJob()
      await expect(
        uploadAudio(storage, job.id, bytes, name),
        name,
      ).rejects.toMatchObject({
        code: "invalid-upload",
        message: expect.stringMatching(reason),
      })
      expect((await storage.readJob(job.id)).audioAssets).toEqual([])
    }
  })

  it("renders with a cover-art MP3: the artwork never reaches the MP4", async () => {
    const f = await fixtures()
    const storage = createVideoStorage(path.join(base, "cover-render"))
    const job = await storage.createJob()
    const ids = await uploadImages(storage, job.id)
    const music = await uploadAudio(
      storage,
      job.id,
      f.jpg,
      "song-with-cover.mp3",
    )
    const { file, done } = await renderJob(storage, job.id, ids, {
      mode: "music",
      voiceoverAssetId: null,
      musicAssetId: music.id,
      musicLevel: "low",
    })
    expect(done.state).toBe("completed")
    const streams = JSON.parse(
      execFileSync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,width,height:stream_disposition=attached_pic",
        "-of",
        "json",
        file,
      ]).toString(),
    ).streams
    expect(streams).toEqual([
      expect.objectContaining({
        codec_type: "video",
        codec_name: "h264",
        width: 1080,
      }),
      expect.objectContaining({ codec_type: "audio", codec_name: "aac" }),
    ])
  })
})

// ---------------------------------------------------------------------------
// Full pipeline: trimmed narration, cancellation, retry
// ---------------------------------------------------------------------------

async function uploadImages(storage: VideoStorage, jobId: string) {
  const verify = createUploadVerifier(
    createRunner({ timeoutMs: 15_000 }),
    commands,
  )
  const ids = []
  for (const [i, source] of [
    "testsrc2",
    "mandelbrot",
    "smptehdbars",
  ].entries()) {
    const file = path.join(media, `img-${i}.png`)
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `${source}=s=1200x1200`,
      "-frames:v",
      "1",
      file,
    ])
    const asset = await storage.addImageAsset(
      jobId,
      {
        bytes: await fs.readFile(file),
        declaredType: "image/png",
        fileName: `img-${i}.png`,
      },
      { verify },
    )
    ids.push(asset.id)
  }
  return ids
}

async function uploadVoice(storage: VideoStorage, jobId: string) {
  return storage.addAudioAsset(
    jobId,
    {
      bytes: await fs.readFile(path.join(media, "marked.wav")),
      declaredType: "audio/wav",
      fileName: "narration.wav",
      role: "voiceover",
    },
    {
      inspect: createAudioInspector(
        createRunner({ timeoutMs: 30_000 }),
        commands,
      ),
    },
  )
}

function queueFor(
  storage: VideoStorage,
  spawn: Spawner = spawnTool,
  onProgress?: (p: { phase: string; step?: string }) => void,
) {
  return new RenderQueue(storage, (jobId, report, signal) =>
    renderVideo(
      jobId,
      {
        storage,
        spawn,
        run: createRunner({ timeoutMs: 60_000 }),
        getCapabilities: async () => capabilities,
        commands,
        fonts,
        fontDir: fontDirectory(),
        threads: 4,
        timeouts: { sceneMs: 60_000, encodeMs: 300_000, audioMs: 120_000 },
        log: () => {},
      },
      (progress) => {
        report(progress)
        onProgress?.(progress as { phase: string; step?: string })
      },
      signal,
    ),
  )
}

async function renderJob(
  storage: VideoStorage,
  jobId: string,
  assetIds: string[],
  audio: AudioConfig,
  spawn?: Spawner,
) {
  const project = buildTrustedProject(
    await storage.readJob(jobId),
    { product, assetIds, audio, effects: STATIC_EFFECTS },
    fonts,
  )
  if (!project.ok) throw new Error(JSON.stringify(project.issues))
  await storage.writeProject(jobId, project.value)
  const queue = queueFor(storage, spawn)
  await queue.enqueue(jobId)
  await queue.whenIdle()
  const done = await storage.readJob(jobId)
  const out = await storage.resolveCompletedOutput(jobId)
  return { done, file: out?.path ?? "", queue, project: project.value }
}

describe("trimmed narration through the render pipeline (real FFmpeg)", () => {
  it("rejects narration that can't fit, and timing for a mode without voiceover", async () => {
    const storage = createVideoStorage(path.join(base, "reject"))
    const job = await storage.createJob()
    const ids = await uploadImages(storage, job.id)
    const voice = await uploadVoice(storage, job.id)
    const fresh = await storage.readJob(job.id)
    const tooLate = buildTrustedProject(
      fresh,
      {
        product,
        assetIds: ids,
        audio: {
          mode: "voiceover",
          voiceoverAssetId: voice.id,
          musicAssetId: null,
          musicLevel: "low",
          voiceoverTiming: {
            trimStartMs: 3000,
            trimEndMs: 18_000,
            offsetMs: 5000,
          },
        },
      },
      fonts,
    )
    expect(tooLate.ok).toBe(false)
    expect(!tooLate.ok && tooLate.issues[0]).toMatchObject({
      path: "audio.voiceoverTiming.offsetMs",
      message: expect.stringMatching(/would play from 5 s to 20 s/),
    })
    const pastEnd = buildTrustedProject(
      fresh,
      {
        product,
        assetIds: ids,
        audio: {
          mode: "voiceover",
          voiceoverAssetId: voice.id,
          musicAssetId: null,
          musicLevel: "low",
          voiceoverTiming: { trimStartMs: 0, trimEndMs: 26_000, offsetMs: 0 },
        },
      },
      fonts,
    )
    expect(!pastEnd.ok && pastEnd.issues[0].message).toMatch(
      /past the end of the recording \(25 s\)/,
    )
  })

  it("renders, verifies and publishes trimmed, offset narration; cancels mid-mix; retries with the saved timing", async () => {
    const storage = createVideoStorage(path.join(base, "pipeline"))
    const job = await storage.createJob()
    const ids = await uploadImages(storage, job.id)
    const voice = await uploadVoice(storage, job.id)
    const audio: AudioConfig = {
      mode: "voiceover",
      voiceoverAssetId: voice.id,
      musicAssetId: null,
      musicLevel: "low",
      voiceoverTiming: { trimStartMs: 3000, trimEndMs: 18_000, offsetMs: 2000 },
    }
    // First attempt: the mix fails once (simulated), leaving nothing behind.
    let failed = false
    const failingMix: Spawner = async (command, args, options) => {
      if (!failed && args.includes("[aout]")) {
        failed = true
        return {
          ok: false,
          reason: "failed",
          exitCode: 1,
          stderrTail: "simulated",
        }
      }
      return spawnTool(command, args, options)
    }
    const first = await renderJob(storage, job.id, ids, audio, failingMix)
    expect(first.done.state).toBe("failed")
    expect(await fs.readdir(await storage.workDir(job.id))).toEqual([])
    expect(await storage.resolveCompletedOutput(job.id)).toBeNull()

    // Retry: same uploads, same saved timing.
    await first.queue.retry(job.id)
    await first.queue.whenIdle()
    const done = await storage.readJob(job.id)
    expect(done.state).toBe("completed")
    expect(done.output?.audio).toMatchObject({
      codec: "aac",
      sampleRate: 48000,
      channels: 2,
    })
    expect((await storage.readProject(job.id)).audio?.voiceoverTiming).toEqual(
      audio.voiceoverTiming,
    )
    const file = (await storage.resolveCompletedOutput(job.id))!.path
    const x = pcm(file)
    const total = first.project.scenes.reduce((n, s) => n + s.durationFrames, 0)
    expectAacLength(x, videoSamples(total))
    const onset = firstAbove(x, peak(x) * 0.25)
    // AAC adds no offset FFmpeg doesn't compensate; allow a few samples.
    expect(Math.abs(onset - 2 * SR)).toBeLessThan((SR / 1000) * 5)
  })

  it("cancels while measuring the trimmed selection and while mixing: no output, no scratch files", async () => {
    for (const step of ["measuring", "mixing"]) {
      const storage = createVideoStorage(path.join(base, `cancel-${step}`))
      const job = await storage.createJob()
      const ids = await uploadImages(storage, job.id)
      const voice = await uploadVoice(storage, job.id)
      const project = buildTrustedProject(
        await storage.readJob(job.id),
        {
          product,
          assetIds: ids,
          effects: STATIC_EFFECTS,
          audio: {
            mode: "voiceover",
            voiceoverAssetId: voice.id,
            musicAssetId: null,
            musicLevel: "low",
            voiceoverTiming: {
              trimStartMs: 3000,
              trimEndMs: 18_000,
              offsetMs: 2000,
            },
          },
        },
        fonts,
      )
      if (!project.ok) throw new Error(JSON.stringify(project.issues))
      await storage.writeProject(job.id, project.value)
      let cancelled: Promise<unknown> | null = null
      // Hold the step's FFmpeg briefly so the cancel lands while it runs.
      const slow: Spawner = async (command, args, options) => {
        const isStep =
          step === "measuring"
            ? args.includes("-af") && args.join(" ").includes("loudnorm")
            : args.includes("[aout]")
        if (isStep && !cancelled) cancelled = queue.cancel(job.id)
        return spawnTool(command, args, options)
      }
      const queue = queueFor(storage, slow)
      await queue.enqueue(job.id)
      await queue.whenIdle()
      await cancelled
      expect((await storage.readJob(job.id)).state).toBe("cancelled")
      expect(await storage.resolveCompletedOutput(job.id)).toBeNull()
      expect(await fs.readdir(await storage.workDir(job.id))).toEqual([])
    }
  })
})
