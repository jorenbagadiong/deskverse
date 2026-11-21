import type { ImageMimeType } from "@/lib/video/types"
import { MEDIA_LIMITS } from "@/lib/video/validation"
import type { Runner } from "@/server/process/run-executable"
import { orientedDimensions, readJpegOrientation } from "@/server/video/exif"
import {
  checkImageDecode,
  imageDecodeArgs,
  imageProbeArgs,
  parseImageProbe,
} from "@/server/video/ffprobe"
import { readImageDimensions, sniffImageType } from "@/server/video/image-sniff"

/**
 * Checks for Affiliate Ticket uploads (DV-004B). A file is accepted only if
 * its bytes are a supported type, its header is sane, and FFprobe/FFmpeg
 * agree that it is intact. Images reuse Pixel Studio's exact checks;
 * videos are MP4 only, stored as reference material (Pixel can't render
 * from clips yet).
 */

export class MediaRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MediaRejected"
  }
}

export interface MediaTools {
  run: Runner
  ffmpeg: string
  ffprobe: string
}

export interface VideoLimits {
  maxSeconds: number
  maxSide: number
  minSide: number
}

export type DetectedType = ImageMimeType | "video/mp4"

/** ISO base media brands accepted as MP4 (QuickTime "qt  " is not). */
const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "dash",
  "MSNV",
  "M4V ",
])

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.subarray(start, end))
}

/** Identifies a file by its first bytes. Never by its name or claimed type. */
export function sniffTicketMedia(head: Uint8Array): DetectedType | null {
  const image = sniffImageType(head)
  if (image) return image
  if (head.length >= 12 && ascii(head, 4, 8) === "ftyp") {
    const brand = ascii(head, 8, 12)
    if (MP4_BRANDS.has(brand)) return "video/mp4"
  }
  return null
}

export const EXTENSION: Record<DetectedType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
}

export interface VerifiedImage {
  kind: "image"
  width: number
  height: number
}

export interface VerifiedVideo {
  kind: "video"
  width: number
  height: number
  durationMs: number
}

/** `head` must hold enough of the file for the header (the first 256 KiB). */
export async function verifyImage(
  file: string,
  type: ImageMimeType,
  head: Uint8Array,
  tools: MediaTools,
): Promise<VerifiedImage> {
  const stored = readImageDimensions(head, type)
  if (!stored)
    throw new MediaRejected(
      "The image header is damaged or incomplete, so its size can't be read.",
    )
  const { minSide, maxSide, maxPixels } = MEDIA_LIMITS
  if (Math.min(stored.width, stored.height) < minSide)
    throw new MediaRejected(
      `The image is too small (${stored.width}×${stored.height}). Use at least ${minSide} pixels on the shorter side.`,
    )
  if (
    Math.max(stored.width, stored.height) > maxSide ||
    stored.width * stored.height > maxPixels
  )
    throw new MediaRejected(
      `The image is too large (${stored.width}×${stored.height}). Use at most ${maxSide} pixels per side.`,
    )
  const probe = await tools.run(tools.ffprobe, imageProbeArgs(file))
  if (!probe.ok) throw new MediaRejected("FFprobe couldn't read the image.")
  const parsed = parseImageProbe(probe.stdout, { mimeType: type, ...stored })
  if (!parsed.ok) throw new MediaRejected(parsed.reason)
  const decoded = checkImageDecode(
    await tools.run(tools.ffmpeg, imageDecodeArgs(file)),
  )
  if (!decoded.ok)
    throw new MediaRejected(`The image ${decoded.reason.replace(/^it /, "")}`)
  // Stored upright, as a viewer shows it.
  const upright =
    type === "image/jpeg"
      ? orientedDimensions(stored, readJpegOrientation(head))
      : stored
  return { kind: "image", ...upright }
}

const QUIET = ["-v", "error", "-hide_banner"]

export function videoProbeArgs(file: string) {
  return [
    ...QUIET,
    "-protocol_whitelist",
    "file",
    "-f",
    "mp4",
    "-show_entries",
    "stream=codec_type,codec_name,width,height,disposition:format=format_name,duration",
    "-of",
    "json",
    `file:${file}`,
  ]
}

