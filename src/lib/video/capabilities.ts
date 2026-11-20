/**
 * The FFmpeg capability report the server sends to the browser.
 *
 * Deliberately contains no absolute paths, environment variables, build
 * configuration strings or raw process output: only booleans, sanitized
 * version strings, encoder/filter names and human-readable issues.
 */

export type ExecutableProblem =
  /** Not on PATH (or the configured path doesn't exist). */
  | "not-found"
  /** Found but the OS refused to run it. */
  | "not-executable"
  /** Didn't answer within the time limit. */
  | "timed-out"
  /** Ran but exited with an error. */
  | "failed"
  /** Ran but printed something we couldn't recognise as FFmpeg. */
  | "unrecognized-output"
  /** DESKVERSE_FFMPEG_PATH / DESKVERSE_FFPROBE_PATH is set to something unsafe. */
  | "invalid-configuration"

export interface ExecutableStatus {
  available: boolean
  /** e.g. "6.1.1-3ubuntu5", or null when unknown. */
  version: string | null
  problem: ExecutableProblem | null
}

export interface FilterStatus {
  name: string
  available: boolean
  required: boolean
}

export interface EncoderInfo {
  name: string
  /** Hardware encoders are compiled in but only proven to work by a test render (DV-003B). */
  hardware: boolean
}

/** From the build's ./configure flags. Paths in those flags are never sent. */
export type FfmpegLicense = "lgpl" | "gpl" | "nonfree" | "unknown"

export type CapabilityIssueCode =
  | "ffmpeg-missing"
  | "ffprobe-missing"
  | "ffmpeg-unusable"
  | "ffprobe-unusable"
  | "invalid-configuration"
  | "missing-filters"
  | "no-h264-encoder"
  | "no-libx264"
  | "hardware-encoder-only"
  | "no-aac-encoder"
  | "old-version"
  | "nonfree-build"

export interface CapabilityIssue {
  code: CapabilityIssueCode
  severity: "error" | "warning"
  message: string
}

/**
 * - ready:       everything Phase B needs is present (warnings may still apply)
 * - missing:     FFmpeg or FFprobe isn't installed / can't be found
 * - unsupported: installed, but lacks a required filter or any H.264 encoder
 */
export type CapabilityStatus = "ready" | "missing" | "unsupported"

export interface FfmpegCapabilityReport {
  status: CapabilityStatus
  /** ISO-8601. */
  checkedAt: string
  ffmpeg: ExecutableStatus
  ffprobe: ExecutableStatus
  filters: FilterStatus[]
  h264Encoders: EncoderInfo[]
  /** The encoder DV-003B will use, by preference: libx264, libopenh264, then hardware. */
  selectedH264Encoder: string | null
  /** Informational until audio arrives in DV-003C. */
  aacEncoder: string | null
  license: FfmpegLicense
  issues: CapabilityIssue[]
}

/** Filters the planned Phase B pipeline depends on. */
export const REQUIRED_FILTERS = [
  "scale",
  "crop",
  "pad",
  "setsar",
  "fps",
  "format",
  "overlay",
  "drawtext",
  "zoompan",
  "fade",
  "concat",
] as const

/** Nice to have: smoother transitions. Rendering falls back to cuts without it. */
export const OPTIONAL_FILTERS = ["xfade"] as const

export const CAPABILITIES_ENDPOINT = "/api/studio/pixel/capabilities"
