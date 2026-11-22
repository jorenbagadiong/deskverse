import { createHash } from "node:crypto"
import { createReadStream, promises as fs } from "node:fs"

import type pg from "pg"

import type { FfmpegCapabilityReport } from "@/lib/video/capabilities"
import type { RenderProgress } from "@/lib/video/render-job"
import type { VideoProject } from "@/lib/video/types"
import {
  HandlerAborted,
  type HandlerContext,
  type HandlerOutcome,
  type TaskHandler,
} from "@/server/orchestrator/workflows"
import {
  AdapterRefusal,
  assertFidelity,
  buildTicketProject,
  verifyRenderInputs,
  type VerifiedInputs,
} from "@/server/pixel/adapter"
import {
  verifyDisclosureFrames,
  type DisclosureCheck,
} from "@/server/pixel/frames"
import {
  persistDeliverable,
  setRenderState,
  ticketRenderStorage,
  type VerifiedVideo,
} from "@/server/pixel/store"
import {
  createRunner,
  spawnTool,
  type Runner,
} from "@/server/process/run-executable"
import type { MediaTools } from "@/server/tickets/media-verify"
import { outputProbeArgs, verifyOutputProbe } from "@/server/video/ffprobe"
import type { FontMetrics, VideoFontWeight } from "@/server/video/font-metrics"
import { GateCancelled, type RenderGate } from "@/server/video/render-gate"
import {
  RenderCancelled,
  RenderFailure,
  renderVideo,
} from "@/server/video/render-service"
import type { VideoStorage } from "@/server/video/storage"

/**
 * Pixel's production handler for `pixel.render` (DV-005C). Renders one
 * product's video from its pinned manifest with Pixel Studio's own engine,
 * inside the installation-wide render gate, then verifies the result
 * (FFprobe format checks, disclosure in real frames, SHA-256) and commits
 * it as a deliverable in the same transaction that completes the task.
 *
 * Execution is at-least-once (a crashed render may run again); a
 * committed deliverable is effectively-once (one per task, fenced). A
 * verified output from an earlier attempt of the same task is reused
 * after a crash instead of rendering again.
 */

export interface PixelHandlerOptions {
  pool: pg.Pool
  dataRoot: string
  gate: RenderGate
  commands: { ffmpeg: string; ffprobe: string }
  getCapabilities: () => Promise<FfmpegCapabilityReport>
  fonts: Record<VideoFontWeight, FontMetrics>
  fontDir: string
  threads: number
  log?: (line: string) => void
  /** Test-only crash points (attempt 1 of products whose name contains `product`). */
  test?:
    | {
        crashAt: "during-render" | "after-output" | "before-commit"
        product: string
      }[]
    | null
}

const PROGRESS_EVERY_MS = 1_000

