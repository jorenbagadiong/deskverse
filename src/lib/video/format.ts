/**
 * The one supported output format for Pixel Studio (DV-003A).
 *
 * Fixed on purpose: clients never choose resolution, codec or FFmpeg flags.
 * The server will translate this constant into an FFmpeg command itself
 * (DV-003B), so the browser can only ask for "the standard vertical video".
 */
export const VIDEO_FORMAT = {
  width: 1080,
  height: 1920,
  aspectRatio: "9:16",
  fps: 30,
  container: "mp4",
  videoCodec: "h264",
  /** 4:2:0 chroma: the pixel format every phone and social platform decodes. */
  pixelFormat: "yuv420p",
  minDurationSeconds: 15,
  maxDurationSeconds: 30,
  /** Default: silent. Optional voiceover/music since DV-003C (AUDIO_OUTPUT). */
  audio: "none",
} as const

export type VideoFormat = typeof VIDEO_FORMAT

/**
 * The one audio output format (DV-003C), used whenever a video has audio:
 * AAC-LC, 48 kHz, stereo, 192 kb/s target, at most one audio stream.
 */
export const AUDIO_OUTPUT = {
  codec: "aac",
  profile: "LC",
  sampleRate: 48_000,
  channels: 2,
  bitrate: 192_000,
} as const

/** 48 000 Hz / 30 fps: audio samples per video frame (exact). */
export const SAMPLES_PER_FRAME = AUDIO_OUTPUT.sampleRate / VIDEO_FORMAT.fps

/** Per-scene bounds: long enough to read a caption, short enough to keep pace. */
export const SCENE_DURATION = {
  minSeconds: 2,
  maxSeconds: 8,
} as const

export const MIN_TOTAL_FRAMES =
  VIDEO_FORMAT.minDurationSeconds * VIDEO_FORMAT.fps
export const MAX_TOTAL_FRAMES =
  VIDEO_FORMAT.maxDurationSeconds * VIDEO_FORMAT.fps
export const MIN_SCENE_FRAMES = SCENE_DURATION.minSeconds * VIDEO_FORMAT.fps
export const MAX_SCENE_FRAMES = SCENE_DURATION.maxSeconds * VIDEO_FORMAT.fps

export function framesToSeconds(
  frames: number,
  fps: number = VIDEO_FORMAT.fps,
) {
  return frames / fps
}

export function secondsToFrames(
  seconds: number,
  fps: number = VIDEO_FORMAT.fps,
) {
  return Math.round(seconds * fps)
}

/** Greatest common divisor, for reducing width:height to a ratio. */
function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/** "1080x1920" → "9:16". */
export function aspectRatioOf(width: number, height: number) {
  const d = gcd(width, height)
  return `${width / d}:${height / d}`
}

/** "12.5 s" style label for durations in frames. */
export function formatDuration(frames: number, fps: number = VIDEO_FORMAT.fps) {
  const seconds = framesToSeconds(frames, fps)
  const rounded = Math.round(seconds * 10) / 10
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} s`
}
