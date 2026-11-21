import "server-only"

import os from "node:os"

import type {
  RenderJob,
  RenderOutput,
  RenderProgress,
} from "@/lib/video/render-job"
import { createRunner, spawnTool } from "@/server/process/run-executable"
import {
  getFfmpegCapabilities,
  resolveExecutable,
} from "@/server/video/ffmpeg-capabilities"
import { fontDirectory, loadVideoFont } from "@/server/video/font-metrics"
import { RenderFailure, renderVideo } from "@/server/video/render-service"
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
 * any job still "queued" or "rendering" belongs to a previous process and is
 * marked failed ("interrupted"), so nothing half-rendered is reported as
 * complete. A persistent queue, cancellation and retries are DV-003D.
 */

export const MAX_WAITING = 3

export class QueueError extends Error {
  constructor(
    readonly code: "busy" | "duplicate",
    message: string,
  ) {
    super(message)
  }
}

export type RenderFn = (
  jobId: string,
  onProgress: (progress: RenderProgress) => void,
) => Promise<RenderOutput>

export class RenderQueue {
  private waiting: string[] = []
  private active: string | null = null
  private progress = new Map<string, RenderProgress>()
  private idleWaiters: (() => void)[] = []

  constructor(
    private readonly storage: VideoStorage,
    private readonly render: RenderFn,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** Marks jobs left over from a previous server process as failed. */
  async recover() {
    const leftovers = await this.storage.findJobs(["queued", "rendering"])
    for (const id of leftovers) {
      if (id === this.active || this.waiting.includes(id)) continue
      await this.storage
        .transitionJob(id, "failed", {
          error: {
            code: "interrupted",
            message:
              "The server stopped before this render finished. Start a new render.",
          },
        })
        .catch(() => undefined)
      await this.storage.discardOutput(id).catch(() => undefined)
      await this.storage.cleanupWork(id).catch(() => undefined)
    }
    return leftovers
  }

  /**
   * Queues a draft job. Throws QueueError("duplicate") if it is already
   * queued/rendering, QueueError("busy") when the queue is full, and a
   * StorageError("invalid-state") if the job isn't a draft any more.
   */
  async enqueue(jobId: string): Promise<RenderJob> {
    if (this.active === jobId || this.waiting.includes(jobId))
      throw new QueueError("duplicate", "This video is already being rendered.")
    if (this.waiting.length >= MAX_WAITING)
      throw new QueueError(
        "busy",
        "Several videos are already waiting to render. Try again in a minute.",
      )
    // Claim the slot before the async transition so a racing duplicate fails.
    this.waiting.push(jobId)
    try {
      const job = await this.storage.transitionJob(jobId, "queued")
      this.updateWaitingPositions()
      void this.pump()
      return job
    } catch (error) {
      this.waiting = this.waiting.filter((id) => id !== jobId)
      throw error
    }
  }

  /** In-memory progress for a job this process is handling, else null. */
  progressOf(jobId: string): RenderProgress | null {
    return this.progress.get(jobId) ?? null
  }

  isBusy() {
    return this.active !== null
  }

  /** Resolves when nothing is rendering or waiting (tests). */
  whenIdle(): Promise<void> {
    if (!this.active && this.waiting.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private updateWaitingPositions() {
    this.waiting.forEach((id, index) =>
      this.progress.set(id, { phase: "waiting", position: index + 1 }),
    )
  }

  private async pump(): Promise<void> {
    if (this.active) return
    const next = this.waiting.shift()
    if (!next) {
      for (const resolve of this.idleWaiters.splice(0)) resolve()
      return
    }
    this.active = next
    // It's this job's turn: never show it as waiting behind itself.
    this.progress.set(next, { phase: "preparing" })
    this.updateWaitingPositions()
    try {
      await this.storage.transitionJob(next, "rendering")
      const output = await this.render(next, (p) => this.progress.set(next, p))
      await this.storage.transitionJob(next, "completed", { output })
    } catch (error) {
      const failure =
        error instanceof RenderFailure
          ? error
          : new RenderFailure(
              "render-failed",
              "Rendering stopped because of an unexpected error. Try again.",
            )
      if (!(error instanceof RenderFailure))
        this.log(`[pixel] ${next} failed unexpectedly: ${String(error)}`)
      await this.storage.discardOutput(next).catch(() => undefined)
      await this.storage
        .transitionJob(next, "failed", {
          error: { code: failure.code, message: failure.message },
        })
        .catch((e) =>
          this.log(`[pixel] ${next} couldn't be marked failed: ${String(e)}`),
        )
    } finally {
      this.progress.delete(next)
      this.active = null
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
    const queue = new RenderQueue(
      storage,
      (jobId, onProgress) => {
        if (!ffmpeg.ok || !ffprobe.ok)
          throw new RenderFailure(
            "ffmpeg-unavailable",
            "The configured FFmpeg/FFprobe location isn't valid.",
          )
        return renderVideo(
          jobId,
          {
            storage,
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
        )
      },
      log,
    )
    await queue.recover()
    // Abandoned drafts (uploads never rendered) and old failures.
    await storage
      .cleanupStaleJobs({
        olderThanMs: 24 * 60 * 60 * 1000,
        states: ["draft", "failed", "cancelled"],
      })
      .catch((error) => log(`[pixel] cleanup failed: ${String(error)}`))
    return { queue, storage }
  })().catch((error) => {
    // Don't cache a failed start (e.g. an invalid DESKVERSE_DATA_DIR).
    g[KEY] = undefined
    throw error
  })
  return g[KEY]
}

export function isStorageError(error: unknown, code?: StorageError["code"]) {
  return (
    error instanceof StorageError && (code === undefined || error.code === code)
  )
}
