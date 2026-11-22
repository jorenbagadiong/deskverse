import "server-only"

import os from "node:os"
import path from "node:path"

import type {
  RenderJob,
  RenderOutput,
  RenderProgress,
} from "@/lib/video/render-job"
import { stopOrphanedRenders } from "@/server/process/orphans"
import { createRunner, spawnTool } from "@/server/process/run-executable"
import {
  GateCancelled,
  RenderGate,
  type RenderLease,
} from "@/server/video/render-gate"
import {
  getFfmpegCapabilities,
  resolveExecutable,
} from "@/server/video/ffmpeg-capabilities"
import { fontDirectory, loadVideoFont } from "@/server/video/font-metrics"
import {
  RenderCancelled,
  RenderFailure,
  renderVideo,
} from "@/server/video/render-service"
import {
  createVideoStorage,
  resolveDataRoot,
  StorageError,
  type VideoStorage,
} from "@/server/video/storage"

/**
 * A bounded, in-process render queue: one FFmpeg render at a time, at most
 * MAX_WAITING jobs waiting, no duplicates. The browser gets a job ID and polls
 * status; no HTTP request is held open while rendering.
 *
 * Restarts: progress lives in memory, state lives in job.json. On startup,
 * orphaned FFmpeg processes of a previous server are stopped, and any job
 * still "queued" or "rendering" is marked failed ("interrupted"), so nothing
 * half-rendered is reported as complete; the user can retry it.
 *
 * Cancellation (DV-003D1) aborts the active render's FFmpeg processes and
 * awaits their exit; the queue alone decides the final state, so completion,
 * cancellation and failure are mutually exclusive.
 */

export const MAX_WAITING = 3

export type QueueErrorCode =
  | "busy"
  | "duplicate"
  | "not-cancellable"
  | "not-retryable"
  | "files-missing"
  | "active"

