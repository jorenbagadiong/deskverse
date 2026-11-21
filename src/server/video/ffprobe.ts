import "server-only"

import {
  AUDIO_OUTPUT,
  MAX_TOTAL_FRAMES,
  MIN_TOTAL_FRAMES,
  VIDEO_FORMAT,
} from "@/lib/video/format"
import type { AudioContainer, ImageMimeType } from "@/lib/video/types"

/**
 * FFprobe/FFmpeg checks, split into argument builders (fixed arrays) and pure
 * parsers (unit-tested against captured JSON). Used to re-verify uploads and
 * to verify every finished video before a job may complete.
 */

const QUIET = ["-v", "error", "-hide_banner"] as const

// ---------------------------------------------------------------------------
// Uploaded images
// ---------------------------------------------------------------------------

export function imageProbeArgs(filePath: string) {
  return [
    ...QUIET,
    "-protocol_whitelist",
    "file",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,width,height:format=format_name",
    "-of",
    "json",
    `file:${filePath}`,
  ]
}

/**
 * Decodes the first frame and prints one checksum line for it (`framecrc`):
 * proves the image actually decodes to a picture, not just that FFmpeg exited.
 */
export function imageDecodeArgs(filePath: string) {
  return [
    "-nostdin",
    ...QUIET,
    "-protocol_whitelist",
    "file",
    "-xerror",
    "-i",
    `file:${filePath}`,
    "-frames:v",
    "1",
    "-f",
    "framecrc",
    "-",
  ]
}

/**
 * Diagnostics FFmpeg logs at error level that are known to concern metadata
 * only, never the picture. Each entry must match a whole stderr line, and is
 * accepted only when the decode also exited cleanly with exactly one frame.
 *
 * - WebP: many encoders write the EXIF chunk with an "Exif\0\0" prefix (the
 *   JPEG APP1 convention) instead of raw TIFF. FFmpeg 6.1's WebP decoder
 *   then logs "invalid TIFF header in Exif data", skips the metadata and
 *   decodes the image normally: pixel-identical to the same file without
 *   the chunk (verified with frame checksums).
 */
const METADATA_ONLY_DIAGNOSTICS: readonly RegExp[] = [
  /^\[webp @ 0x[0-9a-f]+\] invalid TIFF header in Exif data$/,
]

export type ImageDecodeCheck = ProbeCheck<{ ignoredDiagnostics: string[] }>

/**
 * Judges a test decode (see imageDecodeArgs). Rejects a failed exit, anything
 * but exactly one decoded frame, and any stderr line that isn't a known
 * metadata-only diagnostic. Real decoding errors are never ignored.
 */
export function checkImageDecode(
  result: { ok: true; stdout: string; stderr: string } | { ok: false },
): ImageDecodeCheck {
  if (!result.ok)
    return {
      ok: false,
      reason:
        "FFmpeg stopped with a decoding error (the file may be damaged or cut off).",
    }
  const frames = result.stdout
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
  if (frames.length !== 1)
    return { ok: false, reason: "FFmpeg couldn't decode a picture from it." }
  const lines = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const unexpected = lines.filter(
    (line) => !METADATA_ONLY_DIAGNOSTICS.some((pattern) => pattern.test(line)),
  )
  if (unexpected.length > 0)
    return {
      ok: false,
      reason: "it doesn't decode cleanly (the file may be damaged).",
    }
  return { ok: true, value: { ignoredDiagnostics: lines } }
}

/** FFmpeg's decoder name for each accepted type. */
const DECODER_FOR: Record<ImageMimeType, string> = {
  "image/jpeg": "mjpeg",
  "image/png": "png",
  "image/webp": "webp",
}

export type ProbeCheck<T> =
  { ok: true; value: T } | { ok: false; reason: string }

export function parseImageProbe(
  stdout: string,
  expected: { mimeType: ImageMimeType; width: number; height: number },
): ProbeCheck<{ width: number; height: number }> {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return { ok: false, reason: "FFprobe couldn't read the image." }
  }
  const stream = (json as { streams?: Record<string, unknown>[] }).streams?.[0]
  if (!stream) return { ok: false, reason: "The file contains no image." }
  if (stream.codec_name !== DECODER_FOR[expected.mimeType])
    return {
      ok: false,
      reason: "The file's contents don't match its image type.",
    }
  if (stream.width !== expected.width || stream.height !== expected.height)
    return {
      ok: false,
      reason: "The image's dimensions don't match its header.",
    }
  return { ok: true, value: { width: expected.width, height: expected.height } }
}