async function sha256File(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

export function createPixelHandler(options: PixelHandlerOptions): TaskHandler {
  const { pool, gate } = options
  const storage: VideoStorage = ticketRenderStorage(options.dataRoot)
  const run: Runner = createRunner({
    timeoutMs: 60_000,
    maxOutputBytes: 4 * 1024 * 1024,
  })
  const tools: MediaTools = {
    run,
    ffmpeg: options.commands.ffmpeg,
    ffprobe: options.commands.ffprobe,
  }
  const log = options.log ?? (() => {})

  /** FFprobe + disclosure frames + checksum for a finished output (inside the gate). */
  async function verifyOutput(
    jobId: string,
    project: VideoProject,
    inputs: VerifiedInputs,
    spawn: typeof spawnTool,
    signal: AbortSignal,
  ) {
    const output = await storage.resolveCompletedOutput(jobId)
    if (!output)
      throw new RenderFailure(
        "verification-failed",
        "The finished video file is missing.",
      )
    const totalFrames = project.scenes.reduce((n, s) => n + s.durationFrames, 0)
    const probe = await run(
      options.commands.ffprobe,
      outputProbeArgs(output.path),
      { signal },
    )
    if (!probe.ok)
      throw new RenderFailure(
        "verification-failed",
        "FFprobe couldn't read the finished video.",
      )
    const verified = verifyOutputProbe(probe.stdout, totalFrames, {
      expectAudio: false,
    })
    if (!verified.ok)
      throw new RenderFailure(
        "verification-failed",
        `The finished video didn't pass verification (${verified.problems.join("; ")}).`,
      )
    const work = await storage.workDir(jobId)
    let frames: DisclosureCheck
    try {
      frames = await verifyDisclosureFrames({
        video: output.path,
        project,
        disclosure: inputs.doc.disclosure.text,
        fonts: options.fonts,
        fontDir: options.fontDir,
        work,
        ffmpeg: options.commands.ffmpeg,
        spawn,
        signal,
      })
    } finally {
      await storage.cleanupWork(jobId).catch(() => undefined)
    }
    return {
      output,
      verified: verified.value,
      frames,
      sha256: await sha256File(output.path),
    }
  }

  return {
    stage: "pixel.render",
    kind: "production",
    async run(ctx: HandlerContext): Promise<HandlerOutcome> {
      const rj = (
        await pool.query("SELECT * FROM pixel_render_jobs WHERE task_id = $1", [
          ctx.taskId,
        ])
      ).rows[0]
      if (
        !rj ||
        rj.manifest_checksum !== ctx.params.manifestChecksum ||
        !ctx.snapshot
      )
        return {
          status: "permanent",
          message: "This video task has no matching render manifest.",
        }
      let inputs: VerifiedInputs
      try {
        inputs = await verifyRenderInputs(
          pool,
          rj,
          { ticketId: ctx.ticketId, snapshotChecksum: ctx.snapshot.checksum },
          { dataRoot: options.dataRoot, tools },
        )
      } catch (error) {
        if (error instanceof AdapterRefusal)
          return { status: error.kind, message: error.message.slice(0, 500) }
        throw error
      }
      const crash = (point: string) => {
        if (ctx.attempt !== 1) return
        for (const t of options.test ?? [])
          if (t.crashAt === point && inputs.doc.productName.includes(t.product))
            process.kill(process.pid, "SIGKILL")
      }
      const capabilities = await options.getCapabilities()
      if (capabilities.status !== "ready" || !capabilities.selectedH264Encoder)
        return {
          status: "permanent",
          message:
            "FFmpeg isn't ready to render on this computer (see Pixel Studio's FFmpeg status).",
        }

      let lease
      let video: VerifiedVideo | null = null
      try {
        // Reuse a verified output of an earlier attempt of THIS task (crash recovery).
        const previous = rj.pixel_job_id as string | null
        let reused: { jobId: string; project: VideoProject } | null = null
        if (previous) {
          const job = await storage.readJob(previous).catch(() => null)
          const project =
            job?.state === "completed"
              ? await storage.readProject(previous).catch(() => null)
              : null
          if (project && project.assets.length === inputs.images.length) {
            try {
              assertFidelity(inputs.doc, project)
              reused = { jobId: previous, project }
            } catch {
              reused = null
            }
          }
        }
        let jobId: string
        let project: VideoProject
        if (reused) {
          ;({ jobId, project } = reused)
          log(
            `[pixel] reusing the verified output of an earlier attempt (${jobId})`,
          )
        } else {
          ;({ jobId, project } = await buildTicketProject(
            storage,
            inputs,
            options.fonts,
          ))
          await storage.transitionJob(jobId, "queued")
        }
        await setRenderState(pool, rj.id, ctx.fence, {
          state: "waiting_for_renderer",
          pixelJobId: jobId,
          progress: { phase: "waiting", position: 1 },
          error: null,
        })
        lease = await gate.acquire(
          { kind: "ticket", jobId, storageRoot: storage.root },
          ctx.signal,
        )
        let encoder = capabilities.selectedH264Encoder
        if (!reused) {
          await storage.transitionJob(jobId, "rendering")
          await setRenderState(pool, rj.id, ctx.fence, {
            state: "rendering",
            progress: { phase: "preparing" },
          })
          let last = 0
          const onProgress = (p: RenderProgress) => {
            if (p.phase === "encoding" && p.fraction >= 0.3)
              crash("during-render")
            const now = Date.now()
            if (now - last < PROGRESS_EVERY_MS) return
            last = now
            void setRenderState(pool, rj.id, ctx.fence, { progress: p }).catch(
              () => undefined,
            )
          }
          try {
            const output = await renderVideo(
              jobId,
              {
                storage,
                lease,
                spawn: spawnTool,
                run,
                getCapabilities: async () => capabilities,
                commands: options.commands,
                fonts: options.fonts,
                fontDir: options.fontDir,
                threads: options.threads,
                timeouts: { sceneMs: 60_000, encodeMs: 10 * 60_000 },
                log,
              },
              onProgress,
              ctx.signal,
            )
            encoder = output.encoder
            await storage.transitionJob(jobId, "completed", { output })
          } catch (error) {
            await storage.discardOutput(jobId).catch(() => undefined)
            const cancelled =
              error instanceof RenderCancelled || ctx.signal.aborted
            await storage
              .transitionJob(
                jobId,
                cancelled ? "cancelled" : "failed",
                cancelled
                  ? {}
                  : {
                      error: {
                        code: "render-failed",
                        message: "The render failed.",
                      },
                    },
              )
              .catch(() => undefined)
            throw error
          }
        }
        await setRenderState(pool, rj.id, ctx.fence, {
          state: "verifying",
          progress: { phase: "verifying" },
        })
        const checked = await verifyOutput(
          jobId,
          project,
          inputs,
          lease.wrap(spawnTool),
          ctx.signal,
        )
        await lease.release()
        lease = undefined
        if (!checked.frames.verified)
          return {
            status: "permanent",
            message:
              "The affiliate disclosure couldn't be confirmed in the rendered frames, so the video wasn't kept.",
          }
        await fs.chmod(checked.output.path, 0o400).catch(() => undefined)
        const v = checked.verified
        video = {
          pixelJobId: jobId,
          sha256: checked.sha256,
          byteSize: checked.output.sizeBytes,
          width: v.width,
          height: v.height,
          durationMs: Math.round(v.durationSeconds * 1000),
          fps: v.fps,
          videoCodec: v.videoCodec,
          pixelFormat: v.pixelFormat,
          audio: v.audio !== null,
          encoder: encoder ?? "unknown",
          checks: {
            reusedEarlierAttempt: Boolean(reused),
            disclosureFrames: checked.frames.scenes,
            captionsFrom: `quill-script v${inputs.scriptVersion} (pixel.product, validated by Pixel)`,
            narration:
              "Not rendered: silent, captioned video (narration is script text, not audio).",
            visualDirections:
              "Guidance only: Pixel's fixed layout with the pinned images in order.",
            scenes: project.scenes.map((s) => ({
              id: s.id,
              kind: s.kind,
              caption: s.caption.text,
              frames: s.durationFrames,
            })),
          },
        }
      } catch (error) {
        if (
          error instanceof GateCancelled ||
          error instanceof RenderCancelled ||
          ctx.signal.aborted
        )
          throw new HandlerAborted("aborted")
        if (error instanceof AdapterRefusal)
          return { status: error.kind, message: error.message.slice(0, 500) }
        if (error instanceof RenderFailure) {
          const transient =
            error.code === "timed-out" || error.code === "render-failed"
          return {
            status: transient ? "transient" : "permanent",
            message: error.message.slice(0, 500),
          }
        }
        throw error
      } finally {
        await lease?.release()
      }
      crash("after-output")
      const final = video
      return {
        status: "completed",
        result: { kind: "pixel_video" },
        deliverable: {
          kind: "pixel_video",
          persist: (client, commit) =>
            persistDeliverable(
              client,
              commit,
              {
                id: rj.id,
                productId: rj.product_id,
                scriptId: rj.script_id,
                scriptVersion: rj.script_version,
                scriptChecksum: rj.script_checksum,
              },
              final,
              { beforeCommit: () => crash("before-commit") },
            ),
        },
      }
    },
  }
}