export class QueueError extends Error {
  constructor(
    readonly code: QueueErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export type RenderFn = (
  jobId: string,
  onProgress: (progress: RenderProgress) => void,
  /** Aborted when the user cancels; the render must stop its processes. */
  signal: AbortSignal,
  /** The render gate lease (DV-005C), when the queue has a gate. */
  lease?: RenderLease,
) => Promise<RenderOutput>

/** The installation-wide render gate, as the queue uses it (DV-005C). */
export interface QueueGate {
  acquire(
    owner: { kind: "studio"; jobId: string; storageRoot: string },
    signal: AbortSignal,
  ): Promise<RenderLease>
}

interface ActiveRender {
  id: string
  controller: AbortController
  /** Settles once the job's final state (completed/failed/cancelled) is stored. */
  settled: Promise<void>
}

export const INTERRUPTED_MESSAGE =
  "The server stopped before this render finished. Select Retry to render it again."

export class RenderQueue {
  private waiting: string[] = []
  private active: ActiveRender | null = null
  private progress = new Map<string, RenderProgress>()
  private idleWaiters: (() => void)[] = []

  constructor(
    private readonly storage: VideoStorage,
    private readonly render: RenderFn,
    private readonly log: (message: string) => void = () => {},
    private readonly gate?: QueueGate,
  ) {}

  /**
   * Startup recovery. Stops orphaned FFmpeg processes of a previous server
   * process (when `stopOrphans` is given), then marks its leftover
   * queued/rendering jobs as failed ("interrupted", retryable) and removes
   * their partial output and scratch files. Completed, failed and cancelled
   * jobs are left as they are.
   */
  async recover({
    stopOrphans,
    activeElsewhere,
  }: {
    stopOrphans?: () => Promise<number[]>
    /** A job another live process is rendering right now (from the gate's owner record). */
    activeElsewhere?: () => Promise<string | null>
  } = {}) {
    if (stopOrphans) {
      const stopped = await stopOrphans().catch(() => [])
      if (stopped.length > 0)
        this.log(
          `[pixel] stopped ${stopped.length} orphaned FFmpeg process(es)`,
        )
    }
    const leftovers = await this.storage.findJobs(["queued", "rendering"])
    const elsewhere = (await activeElsewhere?.().catch(() => null)) ?? null
    for (const id of leftovers) {
      if (this.isTracked(id) || id === elsewhere) continue
      await this.storage
        .transitionJob(id, "failed", {
          error: { code: "interrupted", message: INTERRUPTED_MESSAGE },
        })
        .catch(() => undefined)
      await this.storage.discardOutput(id).catch(() => undefined)
      await this.storage.cleanupWork(id).catch(() => undefined)
    }
    return leftovers
  }

  /** Whether this process is rendering or holding the job in its queue. */
  isTracked(jobId: string) {
    return this.active?.id === jobId || this.waiting.includes(jobId)
  }

  /**
   * Queues a draft job. Throws QueueError("duplicate") if it is already
   * queued/rendering, QueueError("busy") when the queue is full, and a
   * StorageError("invalid-state") if the job isn't a draft any more.
   */
  enqueue(jobId: string): Promise<RenderJob> {
    return this.claimAndQueue(jobId, "draft")
  }

  /**
   * Retries a failed (or interrupted) job with its stored uploads and
   * server-built project: no re-upload. The project and every file it uses
   * are re-validated first; partial output and scratch files are removed.
   */
  async retry(jobId: string): Promise<RenderJob> {
    if (this.isTracked(jobId))
      throw new QueueError("duplicate", "This video is already being rendered.")
    const job = await this.storage.readJob(jobId)
    if (job.state !== "failed")
      throw new QueueError(
        "not-retryable",
        job.state === "completed"
          ? "This video is already finished."
          : `Only failed videos can be retried (this one is ${job.state}).`,
      )
    try {
      const project = await this.storage.readProject(jobId)
      for (const asset of project.assets)
        await this.storage.assetPath(jobId, asset.id)
      for (const asset of project.audioAssets ?? [])
        await this.storage.audioAssetPath(jobId, asset.id)
    } catch {
      throw new QueueError(
        "files-missing",
        "This video's saved images, audio or project can't be used any more. Delete it and start a new render.",
      )
    }
    return this.claimAndQueue(jobId, "failed")
  }

  /**
   * Cancels a job. A waiting job is removed from the queue and never starts.
   * An active job's FFmpeg processes are stopped; this resolves once the
   * job's final state is stored (normally "cancelled", or "completed" if it
   * had already finished). Repeated calls are safe.
   */
  async cancel(jobId: string): Promise<RenderJob> {
    if (this.waiting.includes(jobId)) {
      this.waiting = this.waiting.filter((id) => id !== jobId)
      this.progress.delete(jobId)
      this.updateWaitingPositions()
      const job = await this.storage.transitionJob(jobId, "cancelled")
      this.notifyIfIdle()
      return job
    }
    const active = this.active
    if (active?.id === jobId) {
      active.controller.abort()
      await active.settled
      return this.storage.readJob(jobId)
    }
    const job = await this.storage.readJob(jobId)
    if (job.state === "cancelled") return job
    // Left over from another server process and not running here.
    if (job.state === "queued" || job.state === "rendering")
      return this.storage.transitionJob(jobId, "cancelled")
    throw new QueueError(
      "not-cancellable",
      `Only queued or rendering videos can be cancelled (this one is ${job.state}).`,
    )
  }

  /**
   * Deletes a job and all its files. Refused while it is queued or
   * rendering in this process; storage re-checks the state under its lock.
   */
  async delete(jobId: string): Promise<void> {
    if (this.isTracked(jobId))
      throw new QueueError(
        "active",
        "This video is still rendering. Cancel it before deleting it.",
      )
    await this.storage.deleteJob(jobId)
    this.progress.delete(jobId)
  }

  /** In-memory progress for a job this process is handling, else null. */
  progressOf(jobId: string): RenderProgress | null {
    return this.progress.get(jobId) ?? null
  }

  isBusy() {
    return this.active !== null
  }

  /** The job currently rendering, if any. */
  activeJobId() {
    return this.active?.id ?? null
  }

  /** Resolves when nothing is rendering or waiting (tests). */
  whenIdle(): Promise<void> {
    if (!this.active && this.waiting.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private async claimAndQueue(jobId: string, from: "draft" | "failed") {
    if (this.isTracked(jobId))
      throw new QueueError("duplicate", "This video is already being rendered.")
    if (this.waiting.length >= MAX_WAITING)
      throw new QueueError(
        "busy",
        "Several videos are already waiting to render. Try again in a minute.",
      )
    // Claim the slot synchronously, before any await, so a racing duplicate
    // request fails the isTracked check above.
    this.waiting.push(jobId)
    try {
      if (from === "failed") {
        await this.storage.discardOutput(jobId)
        await this.storage.cleanupWork(jobId)
      }
      const job = await this.storage.transitionJob(jobId, "queued", { from })
      this.updateWaitingPositions()
      void this.pump()
      return job
    } catch (error) {
      this.waiting = this.waiting.filter((id) => id !== jobId)
      this.progress.delete(jobId)
      this.updateWaitingPositions()
      throw error
    }
  }

  private updateWaitingPositions() {
    this.waiting.forEach((id, index) =>
      this.progress.set(id, { phase: "waiting", position: index + 1 }),
    )
  }

  private notifyIfIdle() {
    if (!this.active && this.waiting.length === 0)
      for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  private async pump(): Promise<void> {
    if (this.active) return
    const next = this.waiting.shift()
    if (!next) {
      this.notifyIfIdle()
      return
    }
    const controller = new AbortController()
    let markSettled!: () => void
    const settled = new Promise<void>((resolve) => (markSettled = resolve))
    this.active = { id: next, controller, settled }
    // It's this job's turn: never show it as waiting behind itself.
    this.progress.set(next, { phase: "preparing" })
    this.updateWaitingPositions()
    let lease: RenderLease | undefined
    try {
      // DV-005C: one render at a time across ALL processes (Studio servers
      // and ticket workers). The job stays queued until the gate is ours.
      if (this.gate) {
        this.progress.set(next, { phase: "waiting", position: 1 })
        lease = await this.gate.acquire(
          { kind: "studio", jobId: next, storageRoot: this.storage.root },
          controller.signal,
        )
        this.progress.set(next, { phase: "preparing" })
      }
      await this.storage.transitionJob(next, "rendering")
      const output = await this.render(
        next,
        (p) => {
          if (!controller.signal.aborted) this.progress.set(next, p)
        },
        controller.signal,
        lease,
      )
      // A cancel that arrived after FFmpeg finished but before publication
      // wins: the job becomes "cancelled", never cancelled → completed.
      if (controller.signal.aborted) throw new RenderCancelled()
      await this.storage.transitionJob(next, "completed", { output })
    } catch (error) {
      await this.storage.discardOutput(next).catch(() => undefined)
      if (
        error instanceof RenderCancelled ||
        error instanceof GateCancelled ||
        controller.signal.aborted
      ) {
        await this.storage.cleanupWork(next).catch(() => undefined)
        await this.storage
          .transitionJob(next, "cancelled")
          .catch((e) =>
            this.log(
              `[pixel] ${next} couldn't be marked cancelled: ${String(e)}`,
            ),
          )
      } else {
        const failure =
          error instanceof RenderFailure
            ? error
            : new RenderFailure(
                "render-failed",
                "Rendering stopped because of an unexpected error. Try again.",
              )
        if (!(error instanceof RenderFailure))
          this.log(`[pixel] ${next} failed unexpectedly: ${String(error)}`)
        await this.storage
          .transitionJob(next, "failed", {
            error: { code: failure.code, message: failure.message },
          })
          .catch((e) =>
            this.log(`[pixel] ${next} couldn't be marked failed: ${String(e)}`),
          )
      }
    } finally {
      await lease?.release().catch(() => undefined)
      this.progress.delete(next)
      this.active = null
      markSettled()
      void this.pump()
    }
  }
}

// ---------------------------------------------------------------------------
// Process-wide instance
// ---------------------------------------------------------------------------

const KEY = Symbol.for("deskverse.pixel.renderQueue")
type Global = typeof globalThis & {
  [KEY]?: Promise<{ queue: RenderQueue; storage: VideoStorage }>
}

/**
 * Encoder threads: leaves a core free for the app and caps at 4. Measured at
 * 1080×1920: 4 threads encode as fast as 8 here (still images), with ~90 MB
 * less peak memory (libx264's own frame buffers dominate memory use).
 */
export function renderThreads() {
  return Math.max(1, Math.min(os.availableParallelism() - 1, 4))
}

/**
 * The server's queue and storage, created once per process (kept on
 * globalThis so dev-mode module reloading can't start a second worker).
 */
export function getRenderService() {
  const g = globalThis as Global
  g[KEY] ??= (async () => {
    const storage = createVideoStorage(resolveDataRoot())
    const ffmpeg = resolveExecutable(
      "ffmpeg",
      process.env.DESKVERSE_FFMPEG_PATH,
    )
    const ffprobe = resolveExecutable(
      "ffprobe",
      process.env.DESKVERSE_FFPROBE_PATH,
    )
    const log = (message: string) => console.error(message)
    const gate = new RenderGate(resolveDataRoot(), { log })
    const queue = new RenderQueue(
      storage,
      (jobId, onProgress, signal, lease) => {
        if (!ffmpeg.ok || !ffprobe.ok)
          throw new RenderFailure(
            "ffmpeg-unavailable",
            "The configured FFmpeg/FFprobe location isn't valid.",
          )
        return renderVideo(
          jobId,
          {
            storage,
            lease: lease!,
            spawn: spawnTool,
            run: createRunner({ timeoutMs: 30_000 }),
            getCapabilities: () => getFfmpegCapabilities(),
            commands: { ffmpeg: ffmpeg.command, ffprobe: ffprobe.command },
            fonts: {
              bold: loadVideoFont("bold"),
              medium: loadVideoFont("medium"),
            },
            fontDir: fontDirectory(),
            threads: renderThreads(),
            timeouts: { sceneMs: 60_000, encodeMs: 10 * 60_000 },
            log,
          },
          onProgress,
          signal,
        )
      },
      log,
      gate,
    )
    await queue.recover({
      // Ownership-aware (DV-005C): first stop renders whose owner died (only
      // processes holding the gate, only when no live owner holds it), then
      // legacy pre-gate leftovers in Studio's own job folders, never a
      // process holding the gate (a live Studio or ticket render).
      stopOrphans: () =>
        stopAbandonedRenders(gate, path.join(storage.root, "jobs")),
      activeElsewhere: async () => {
        const status = await gate.status()
        return status.held &&
          status.owner?.kind === "studio" &&
          status.owner.storageRoot === storage.root
          ? status.owner.jobId
          : null
      },
    })
    // Abandoned drafts (uploads never rendered) older than a day, and stray
    // scratch files. Failed, cancelled and completed jobs are never removed
    // automatically: the user retries or deletes them.
    await storage
      .cleanupAbandoned({ draftOlderThanMs: 24 * 60 * 60 * 1000 })
      .catch((error) => log(`[pixel] cleanup failed: ${String(error)}`))
    return { queue, storage }
  })().catch((error) => {
    // Don't cache a failed start (e.g. an invalid DESKVERSE_DATA_DIR).
    g[KEY] = undefined
    throw error
  })
  return g[KEY]
}

/**
 * Pixel Studio's startup recovery (DV-005C, ownership-aware): stops renders
 * whose owning process died (only gate holders, only when no live owner
 * holds the gate), then legacy pre-gate leftovers in Studio's own job
 * folders, skipping every process that holds the gate (a live Studio or
 * ticket render). Unrelated FFmpeg processes are never touched.
 */
export async function stopAbandonedRenders(gate: RenderGate, jobsDir: string) {
  const reaped = await gate.reapAbandoned()
  const holders = new Set((await gate.holders()).map((h) => h.pid))
  const legacy = await stopOrphanedRenders(jobsDir, { skip: holders })
  return [...reaped, ...legacy]
}

export function isStorageError(error: unknown, code?: StorageError["code"]) {
  return (
    error instanceof StorageError && (code === undefined || error.code === code)
  )
}