// ---------------------------------------------------------------------------
// Uploaded audio (DV-003C)
// ---------------------------------------------------------------------------

/** The demuxer each sniffed container must open with (no format guessing). */
export const AUDIO_DEMUXER: Record<AudioContainer, string> = {
  mp3: "mp3",
  wav: "wav",
  m4a: "mov",
}

/** Decoders accepted per container (FFprobe codec names). */
const AUDIO_CODECS: Record<AudioContainer, readonly string[]> = {
  mp3: ["mp3"],
  wav: ["pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_u8"],
  m4a: ["aac", "alac"],
}

/** Picture codecs accepted as MP3 cover art (ID3 attached pictures). */
const COVER_ART_CODECS: readonly string[] = ["mjpeg", "png"]

export function audioProbeArgs(filePath: string, container: AudioContainer) {
  return [
    ...QUIET,
    "-protocol_whitelist",
    "file",
    "-f",
    AUDIO_DEMUXER[container],
    "-show_entries",
    "stream=index,codec_type,codec_name,sample_rate,channels,duration:stream_disposition=attached_pic:format=format_name,duration",
    "-of",
    "json",
    `file:${filePath}`,
  ]
}

/** Decodes the whole audio stream and discards it: proves it decodes. */
export function audioDecodeArgs(filePath: string, container: AudioContainer) {
  return [
    "-nostdin",
    ...QUIET,
    "-protocol_whitelist",
    "file",
    "-xerror",
    "-f",
    AUDIO_DEMUXER[container],
    "-i",
    `file:${filePath}`,
    "-map",
    "0:a:0",
    "-f",
    "null",
    "-",
  ]
}

export interface ProbedAudio {
  codec: string
  durationSeconds: number
  sampleRate: number
  channels: number
}

/**
 * Checks an uploaded audio file's probe: the right container, exactly one
 * audio stream with an accepted codec, and nothing else (no video,
 * subtitles, data or attachments) apart from one ordinary cover picture in
 * an MP3.
 */
export function parseAudioProbe(
  stdout: string,
  container: AudioContainer,
): ProbeCheck<ProbedAudio> {
  let json: {
    streams?: (Record<string, unknown> & {
      disposition?: Record<string, unknown>
    })[]
    format?: Record<string, unknown>
  }
  try {
    json = JSON.parse(stdout)
  } catch {
    return { ok: false, reason: "FFprobe couldn't read it." }
  }
  const streams = json.streams ?? []
  const formatNames = String(json.format?.format_name ?? "").split(",")
  if (!formatNames.includes(AUDIO_DEMUXER[container]))
    return {
      ok: false,
      reason: "its contents don't match an MP3, WAV or M4A file.",
    }
  const pictures = streams.filter((s) => s.codec_type === "video")
  const coverArt = pictures.filter((s) => s.disposition?.attached_pic === 1)
  if (pictures.length > coverArt.length)
    return {
      ok: false,
      reason: "it contains video. Upload an audio-only file.",
    }
  // DV-003D3: an MP3 may carry one ordinary cover picture (ID3 APIC, JPEG
  // or PNG). It's ignored: only the audio stream is ever decoded or mixed,
  // and the finished MP4 must have exactly one video and one audio stream.
  if (coverArt.length > 0) {
    if (container !== "mp3")
      return {
        ok: false,
        reason:
          "it contains embedded cover art. Export the audio without artwork and try again.",
      }
    if (coverArt.length > 1)
      return {
        ok: false,
        reason:
          "it contains more than one embedded picture. Keep at most one cover image.",
      }
    if (!COVER_ART_CODECS.includes(String(coverArt[0].codec_name)))
      return {
        ok: false,
        reason: `its cover art (${String(coverArt[0].codec_name)}) isn't an ordinary JPEG or PNG picture.`,
      }
  }
  const others = streams.filter(
    (s) => s.codec_type !== "audio" && s.codec_type !== "video",
  )
  if (others.length > 0)
    return {
      ok: false,
      reason: `it contains an extra ${String(others[0].codec_type)} stream. Upload a plain audio file.`,
    }
  const audio = streams.filter((s) => s.codec_type === "audio")
  if (audio.length === 0) return { ok: false, reason: "it has no audio." }
  if (audio.length > 1)
    return { ok: false, reason: "it has more than one audio track." }
  const a = audio[0]
  const codec = String(a.codec_name)
  if (!AUDIO_CODECS[container].includes(codec))
    return {
      ok: false,
      reason: `its audio codec (${codec}) isn't supported in this format.`,
    }
  const durationSeconds = Number(a.duration ?? json.format?.duration)
  const sampleRate = Number(a.sample_rate)
  const channels = Number(a.channels)
  if (
    !Number.isFinite(durationSeconds) ||
    !Number.isFinite(sampleRate) ||
    !Number.isInteger(channels)
  )
    return { ok: false, reason: "its duration or format couldn't be read." }
  return { ok: true, value: { codec, durationSeconds, sampleRate, channels } }
}

