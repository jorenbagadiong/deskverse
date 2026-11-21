/**
 * Real FFmpeg job-management tests (DV-003D1). Run with `yarn test:integration`.
 *
 * Cancellation is proven against real FFmpeg processes: after cancelling, no
 * ffmpeg/ffprobe process may remain with its working directory inside the
 * job storage (checked through /proc on Linux), no MP4 is published and no
 * scratch files remain. Restart recovery is exercised with a real orphaned
 * FFmpeg process and a brand-new queue, as after a server crash.
 */
import { execFileSync, spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { FfmpegCapabilityReport } from "@/lib/video/capabilities"
import type { AudioConfig, ProductInfo } from "@/lib/video/types"
import type { RenderProgress } from "@/lib/video/render-job"
import { stopOrphanedRenders } from "@/server/process/orphans"
import { createRunner, spawnTool } from "@/server/process/run-executable"
import { detectFfmpegCapabilities } from "@/server/video/ffmpeg-capabilities"
import { fontDirectory, loadVideoFont } from "@/server/video/font-metrics"
import { buildTrustedProject } from "@/server/video/project"
import { INTERRUPTED_MESSAGE, RenderQueue } from "@/server/video/render-queue"
import { renderVideo } from "@/server/video/render-service"
import {
  createVideoStorage,
  StorageError,
  type VideoStorage,
} from "@/server/video/storage"
import {
  createAudioInspector,
  createUploadVerifier,
} from "@/server/video/upload-verify"

const commands = { ffmpeg: "ffmpeg", ffprobe: "ffprobe" }
const fonts = { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") }
const product: ProductInfo = {
  name: "Trailblazer travel mug",
  headline: "Hot coffee for 12 hours",
  benefits: [
    "Leak-proof lid for your bag",
    "Fits every cup holder",
    "Keeps ice for a day",
  ],
  callToAction: "Tap the link to shop",
  disclosure: "#ad · I may earn a commission if you buy through my link.",
}

let base: string
let media: string
let capabilities: FfmpegCapabilityReport

function ffmpeg(args: string[]) {
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args], {
    stdio: "ignore",
  })
}

/** PIDs of ffmpeg/ffprobe processes whose working directory is inside `dir`. */
async function rendersRunningIn(dir: string): Promise<number[]> {
  const root = await fs.realpath(dir)
  const pids: number[] = []
  for (const name of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue
    try {
      const cwd = await fs.readlink(`/proc/${name}/cwd`)
      if (cwd !== root && !cwd.startsWith(root + path.sep)) continue
      const program = path.basename(
        (await fs.readFile(`/proc/${name}/cmdline`, "utf8")).split("\0")[0],
      )
      if (program === "ffmpeg" || program === "ffprobe") pids.push(Number(name))
    } catch {
      // exited or not ours
    }
  }
  return pids
}

/** Sets up a job with three images (and optional audio) and stores its project. */
async function prepare(storage: VideoStorage, audio?: "mixed") {
  const job = await storage.createJob()
  const verify = createUploadVerifier(
    createRunner({ timeoutMs: 15_000 }),
    commands,
  )
  const assetIds = []
  for (const [i, source] of [
    "testsrc2",
    "mandelbrot",
    "smptehdbars",
  ].entries()) {
    const file = path.join(media, `img-${i}.png`)
    const asset = await storage.addImageAsset(
      job.id,
      {
        bytes: await fs.readFile(file),
        declaredType: "image/png",
        fileName: `${source}.png`,
      },
      { verify },
    )
    assetIds.push(asset.id)
  }
  let audioConfig: AudioConfig | undefined
  if (audio) {
    const inspect = createAudioInspector(
      createRunner({ timeoutMs: 30_000 }),
      commands,
    )
    const voice = await storage.addAudioAsset(
      job.id,
      {
        bytes: await fs.readFile(path.join(media, "voice.wav")),
        declaredType: "audio/wav",
        fileName: "voice.wav",
        role: "voiceover",
      },
      { inspect },
    )
    const music = await storage.addAudioAsset(
      job.id,
      {
        bytes: await fs.readFile(path.join(media, "music.wav")),
        declaredType: "audio/wav",
        fileName: "music.wav",
        role: "music",
      },
      { inspect },
    )
    audioConfig = {
      mode: "voiceover-and-music",
      voiceoverAssetId: voice.id,
      musicAssetId: music.id,
      musicLevel: "low",
    }
  }
  const project = buildTrustedProject(
    await storage.readJob(job.id),
    { product, assetIds, ...(audioConfig ? { audio: audioConfig } : {}) },
    fonts,
  )
  if (!project.ok) throw new Error(JSON.stringify(project.issues))
  await storage.writeProject(job.id, project.value)
  return job.id
}

