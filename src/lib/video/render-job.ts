import type { RenderJobId } from "@/lib/video/ids"
import type { MediaAsset } from "@/lib/video/types"

/**
 * Render-job lifecycle, driven by the one-at-a-time render queue (DV-003B).
 *
 *   draft ──► queued ──► rendering ──► completed
 *     │          │  │        │
 *     │          │  └────────┴──► failed ──► queued (retry, DV-003D)
 *     └──────────┴───────────────► cancelled
 *
 * queued → failed covers a render that can't start (FFmpeg missing, no
 * working encoder) and jobs interrupted by a server restart.
 */
export const RENDER_JOB_STATES = [
  "draft",
  "queued",
  "rendering",
  "completed",
  "failed",
  "cancelled",
] as const

export type RenderJobState = (typeof RENDER_JOB_STATES)[number]

const TRANSITIONS: Record<RenderJobState, readonly RenderJobState[]> = {
  draft: ["queued", "cancelled"],
  queued: ["rendering", "failed", "cancelled"],
  rendering: ["completed", "failed", "cancelled"],
  failed: ["queued"],
  completed: [],
  cancelled: [],
}

export function isRenderJobState(value: unknown): value is RenderJobState {
  return (
    typeof value === "string" &&
    (RENDER_JOB_STATES as readonly string[]).includes(value)
  )
}

export function canTransition(from: RenderJobState, to: RenderJobState) {
  return TRANSITIONS[from].includes(to)
}

export function isTerminalState(state: RenderJobState) {
  return TRANSITIONS[state].length === 0
}

/** Error codes a job may end with; messages are written for people, not logs. */
export type RenderJobErrorCode =
  | "ffmpeg-unavailable"
  | "no-working-encoder"
  | "invalid-project"
  | "render-failed"
  | "timed-out"
  | "output-missing"
  | "verification-failed"
  | "interrupted"

export interface RenderJobError {
  code: RenderJobErrorCode
  message: string
}

/** Metadata stored as `job.json` in the job's private directory. */
export interface RenderJob {
  id: RenderJobId
  state: RenderJobState
  /** ISO-8601 timestamps. */
  createdAt: string
  updatedAt: string
  /** Images stored in the job's `assets/` directory, in upload order. */
  assets: MediaAsset[]
  error: RenderJobError | null
  /** Set once a render completes and FFprobe has verified it. Never a path. */
  output: RenderOutput | null
}

/** Verified facts about a finished video (from FFprobe, not from the encoder). */
export interface RenderOutput {
  fileName: "video.mp4"
  sizeBytes: number
  durationSeconds: number
  width: number
  height: number
  fps: number
  videoCodec: string
  pixelFormat: string
  /** The H.264 encoder that produced it, e.g. "libx264". */
  encoder: string
  /** Wall-clock render time, for the user and for performance notes. */
  renderSeconds: number
}

/** Progress reported while a job renders. Numbers come from FFmpeg itself. */
export type RenderProgress =
  | { phase: "waiting"; position: number }
  | { phase: "preparing" }
  | { phase: "composing"; completedScenes: number; totalScenes: number }
  | {
      phase: "encoding"
      /** FFmpeg's out_time over the storyboard's exact duration, 0–1. */
      fraction: number
      encodedSeconds: number
      totalSeconds: number
    }
  | { phase: "verifying" }
