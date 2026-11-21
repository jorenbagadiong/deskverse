import type { RenderJobId } from "@/lib/video/ids"
import type { MediaAsset } from "@/lib/video/types"

/**
 * Render-job lifecycle. Phase A only defines the states and the allowed moves;
 * the queue that drives them arrives in DV-003B.
 *
 *   draft ──► queued ──► rendering ──► completed
 *     │          │           │
 *     └──────────┴───────────┴──► cancelled
 *                            └──► failed ──► queued (retry)
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
  queued: ["rendering", "cancelled"],
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
  | "invalid-project"
  | "render-failed"
  | "timed-out"
  | "output-missing"

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
  /** Set once a render completes. Never an absolute path. */
  output: { fileName: "video.mp4"; sizeBytes: number } | null
}