/** Reads every packet of the first video stream without decoding (catches truncation). */
export function videoPacketCheckArgs(file: string) {
  return [
    "-nostdin",
    ...QUIET,
    "-protocol_whitelist",
    "file",
    "-xerror",
    "-f",
    "mp4",
    "-i",
    `file:${file}`,
    "-map",
    "0:v:0",
    "-c",
    "copy",
    "-f",
    "null",
    "-",
  ]
}

/** Decodes the first video frame. */
export function videoDecodeArgs(file: string) {
  return [
    "-nostdin",
    ...QUIET,
    "-protocol_whitelist",
    "file",
    "-xerror",
    "-f",
    "mp4",
    "-i",
    `file:${file}`,
    "-map",
    "0:v:0",
    "-frames:v",
    "1",
    "-f",
    "framecrc",
    "-",
  ]
}

const VIDEO_CODECS = new Set(["h264", "hevc", "av1", "vp9", "mpeg4"])

export function parseVideoProbe(
  stdout: string,
  limits: VideoLimits,
): VerifiedVideo {
  let json: {
    streams?: {
      codec_type?: string
      codec_name?: string
      width?: number
      height?: number
      disposition?: { attached_pic?: number }
    }[]
    format?: { format_name?: string; duration?: string }
  }
  try {
    json = JSON.parse(stdout)
  } catch {
    throw new MediaRejected("FFprobe couldn't read the video.")
  }
  if (!json.format?.format_name?.split(",").includes("mp4"))
    throw new MediaRejected("The file isn't an MP4 video.")
  const videos = (json.streams ?? []).filter(
    (s) => s.codec_type === "video" && !s.disposition?.attached_pic,
  )
  if (videos.length === 0)
    throw new MediaRejected("The MP4 file contains no video picture.")
  const video = videos[0]
  if (!VIDEO_CODECS.has(video.codec_name ?? ""))
    throw new MediaRejected(
      "The video uses an unsupported codec. Export it as H.264 MP4.",
    )
  const width = video.width ?? 0
  const height = video.height ?? 0
  if (Math.min(width, height) < limits.minSide)
    throw new MediaRejected(
      `The video is too small (${width}×${height}). Use at least ${limits.minSide} pixels on the shorter side.`,
    )
  if (Math.max(width, height) > limits.maxSide)
    throw new MediaRejected(
      `The video is too large (${width}×${height}). Use at most ${limits.maxSide} pixels per side.`,
    )
  const duration = Number(json.format.duration)
  if (!Number.isFinite(duration) || duration <= 0)
    throw new MediaRejected("The video's length can't be read.")
  if (duration > limits.maxSeconds)
    throw new MediaRejected(
      `The video is ${Math.round(duration)} s long. Clips can be at most ${limits.maxSeconds} s.`,
    )
  return {
    kind: "video",
    width,
    height,
    durationMs: Math.max(1, Math.round(duration * 1000)),
  }
}

export async function verifyVideo(
  file: string,
  limits: VideoLimits,
  tools: MediaTools,
): Promise<VerifiedVideo> {
  const probe = await tools.run(tools.ffprobe, videoProbeArgs(file))
  if (!probe.ok)
    throw new MediaRejected(
      "FFprobe couldn't read the video (it may be damaged or not really an MP4).",
    )
  const video = parseVideoProbe(probe.stdout, limits)
  const packets = await tools.run(tools.ffmpeg, videoPacketCheckArgs(file))
  if (!packets.ok || packets.stderr.trim() !== "")
    throw new MediaRejected(
      "The video is damaged or cut off (FFmpeg couldn't read all of it).",
    )
  const decoded = await tools.run(tools.ffmpeg, videoDecodeArgs(file))
  const frames = decoded.ok
    ? decoded.stdout.split("\n").filter((l) => l.trim() && !l.startsWith("#"))
    : []
  if (!decoded.ok || frames.length !== 1 || decoded.stderr.trim() !== "")
    throw new MediaRejected("The video's first frame doesn't decode cleanly.")
  return video
}
