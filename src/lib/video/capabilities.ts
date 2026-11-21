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
  /** Required for its purpose: video filters gate all rendering, audio filters only audio. */
  required: boolean
  purpose: "video" | "audio"
}

export interface EncoderInfo {
  name: string
  hardware: boolean
  /**
   * Result of a real test encode (1080×1920, yuv420p). Listed encoders aren't
   * trusted: true = encoded, false = failed, null = not tested because a
   * preferred encoder already worked.
   */
  works: boolean | null
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
  | "no-working-encoder"
  | "no-libx264"
  | "hardware-encoder-only"
  | "no-aac-encoder"
  | "audio-unavailable"
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
 * - unsupported: installed, but lacks a required filter or a working H.264 encoder
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
  /**
   * The encoder renders use: the first, by preference (libx264, libopenh264,
   * other software, hardware), that passed a real test encode.
   */
  selectedH264Encoder: string | null
  /** The AAC encoder that passed a real test encode (native "aac" preferred). */
  aacEncoder: string | null
  /**
   * Whether voiceover/music can be rendered. Never affects silent rendering:
   * `status` can be "ready" while audio isn't.
   */
  audio: {
    ready: boolean
    missingFilters: string[]
    /** Why audio is unavailable, in plain language; null when ready. */
    reason: string | null
  }
  license: FfmpegLicense
  issues: CapabilityIssue[]
}

/** Filters the DV-003B renderer uses (see src/server/video/ffmpeg-command.ts). */
export const REQUIRED_FILTERS = [
  "color",
  "split",
  "scale",
  "crop",
  "gblur",
  "colorchannelmixer",
  "overlay",
  "drawtext",
  "format",
  "loop",
  "settb",
  "setpts",
  "setsar",
  "concat",
  "fade",
] as const

/** Filters the DV-003C audio stage uses (see src/server/video/audio-command.ts). */
export const AUDIO_FILTERS = [
  "aresample",
  "aformat",
  "atrim",
  "asetpts",
  "apad",
  "loudnorm",
  "aloop",
  "afade",
  "asplit",
  "sidechaincompress",
  "amix",
  "alimiter",
] as const

/** Not used yet: crossfades between scenes are planned for DV-003D. */
export const OPTIONAL_FILTERS = ["xfade"] as const

export const CAPABILITIES_ENDPOINT = "/api/studio/pixel/capabilities"