/** A real queue; `hooks.onProgress` sees every progress update. */
function realQueue(
  storage: VideoStorage,
  hooks: {
    onProgress?: (jobId: string, progress: RenderProgress) => void
    encodeMs?: () => number
    started?: string[]
  } = {},
) {
  return new RenderQueue(storage, (jobId, onProgress, signal) => {
    hooks.started?.push(jobId)
    return renderVideo(
      jobId,
      {
        storage,
        spawn: spawnTool,
        run: createRunner({ timeoutMs: 60_000 }),
        getCapabilities: async () => capabilities,
        commands,
        fonts,
        fontDir: fontDirectory(),
        threads: 1, // slower encode: a wider window to cancel in
        timeouts: {
          sceneMs: 60_000,
          encodeMs: hooks.encodeMs?.() ?? 5 * 60_000,
          audioMs: 120_000,
        },
        log: () => {},
      },
      (progress) => {
        onProgress(progress)
        hooks.onProgress?.(jobId, progress)
      },
      signal,
    )
  })
}

beforeAll(async () => {
  capabilities = await detectFfmpegCapabilities({
    run: createRunner({ timeoutMs: 30_000 }),
  })
  if (capabilities.status !== "ready" || !capabilities.audio.ready)
    throw new Error("FFmpeg with audio support is required for these tests.")
  if (process.platform !== "linux")
    throw new Error("Process checks need Linux/WSL (/proc).")
  base = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-jobs-"))
  media = path.join(base, "media")
  await fs.mkdir(media)
  for (const [i, source] of ["testsrc2", "mandelbrot", "smptehdbars"].entries())
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `${source}=s=2400x2400`,
      "-frames:v",
      "1",
      path.join(media, `img-${i}.png`),
    ])
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=300:sample_rate=48000:duration=12",
    "-c:a",
    "pcm_s16le",
    path.join(media, "voice.wav"),
  ])
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=1000:sample_rate=44100:duration=3",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    path.join(media, "music.wav"),
  ])
})

afterAll(async () => {
  if (base) await fs.rm(base, { recursive: true, force: true })
})

describe("real FFmpeg cancellation", () => {
  for (const [stage, matches] of [
    [
      "composing",
      (p: RenderProgress) => p.phase === "composing" && p.completedScenes >= 1,
    ],
    [
      "encoding",
      (p: RenderProgress) => p.phase === "encoding" && p.fraction > 0,
    ],
    [
      "audio measuring",
      (p: RenderProgress) => p.phase === "audio" && p.step === "measuring",
    ],
    [
      "audio mixing",
      (p: RenderProgress) => p.phase === "audio" && p.step === "mixing",
    ],
  ] as const) {
    it(`stops the FFmpeg process when cancelled while ${stage}`, async () => {
      const storage = createVideoStorage(
        path.join(base, `cancel-${stage.replace(" ", "-")}`),
      )
      const jobId = await prepare(
        storage,
        stage.startsWith("audio") ? "mixed" : undefined,
      )
      let cancelAt = 0
      let cancelled: Promise<unknown> | null = null
      let runningAtCancel: number[] = []
      const queue = realQueue(storage, {
        onProgress: (_id, progress) => {
          if (cancelled || !matches(progress)) return
          cancelled = (async () => {
            // Wait until this stage's FFmpeg process actually exists, so the
            // test proves a live process is stopped (not just a skipped start).
            const deadline = Date.now() + 5000
            while (Date.now() < deadline) {
              runningAtCancel = await rendersRunningIn(storage.root)
              if (runningAtCancel.length > 0) break
              await new Promise((resolve) => setTimeout(resolve, 5))
            }
            cancelAt = Date.now()
            return queue.cancel(jobId)
          })()
        },
      })
      await queue.enqueue(jobId)
      await queue.whenIdle()
      await cancelled
      const settledMs = Date.now() - cancelAt

      const job = await storage.readJob(jobId)
      expect(job.state).toBe("cancelled")
      expect(job.output).toBeNull()
      expect(await storage.resolveCompletedOutput(jobId)).toBeNull()
      expect(
        await fs.readdir(path.join(storage.root, "jobs", jobId, "output")),
      ).toEqual([])
      expect(await fs.readdir(await storage.workDir(jobId))).toEqual([])
      // A process really was running at cancel time, and none is left now.
      expect(runningAtCancel.length).toBeGreaterThan(0)
      expect(await rendersRunningIn(storage.root)).toEqual([])
      for (const pid of runningAtCancel)
        expect(() => process.kill(pid, 0)).toThrow()
      expect(queue.isBusy()).toBe(false)
      expect(settledMs).toBeLessThan(5000)
      console.info(
        `[jobs] cancel while ${stage}: ${runningAtCancel.length} FFmpeg process(es) running at cancel, settled in ${settledMs} ms`,
      )
    })
  }

  it("never starts a cancelled queued job, and frees its slot", async () => {
    const storage = createVideoStorage(path.join(base, "cancel-queued"))
    const first = await prepare(storage)
    const second = await prepare(storage)
    const started: string[] = []
    const queue = realQueue(storage, { started })
    await queue.enqueue(first)
    await queue.enqueue(second)
    expect(queue.progressOf(second)).toEqual({ phase: "waiting", position: 1 })
    const cancelled = await queue.cancel(second)
    expect(cancelled.state).toBe("cancelled")
    expect(await queue.cancel(second)).toMatchObject({ state: "cancelled" }) // repeated: harmless
    await queue.whenIdle()
    expect(started).toEqual([first])
    expect((await storage.readJob(first)).state).toBe("completed")
    expect((await storage.readJob(second)).state).toBe("cancelled")
    // Uploads of the cancelled job are kept until it's deleted.
    expect(
      (await fs.readdir(path.join(storage.root, "jobs", second, "assets")))
        .length,
    ).toBe(3)
  })
})