/** Decodes the finished video's audio track fully (playback check). */
export function outputAudioDecodeArgs(filePath: string) {
  return [
    "-nostdin",
    ...QUIET,
    "-protocol_whitelist",
    "file",
    "-xerror",
    "-i",
    `file:${filePath}`,
    "-map",
    "0:a:0",
    "-f",
    "null",
    "-",
  ]
}

// ---------------------------------------------------------------------------
// Finished video
// ---------------------------------------------------------------------------

export function outputProbeArgs(filePath: string) {
  return [
    ...QUIET,
    "-protocol_whitelist",
    "file",
    "-show_entries",
    "format=format_name,duration,size:format_tags=major_brand:stream=index,codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_frames,sample_rate,channels,duration,bit_rate",
    "-of",
    "json",
    `file:${filePath}`,
  ]
}

export interface VerifiedOutput {
  durationSeconds: number
  sizeBytes: number
  width: number
  height: number
  fps: number
  videoCodec: string
  pixelFormat: string
  frames: number | null
  /** The verified AAC stream, or null for a silent video. */
  audio: {
    codec: "aac"
    profile: string
    sampleRate: number
    channels: number
    bitRate: number | null
    durationSeconds: number
  } | null
}

/** Video and audio stream lengths may differ from the storyboard by this much. */
export const DURATION_TOLERANCE_SECONDS = 0.1

/** ISO base media brands written by FFmpeg's mp4 muxer (not QuickTime "qt  "). */
const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
])

function rate(value: unknown) {
  if (typeof value !== "string") return null
  const [num, den] = value.split("/").map(Number)
  return den ? num / den : null
}

/**
 * Checks a finished render against the fixed format. Every problem is
 * collected so a failure explains itself; the job only completes when the
 * list is empty.
 */
