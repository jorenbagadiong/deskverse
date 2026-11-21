import "server-only"

import {
  MIN_TOTAL_FRAMES,
  MAX_TOTAL_FRAMES,
  VIDEO_FORMAT,
} from "@/lib/video/format"
import type { ImageMimeType } from "@/lib/video/types"

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

/** Decodes the first frame and discards it: proves the image actually decodes. */
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
    "null",
    "-",
  ]
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
// Finished video
// ---------------------------------------------------------------------------

export function outputProbeArgs(filePath: string) {
  return [
    ...QUIET,
    "-protocol_whitelist",
    "file",
    "-show_entries",
    "format=format_name,duration,size:format_tags=major_brand:stream=index,codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_frames",
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
}

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
  if (audio.length > 0) problems.push("unexpected audio track")

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
    if (Math.abs(duration - expectedSeconds) > 0.1)
      problems.push(
        `duration ${duration.toFixed(2)} s doesn't match the storyboard's ${expectedSeconds.toFixed(2)} s`,
      )
  }
  const frames = v.nb_frames === undefined ? null : Number(v.nb_frames)
  if (frames !== null && frames !== expectedFrames)
    problems.push(`${frames} frames instead of ${expectedFrames}`)

  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    value: {
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
