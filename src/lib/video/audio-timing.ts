import {
  AUDIO_OUTPUT,
  SAMPLES_PER_FRAME,
  VIDEO_FORMAT,
} from "@/lib/video/format"
import type { VoiceoverTiming } from "@/lib/video/types"

/**
 * Voiceover timing math (DV-003D3), shared by the studio (live preview) and
 * the server (the authority). Pure: no I/O.
 *
 * Rounding rules, chosen so every boundary is an exact audio sample:
 * - Settings are whole milliseconds. The studio rounds what you type to the
 *   nearest millisecond; the server accepts integers only.
 * - At 48 kHz one millisecond is exactly 48 samples, so a millisecond value
 *   converts to samples without rounding.
 * - A 30 fps frame is exactly 1600 samples (33⅓ ms), so video lengths are
 *   counted in samples, never rounded to milliseconds.
 * - A recording's usable length is its FFprobe duration rounded *down* to a
 *   whole millisecond, so a selection never reaches past the real audio.
 */

export const SAMPLES_PER_MS = AUDIO_OUTPUT.sampleRate / 1000

/** The shortest selection worth narrating. */
export const MIN_NARRATION_MS = 500

/** A recording's usable length in whole milliseconds (rounded down). */
export function recordingMs(durationSeconds: number) {
  // The epsilon absorbs float noise only (1.005 × 1000 is 1004.9999999999999).
  return Math.floor(durationSeconds * 1000 + 1e-6)
}

export const videoSamples = (frames: number) => frames * SAMPLES_PER_FRAME

/** Where the narration sits, in exact samples, plus seconds for display. */
export interface NarrationWindow {
  /** Selection in the recording. */
  trimStartSample: number
  trimEndSample: number
  /** Where it starts and ends in the video. */
  startSample: number
  endSample: number
  lengthSamples: number
  /** No timing saved (a project from before DV-003D3): whole recording from 0:00. */
  legacy: boolean
}

/**
 * Resolves saved timing against the recording's real duration. Without
 * timing (older projects) the whole recording plays from 0:00, cut at the
 * end of the video exactly as before DV-003D3 (validation only allows a
 * short tolerance there). Doesn't validate: see validateVoiceoverTiming.
 */
export function narrationWindow(
  timing: VoiceoverTiming | undefined,
  recordingSeconds: number,
  videoFrames: number,
): NarrationWindow {
  const recordingSamples = recordingMs(recordingSeconds) * SAMPLES_PER_MS
  if (!timing) {
    const end = Math.min(recordingSamples, videoSamples(videoFrames))
    return {
      trimStartSample: 0,
      trimEndSample: end,
      startSample: 0,
      endSample: end,
      lengthSamples: end,
      legacy: true,
    }
  }
  const trimStartSample = timing.trimStartMs * SAMPLES_PER_MS
  const trimEndSample =
    timing.trimEndMs === null
      ? recordingSamples
      : timing.trimEndMs * SAMPLES_PER_MS
  const lengthSamples = trimEndSample - trimStartSample
  const startSample = timing.offsetMs * SAMPLES_PER_MS
  return {
    trimStartSample,
    trimEndSample,
    startSample,
    endSample: startSample + lengthSamples,
    lengthSamples,
    legacy: false,
  }
}

export const samplesToSeconds = (samples: number) =>
  samples / AUDIO_OUTPUT.sampleRate

/** "12.35 s" with up to two decimals, for messages and labels. */
export function formatTime(seconds: number) {
  return `${Number(seconds.toFixed(2))} s`
}

/** The video's length in milliseconds (may be fractional: 1 frame = 33⅓ ms). */
export const videoMs = (frames: number) => (frames * 1000) / VIDEO_FORMAT.fps