describe("real FFmpeg failure, retry, restart recovery and deletion", () => {
  it("retries a really failed render without re-uploading", async () => {
    const storage = createVideoStorage(path.join(base, "retry"))
    const jobId = await prepare(storage)
    let encodeMs = 1 // the real encoder can't finish in 1 ms: a genuine failure
    const queue = realQueue(storage, { encodeMs: () => encodeMs })
    await queue.enqueue(jobId)
    await queue.whenIdle()
    const failed = await storage.readJob(jobId)
    expect(failed.state).toBe("failed")
    expect(failed.error?.code).toBe("timed-out")
    expect(await rendersRunningIn(storage.root)).toEqual([])

    encodeMs = 5 * 60_000
    const queued = await queue.retry(jobId)
    expect(queued.state).toBe("queued")
    expect(queued.error).toBeNull()
    await expect(queue.retry(jobId)).rejects.toMatchObject({
      code: "duplicate",
    })
    await queue.whenIdle()
    const done = await storage.readJob(jobId)
    expect(done.state).toBe("completed")
    expect(done.output?.width).toBe(1080)
    expect(await storage.resolveCompletedOutput(jobId)).not.toBeNull()
    await expect(queue.retry(jobId)).rejects.toMatchObject({
      code: "not-retryable",
    })
  })

  it("recovers after a crash: kills the orphaned FFmpeg, cleans up, then retries", async () => {
    const storage = createVideoStorage(path.join(base, "restart"))
    const jobId = await prepare(storage)
    // The "crashed" server had the job rendering...
    await storage.transitionJob(jobId, "queued")
    await storage.transitionJob(jobId, "rendering")
    // ...with an FFmpeg still running in its work dir and a partial output.
    const work = await storage.workDir(jobId)
    const orphan = spawn(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-re",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=1080x1920:r=30",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-f",
        "mp4",
        "-y",
        "render.mp4",
      ],
      { cwd: work, stdio: "ignore", detached: true },
    )
    orphan.unref()
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(await rendersRunningIn(storage.root)).toContain(orphan.pid)
    await fs.writeFile(
      path.join(storage.root, "jobs", jobId, "output", "video.mp4"),
      "partial",
    )

    // A brand-new server process: new storage handle, new queue.
    const restarted = createVideoStorage(path.dirname(storage.root))
    const queue = realQueue(restarted)
    const leftovers = await queue.recover({
      stopOrphans: () => stopOrphanedRenders(path.join(restarted.root, "jobs")),
    })
    expect(leftovers).toEqual([jobId])
    expect(await rendersRunningIn(restarted.root)).toEqual([])
    const interrupted = await restarted.readJob(jobId)
    expect(interrupted.state).toBe("failed")
    expect(interrupted.error).toEqual({
      code: "interrupted",
      message: INTERRUPTED_MESSAGE,
    })
    expect(
      await fs.readdir(path.join(restarted.root, "jobs", jobId, "output")),
    ).toEqual([])
    expect(await fs.readdir(work)).toEqual([])

    await queue.retry(jobId)
    await queue.whenIdle()
    expect((await restarted.readJob(jobId)).state).toBe("completed")
  })

  it("deletes a completed job with everything it owns", async () => {
    const storage = createVideoStorage(path.join(base, "delete"))
    const keep = await prepare(storage)
    const remove = await prepare(storage, "mixed")
    const queue = realQueue(storage)
    await queue.enqueue(keep)
    await queue.enqueue(remove)
    await queue.whenIdle()
    expect((await storage.readJob(remove)).state).toBe("completed")
    const dir = path.join(storage.root, "jobs", remove)
    expect((await fs.readdir(path.join(dir, "assets"))).length).toBe(5) // 3 images + 2 audio
    await queue.delete(remove)
    await expect(fs.access(dir)).rejects.toThrow()
    await expect(storage.readJob(remove)).rejects.toBeInstanceOf(StorageError)
    await expect(storage.resolveCompletedOutput(remove)).rejects.toMatchObject({
      code: "not-found",
    })
    expect((await storage.readJob(keep)).state).toBe("completed")
    expect(await storage.resolveCompletedOutput(keep)).not.toBeNull()
  })
})