export function verifyOutputProbe(
  stdout: string,
  expectedFrames: number,
  { expectAudio = false }: { expectAudio?: boolean } = {},
): { ok: true; value: VerifiedOutput } | { ok: false; problems: string[] } {
  let json: {
    format?: Record<string, unknown> & { tags?: Record<string, unknown> }
    streams?: Record<string, unknown>[]
  }
  try {
    json = JSON.parse(stdout)
  } catch {
    return { ok: false, problems: ["FFprobe output was not readable."] }
  }
  const problems: string[] = []
  const format = json.format ?? {}
  const streams = json.streams ?? []
  const video = streams.filter((s) => s.codec_type === "video")
  const audio = streams.filter((s) => s.codec_type === "audio")

  if (
    !String(format.format_name ?? "")
      .split(",")
      .includes("mp4")
  )
    problems.push("not an MP4 container")
  const brand = String(format.tags?.major_brand ?? "").trim()
  if (!MP4_BRANDS.has(brand)) problems.push(`unexpected MP4 brand "${brand}"`)
  const sizeBytes = Number(format.size)
  if (!(sizeBytes > 0)) problems.push("the file is empty")
  if (video.length !== 1)
    problems.push(`expected 1 video stream, found ${video.length}`)
  if (!expectAudio && audio.length > 0) problems.push("unexpected audio track")
  if (expectAudio && audio.length !== 1)
    problems.push(`expected 1 audio stream, found ${audio.length}`)
  const others = streams.filter(
    (s) => s.codec_type !== "video" && s.codec_type !== "audio",
  )
  if (others.length > 0)
    problems.push(`unexpected ${String(others[0].codec_type)} stream`)

  const v = video[0] ?? {}
  if (v.codec_name !== VIDEO_FORMAT.videoCodec)
    problems.push(`codec is ${String(v.codec_name)}, not H.264`)
  if (v.width !== VIDEO_FORMAT.width || v.height !== VIDEO_FORMAT.height)
    problems.push(
      `size is ${String(v.width)}×${String(v.height)}, not 1080×1920`,
    )
  if (v.pix_fmt !== VIDEO_FORMAT.pixelFormat)
    problems.push(`pixel format is ${String(v.pix_fmt)}, not yuv420p`)
  const fps = rate(v.avg_frame_rate)
  if (
    fps === null ||
    Math.abs(fps - VIDEO_FORMAT.fps) > 0.01 ||
    rate(v.r_frame_rate) !== VIDEO_FORMAT.fps
  )
    problems.push(`frame rate is ${String(v.avg_frame_rate)}, not 30 fps`)

  const duration = Number(format.duration)
  const expectedSeconds = expectedFrames / VIDEO_FORMAT.fps
  if (!Number.isFinite(duration)) problems.push("duration is unknown")
  else {
    if (
      duration < MIN_TOTAL_FRAMES / VIDEO_FORMAT.fps - 0.05 ||
      duration > MAX_TOTAL_FRAMES / VIDEO_FORMAT.fps + 0.05
    )
      problems.push(`duration ${duration.toFixed(2)} s is outside 15–30 s`)
    if (Math.abs(duration - expectedSeconds) > DURATION_TOLERANCE_SECONDS)
      problems.push(
        `duration ${duration.toFixed(2)} s doesn't match the storyboard's ${expectedSeconds.toFixed(2)} s`,
      )
  }
  const frames = v.nb_frames === undefined ? null : Number(v.nb_frames)
  if (frames !== null && frames !== expectedFrames)
    problems.push(`${frames} frames instead of ${expectedFrames}`)

  let verifiedAudio: VerifiedOutput["audio"] = null
  if (expectAudio && audio.length === 1) {
    const a = audio[0]
    if (a.codec_name !== AUDIO_OUTPUT.codec)
      problems.push(`audio codec is ${String(a.codec_name)}, not AAC`)
    if (a.profile !== AUDIO_OUTPUT.profile)
      problems.push(`AAC profile is ${String(a.profile)}, not LC`)
    if (Number(a.sample_rate) !== AUDIO_OUTPUT.sampleRate)
      problems.push(
        `audio sample rate is ${String(a.sample_rate)} Hz, not 48000`,
      )
    if (a.channels !== AUDIO_OUTPUT.channels)
      problems.push(`audio has ${String(a.channels)} channels, not stereo`)
    const audioSeconds = Number(a.duration)
    if (
      !Number.isFinite(audioSeconds) ||
      Math.abs(audioSeconds - expectedSeconds) > DURATION_TOLERANCE_SECONDS
    )
      problems.push(
        `audio lasts ${Number.isFinite(audioSeconds) ? audioSeconds.toFixed(2) : "?"} s, not the video's ${expectedSeconds.toFixed(2)} s`,
      )
    const bitRate = Number(a.bit_rate)
    verifiedAudio = {
      codec: "aac",
      profile: String(a.profile),
      sampleRate: AUDIO_OUTPUT.sampleRate,
      channels: AUDIO_OUTPUT.channels,
      bitRate: Number.isFinite(bitRate) && bitRate > 0 ? bitRate : null,
      durationSeconds: Math.round(audioSeconds * 1000) / 1000,
    }
  }

  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    value: {
      audio: verifiedAudio,
      durationSeconds: Math.round(duration * 1000) / 1000,
      sizeBytes,
      width: VIDEO_FORMAT.width,
      height: VIDEO_FORMAT.height,
      fps: VIDEO_FORMAT.fps,
      videoCodec: VIDEO_FORMAT.videoCodec,
      pixelFormat: VIDEO_FORMAT.pixelFormat,
      frames,
    },
  }
}

// ---------------------------------------------------------------------------
// Encoding progress (-progress pipe:1)
// ---------------------------------------------------------------------------

/**
 * Parses FFmpeg's `-progress` key=value stream. Calls `onProgress` with the
 * encoded time each time FFmpeg finishes a progress block. `out_time_us`
 * (and the misnamed `out_time_ms`, also microseconds) are used; nothing is
 * estimated.
 */
export function createProgressParser(
  onProgress: (update: { encodedSeconds: number; done: boolean }) => void,
) {
  let buffer = ""
  let outTimeUs: number | null = null
  return (chunk: string) => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const raw of lines) {
      const line = raw.trim()
      const eq = line.indexOf("=")
      if (eq <= 0) continue
      const key = line.slice(0, eq)
      const value = line.slice(eq + 1)
      if (key === "out_time_us" || key === "out_time_ms") {
        const n = Number(value)
        if (Number.isFinite(n) && n >= 0) outTimeUs = n
      } else if (key === "progress" && outTimeUs !== null) {
        onProgress({
          encodedSeconds: outTimeUs / 1_000_000,
          done: value === "end",
        })
      }
    }
  }
}
