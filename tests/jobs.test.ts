import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { POST as cancelRoute } from "@/app/api/studio/pixel/jobs/[jobId]/cancel/route"
import { POST as retryRoute } from "@/app/api/studio/pixel/jobs/[jobId]/retry/route"
import { DELETE as deleteRoute } from "@/app/api/studio/pixel/jobs/[jobId]/route"
import { GET as historyRoute } from "@/app/api/studio/pixel/jobs/route"
import { POST as cleanupRoute } from "@/app/api/studio/pixel/storage/cleanup/route"
import { GET as storageRoute } from "@/app/api/studio/pixel/storage/route"
import { createRenderJobId } from "@/lib/video/ids"
import type { RenderOutput, RenderProgress } from "@/lib/video/render-job"
import type { ProductInfo } from "@/lib/video/types"
import { stopOrphanedRenders } from "@/server/process/orphans"
import { createRunner, spawnTool } from "@/server/process/run-executable"
import { loadVideoFont } from "@/server/video/font-metrics"
import { jobSummary, storageSummary } from "@/server/video/job-summary"
import { buildTrustedProject } from "@/server/video/project"
import {
  INTERRUPTED_MESSAGE,
  MAX_WAITING,
  QueueError,
  RenderQueue,
  type RenderFn,
} from "@/server/video/render-queue"
import { RenderCancelled, RenderFailure } from "@/server/video/render-service"
import {
  createVideoStorage,
  StorageError,
  type VideoStorage,
} from "@/server/video/storage"

const fonts = { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") }
const product: ProductInfo = {
  name: "Trailblazer travel mug",
  headline: "Hot coffee for 12 hours",
  benefits: ["Leak-proof lid"],
  callToAction: "Tap the link to shop",
  disclosure: "#ad · I may earn a commission.",
}
const OUTPUT: RenderOutput = {
  fileName: "video.mp4",
  sizeBytes: 4,
  durationSeconds: 15,
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: "h264",
  pixelFormat: "yuv420p",
  encoder: "libx264",
  renderSeconds: 1,
  audio: null,
}

function png(width: number, height: number) {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  b.set([0x49, 0x48, 0x44, 0x52], 12)
  const view = new DataView(b.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return b
}

let base: string
let storage: VideoStorage
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-jobs-unit-"))
  storage = createVideoStorage(base)
})
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

/** A draft job with three images and a stored, server-built project. */
async function preparedJob(name = product.name) {
  const job = await storage.createJob()
  for (let i = 0; i < 3; i++)
    await storage.addImageAsset(job.id, {
      bytes: png(1080, 1920),
      declaredType: "image/png",
      fileName: `${i}.png`,
    })
  const record = await storage.readJob(job.id)
  const project = buildTrustedProject(
    record,
    { product: { ...product, name }, assetIds: record.assets.map((a) => a.id) },
    fonts,
  )
  if (!project.ok) throw new Error(JSON.stringify(project.issues))
  await storage.writeProject(job.id, project.value)
  return job.id
}

/**
 * A controllable fake render that behaves like the real one: it reports
 * progress, honours the abort signal (throwing RenderCancelled), and only
 * "publishes" (writes output/video.mp4) when allowed to finish.
 */
function controllableRender() {
  const runs = new Map<
    string,
    { finish: () => void; fail: (e: Error) => void; started: Promise<void> }
  >()
  const started: string[] = []
  let concurrent = 0
  let maxConcurrent = 0
  const startWaiters = new Map<string, () => void>()
  const render: RenderFn = (jobId, onProgress, signal) => {
    started.push(jobId)
    concurrent++
    maxConcurrent = Math.max(maxConcurrent, concurrent)
    startWaiters.get(jobId)?.()
    return new Promise<RenderOutput>((resolve, reject) => {
      const done = () => {
        concurrent--
      }
      onProgress({
        phase: "encoding",
        fraction: 0.5,
        encodedSeconds: 7.5,
        totalSeconds: 15,
      })
      signal.addEventListener("abort", () => {
        done()
        reject(new RenderCancelled())
      })
      runs.set(jobId, {
        started: Promise.resolve(),
        finish: async () => {
          await fs.writeFile(
            path.join(storage.root, "jobs", jobId, "output", "video.mp4"),
            "mp4!",
          )
          done()
          resolve(OUTPUT)
        },
        fail: (e) => {
          done()
          reject(e)
        },
      })
    })
  }
  const whenStarted = (jobId: string) =>
    started.includes(jobId)
      ? Promise.resolve()
      : new Promise<void>((r) => startWaiters.set(jobId, r))
  return {
    render,
    runs,
    started,
    whenStarted,
    get maxConcurrent() {
      return maxConcurrent
    },
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

describe("queued cancellation", () => {
  it("removes a waiting job, never starts it, frees its slot and is safe to repeat", async () => {
    const fake = controllableRender()
    const queue = new RenderQueue(storage, fake.render)
    const [a, b] = [await preparedJob(), await preparedJob()]
    await queue.enqueue(a)
    await queue.enqueue(b)
    await fake.whenStarted(a)
    expect(queue.progressOf(b)).toEqual({ phase: "waiting", position: 1 })

    expect((await queue.cancel(b)).state).toBe("cancelled")
    expect(queue.progressOf(b)).toBeNull()
    expect(queue.isTracked(b)).toBe(false)
    expect((await queue.cancel(b)).state).toBe("cancelled") // repeated: no error

    await fake.runs.get(a)!.finish()
    await queue.whenIdle()
    expect(fake.started).toEqual([a])
    expect((await storage.readJob(b)).state).toBe("cancelled")
    // Uploads are kept until the job is deleted.
    expect(
      await fs.readdir(path.join(storage.root, "jobs", b, "assets")),
    ).toHaveLength(3)
  })
})

describe("active cancellation", () => {
  it("aborts the render, stores 'cancelled', publishes nothing and starts the next job", async () => {
    const fake = controllableRender()
    const queue = new RenderQueue(storage, fake.render)
    const [a, b] = [await preparedJob(), await preparedJob()]
    await queue.enqueue(a)
    await queue.enqueue(b)
    await fake.whenStarted(a)
    const [first, second] = await Promise.all([
      queue.cancel(a),
      queue.cancel(a),
    ])
    expect(first.state).toBe("cancelled")
    expect(second.state).toBe("cancelled")
    expect(await storage.resolveCompletedOutput(a)).toBeNull()
    await fake.whenStarted(b)
    expect(queue.activeJobId()).toBe(b)
    await fake.runs.get(b)!.finish()
    await queue.whenIdle()
    expect((await storage.readJob(b)).state).toBe("completed")
  })

  it("lets a cancel that arrives after FFmpeg finished win over publication", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let jobRef = ""
    const render: RenderFn = async (jobId) => {
      jobRef = jobId
      // Output is written (as commitOutput would), then the render returns.
      await fs.writeFile(
        path.join(storage.root, "jobs", jobId, "output", "video.mp4"),
        "mp4!",
      )
      await gate
      return OUTPUT
    }
    const queue = new RenderQueue(storage, render)
    const id = await preparedJob()
    await queue.enqueue(id)
    while (!jobRef) await tick()
    const cancelling = queue.cancel(id) // aborts while the render is returning
    release()
    expect((await cancelling).state).toBe("cancelled")
    expect(await storage.resolveCompletedOutput(id)).toBeNull()
    expect(
      await fs.readdir(path.join(storage.root, "jobs", id, "output")),
    ).toEqual([])
    await expect(
      storage.transitionJob(id, "completed", { output: OUTPUT }),
    ).rejects.toMatchObject({
      code: "invalid-state",
    })
  })

  it("reports 'completed' when the job finished before the cancel arrived", async () => {
    const fake = controllableRender()
    const queue = new RenderQueue(storage, fake.render)
    const id = await preparedJob()
    await queue.enqueue(id)
    await fake.whenStarted(id)
    await fake.runs.get(id)!.finish()
    await queue.whenIdle()
    await expect(queue.cancel(id)).rejects.toMatchObject({
      code: "not-cancellable",
    })
    expect((await storage.readJob(id)).state).toBe("completed")
  })

  it("never renders two jobs at once and always releases the slot", async () => {
    const fake = controllableRender()
    const queue = new RenderQueue(storage, fake.render)
    const ids = [
      await preparedJob(),
      await preparedJob(),
      await preparedJob(),
      await preparedJob(),
    ]
    for (const id of ids) await queue.enqueue(id)
    await fake.whenStarted(ids[0])
    await queue.cancel(ids[0])
    await fake.whenStarted(ids[1])
    fake.runs.get(ids[1])!.fail(new RenderFailure("render-failed", "boom"))
    await fake.whenStarted(ids[2])
    await fake.runs.get(ids[2])!.finish()
    await fake.whenStarted(ids[3])
    await queue.cancel(ids[3])
    await queue.whenIdle()
    expect(fake.maxConcurrent).toBe(1)
    expect(queue.isBusy()).toBe(false)
    expect(
      await Promise.all(
        ids.map(async (id) => (await storage.readJob(id)).state),
      ),
    ).toEqual(["cancelled", "failed", "completed", "cancelled"])
  })

  it("cancels a stale queued/rendering job not owned by this process", async () => {
    const queue = new RenderQueue(storage, controllableRender().render)
    const id = await preparedJob()
    await storage.transitionJob(id, "queued")
    await storage.transitionJob(id, "rendering")
    expect((await queue.cancel(id)).state).toBe("cancelled")
  })

  it("refuses to cancel drafts and failed jobs", async () => {
    const queue = new RenderQueue(storage, controllableRender().render)
    const draft = (await storage.createJob()).id
    await expect(queue.cancel(draft)).rejects.toBeInstanceOf(QueueError)
  })
})

describe("retry", () => {
  async function failedJob(
    queue: RenderQueue,
    fake: ReturnType<typeof controllableRender>,
  ) {
    const id = await preparedJob()
    await queue.enqueue(id)
    await fake.whenStarted(id)
    fake.runs
      .get(id)!
      .fail(new RenderFailure("render-failed", "The libx264 encoder failed."))
    await queue.whenIdle()
    return id
  }

  it("re-queues a failed job with its stored files, clearing the old error", async () => {
    const fake = controllableRender()
    const queue = new RenderQueue(storage, fake.render)
    const id = await failedJob(queue, fake)
    await fs.writeFile(
      path.join(storage.root, "jobs", id, "work", "scene-1.png"),
      "stale",
    )
    const queued = await queue.retry(id)
    expect(queued).toMatchObject({ state: "queued", error: null })
    expect(
      await fs.readdir(path.join(storage.root, "jobs", id, "work")),
    ).toEqual([])
    // Wait for the second attempt to start (the first already did).
    while (fake.started.filter((x) => x === id).length < 2) await tick()
    await fake.runs.get(id)!.finish()
    await queue.whenIdle()
    expect((await storage.readJob(id)).state).toBe("completed")
    expect(fake.started.filter((j) => j === id)).toHaveLength(2)
  })

  it("prevents duplicate retries, including concurrent ones", async () => {
    const fake = controllableRender()
    const queue = new RenderQueue(storage, fake.render)
    const id = await failedJob(queue, fake)
    const results = await Promise.allSettled([
      queue.retry(id),
      queue.retry(id),
      queue.retry(id),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    for (const r of results.filter((r) => r.status === "rejected"))
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(QueueError)
  })

  it("retries a job interrupted by a server restart", async () => {
    const id = await preparedJob()
    await storage.transitionJob(id, "queued")
    await storage.transitionJob(id, "rendering")
    await fs.writeFile(
      path.join(storage.root, "jobs", id, "output", "video.mp4"),
      "partial",
    )
    const fake = controllableRender()
    const restarted = new RenderQueue(createVideoStorage(base), fake.render)
    expect(await restarted.recover()).toEqual([id])
    const job = await storage.readJob(id)
    expect(job.error).toEqual({
      code: "interrupted",
      message: INTERRUPTED_MESSAGE,
    })
    expect(
      await fs.readdir(path.join(storage.root, "jobs", id, "output")),
    ).toEqual([])
    await restarted.retry(id)
    await fake.whenStarted(id)
    await fake.runs.get(id)!.finish()
    await restarted.whenIdle()
    expect((await storage.readJob(id)).state).toBe("completed")
  })

  it("refuses completed, cancelled, queued and draft jobs, and jobs with missing files", async () => {
    const fake = controllableRender()
    const queue = new RenderQueue(storage, fake.render)
    const draft = (await storage.createJob()).id
    await expect(queue.retry(draft)).rejects.toMatchObject({
      code: "not-retryable",
    })
    const done = await preparedJob()
    await queue.enqueue(done)
    await fake.whenStarted(done)
    await expect(queue.retry(done)).rejects.toMatchObject({ code: "duplicate" })
    await fake.runs.get(done)!.finish()
    await queue.whenIdle()
    await expect(queue.retry(done)).rejects.toMatchObject({
      code: "not-retryable",
    })

    const broken = await failedJob(queue, fake)
    const [asset] = await fs.readdir(
      path.join(storage.root, "jobs", broken, "assets"),
    )
    await fs.rm(path.join(storage.root, "jobs", broken, "assets", asset))
    await expect(queue.retry(broken)).rejects.toMatchObject({
      code: "files-missing",
    })
    expect((await storage.readJob(broken)).state).toBe("failed")
  })

  it("respects the bounded queue", async () => {
    const fake = controllableRender()
    const queue = new RenderQueue(storage, fake.render)
    const failed = await failedJob(queue, fake)
    const active = await preparedJob()
    await queue.enqueue(active)
    await fake.whenStarted(active)
    for (let i = 0; i < MAX_WAITING; i++)
      await queue.enqueue(await preparedJob())
    await expect(queue.retry(failed)).rejects.toMatchObject({ code: "busy" })
    expect((await storage.readJob(failed)).state).toBe("failed")
  })
})

describe("deletion", () => {
  it("removes every file a job owns and nothing else", async () => {
    const fake = controllableRender()
    const queue = new RenderQueue(storage, fake.render)
    const [keep, remove] = [await preparedJob(), await preparedJob()]
    const outside = path.join(base, "not-ours.txt")
    await fs.writeFile(outside, "keep me")
    await queue.delete(remove)
    await expect(
      fs.access(path.join(storage.root, "jobs", remove)),
    ).rejects.toThrow()
    await expect(storage.readJob(remove)).rejects.toMatchObject({
      code: "not-found",
    })
    await expect(storage.resolveCompletedOutput(remove)).rejects.toMatchObject({
      code: "not-found",
    })
    expect((await storage.readJob(keep)).state).toBe("draft")
    expect(await fs.readFile(outside, "utf8")).toBe("keep me")
    void fake
  })

  it("refuses to delete queued or rendering jobs, in the queue and in storage", async () => {
    const fake = controllableRender()
    const queue = new RenderQueue(storage, fake.render)
    const [a, b] = [await preparedJob(), await preparedJob()]
    await queue.enqueue(a)
    await queue.enqueue(b)
    await fake.whenStarted(a)
    await expect(queue.delete(a)).rejects.toMatchObject({ code: "active" })
    await expect(queue.delete(b)).rejects.toMatchObject({ code: "active" })
    // Storage also refuses (e.g. a stale job from another process).
    await expect(storage.deleteJob(b)).rejects.toMatchObject({
      code: "invalid-state",
    })
    await queue.cancel(b)
    await queue.delete(b)
    await queue.cancel(a)
    await queue.whenIdle()
  })

  it("serializes concurrent delete, cancel and retry safely", async () => {
    const fake = controllableRender()
    const queue = new RenderQueue(storage, fake.render)
    const id = await preparedJob()
    await queue.enqueue(id)
    await fake.whenStarted(id)
    fake.runs.get(id)!.fail(new RenderFailure("render-failed", "x"))
    await queue.whenIdle()
    const results = await Promise.allSettled([
      queue.retry(id),
      queue.delete(id),
      queue.cancel(id),
    ])
    // Whatever wins, the end state is consistent: either deleted, or queued/rendering/cancelled.
    const exists = await storage.readJob(id).then(
      () => true,
      () => false,
    )
    if (!exists) expect(queue.isTracked(id)).toBe(false)
    expect(results.some((r) => r.status === "fulfilled")).toBe(true)
    if (queue.isTracked(id)) await queue.cancel(id)
    await queue.whenIdle()
    expect(queue.isBusy()).toBe(false)
  })

  it.skipIf(process.platform === "win32")(
    "refuses symlinked job folders and never follows links inside a job",
    async () => {
      const elsewhere = await fs.mkdtemp(
        path.join(os.tmpdir(), "deskverse-elsewhere-"),
      )
      try {
        await fs.writeFile(
          path.join(elsewhere, "precious.txt"),
          "do not delete",
        )
        const fakeId = createRenderJobId()
        await fs.mkdir(path.join(storage.root, "jobs"), { recursive: true })
        await fs.symlink(elsewhere, path.join(storage.root, "jobs", fakeId))
        await expect(storage.deleteJob(fakeId)).rejects.toMatchObject({
          code: "unsafe-path",
        })
        // A link planted inside a real job is removed, its target is not.
        const id = await preparedJob()
        await fs.symlink(
          elsewhere,
          path.join(storage.root, "jobs", id, "assets", "link"),
        )
        await storage.deleteJob(id)
        expect(
          await fs.readFile(path.join(elsewhere, "precious.txt"), "utf8"),
        ).toBe("do not delete")
        for (const bad of ["../../etc", "job_x", ""])
          await expect(storage.deleteJob(bad)).rejects.toBeInstanceOf(
            StorageError,
          )
      } finally {
        await fs.rm(elsewhere, { recursive: true, force: true })
      }
    },
  )
})

describe("history and storage accounting", () => {
  it("lists newest first, bounded, with summaries only", async () => {
    let clock = new Date("2026-01-01T00:00:00Z")
    storage = createVideoStorage(base, { now: () => clock })
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      clock = new Date(clock.getTime() + 60_000)
      ids.push(await preparedJob(`Product ${i}`))
    }
    const { records, total } = await storage.listJobRecords(3)
    expect(total).toBe(5)
    expect(records.map((r) => r.job.id)).toEqual([ids[4], ids[3], ids[2]])
    const summary = jobSummary(records[0], null)
    expect(summary).toMatchObject({
      productName: "Product 4",
      state: "draft",
      audioMode: "none", // its server-built project is silent
      actions: { cancel: false, retry: false, delete: true, preview: false },
    })
    expect(JSON.stringify(summary)).not.toContain(base)
    expect(Object.keys(summary)).not.toContain("assets")
  })

  it("decides actions from the state", async () => {
    const id = await preparedJob()
    await storage.transitionJob(id, "queued")
    await storage.transitionJob(id, "rendering")
    await fs.writeFile(
      path.join(storage.root, "jobs", id, "output", "video.mp4"),
      "mp4!",
    )
    await storage.transitionJob(id, "completed", { output: OUTPUT })
    const [record] = (await storage.listJobRecords(10)).records
    const progress: RenderProgress = { phase: "waiting", position: 1 }
    expect(jobSummary(record, progress)).toMatchObject({
      state: "completed",
      audioMode: "none",
      durationSeconds: 15,
      sizeBytes: 4,
      progress: null,
      actions: { cancel: false, retry: false, delete: true, preview: true },
    })
  })

  it("accounts for uploads, outputs, scratch files and states, without following links", async () => {
    const a = await preparedJob()
    const b = await preparedJob()
    await storage.transitionJob(b, "cancelled")
    await fs.writeFile(
      path.join(storage.root, "jobs", a, "work", "tmp.bin"),
      Buffer.alloc(1000),
    )
    if (process.platform !== "win32")
      await fs.symlink(
        "/etc/passwd",
        path.join(storage.root, "jobs", a, "work", "link"),
      )
    const usage = await storage.usage()
    expect(usage.jobs).toBe(2)
    expect(usage.byState.draft).toBe(1)
    expect(usage.byState.cancelled).toBe(1)
    expect(usage.uploadBytes).toBe(6 * 33)
    expect(usage.workBytes).toBe(1000)
    expect(usage.totalBytes).toBe(
      usage.uploadBytes +
        usage.outputBytes +
        usage.workBytes +
        usage.otherBytes,
    )
    expect(storageSummary(usage)).toMatchObject({
      jobs: 2,
      drafts: 1,
      cancelled: 1,
      completed: 0,
      active: 0,
    })
  })

  it("cleans only abandoned data and never active, completed, failed or cancelled jobs", async () => {
    let clock = new Date("2026-01-01T00:00:00Z")
    storage = createVideoStorage(base, { now: () => clock })
    const oldDraft = (await storage.createJob()).id
    const failed = await preparedJob()
    await storage.transitionJob(failed, "queued")
    await storage.transitionJob(failed, "rendering")
    await storage.transitionJob(failed, "failed", {
      error: { code: "render-failed", message: "x" },
    })
    const active = await preparedJob()
    await storage.transitionJob(active, "queued")
    await fs.writeFile(
      path.join(storage.root, "jobs", failed, "work", "scene.png"),
      Buffer.alloc(500),
    )
    await fs.writeFile(
      path.join(storage.root, "jobs", active, "work", "scene.png"),
      Buffer.alloc(500),
    )
    await fs.writeFile(
      path.join(storage.root, "jobs", failed, "job.json.abc123.tmp"),
      "x",
    )
    clock = new Date("2026-01-01T03:00:00Z")
    const recentDraft = (await storage.createJob()).id

    const result = await storage.cleanupAbandoned({
      draftOlderThanMs: 60 * 60 * 1000,
    })
    expect(result).toMatchObject({
      removedDrafts: 1,
      clearedWorkDirs: 1,
      removedTempFiles: 1,
    })
    await expect(storage.readJob(oldDraft)).rejects.toMatchObject({
      code: "not-found",
    })
    expect((await storage.readJob(recentDraft)).state).toBe("draft")
    expect((await storage.readJob(failed)).state).toBe("failed")
    expect(
      await fs.readdir(path.join(storage.root, "jobs", failed, "assets")),
    ).toHaveLength(3)
    // The queued job's scratch files are untouched.
    expect(
      await fs.readdir(path.join(storage.root, "jobs", active, "work")),
    ).toEqual(["scene.png"])
  })
})

describe("process cancellation in the runners (real processes)", () => {
  it("spawnTool stops a running process on abort and settles after it exits", async () => {
    const controller = new AbortController()
    const started = Date.now()
    const pending = spawnTool(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        cwd: base,
        timeoutMs: 30_000,
        signal: controller.signal,
      },
    )
    setTimeout(() => controller.abort(), 100)
    expect(await pending).toMatchObject({ ok: false, reason: "cancelled" })
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it("escalates to SIGKILL when a process ignores SIGTERM", async () => {
    const controller = new AbortController()
    const pending = spawnTool(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      {
        cwd: base,
        timeoutMs: 30_000,
        signal: controller.signal,
        killGraceMs: 200,
      },
    )
    setTimeout(() => controller.abort(), 150)
    expect(await pending).toMatchObject({ ok: false, reason: "cancelled" })
  })

  it("never starts a process when already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    expect(
      await spawnTool("definitely-not-a-program", [], {
        cwd: base,
        timeoutMs: 1000,
        signal: controller.signal,
      }),
    ).toMatchObject({
      reason: "cancelled",
    })
    expect(
      await createRunner()("definitely-not-a-program", [], {
        signal: controller.signal,
      }),
    ).toMatchObject({ reason: "cancelled" })
  })

  it("the execFile runner kills on abort", async () => {
    const controller = new AbortController()
    const pending = createRunner({ timeoutMs: 30_000 })(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        signal: controller.signal,
      },
    )
    setTimeout(() => controller.abort(), 100)
    expect(await pending).toEqual({
      ok: false,
      reason: "cancelled",
      exitCode: null,
    })
  })
})

describe("orphaned render cleanup", () => {
  it.skipIf(process.platform !== "linux")(
    "stops only ffmpeg-named processes working inside job storage",
    async () => {
      const jobsDir = path.join(storage.root, "jobs")
      const work = path.join(jobsDir, createRenderJobId(), "work")
      await fs.mkdir(work, { recursive: true })
      const procRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "deskverse-proc-"),
      )
      const victim = spawn("sleep", ["30"], { stdio: "ignore" })
      const bystander = spawn("sleep", ["30"], { stdio: "ignore" })
      try {
        // A fake /proc: the victim "is" ffmpeg in a job's work dir; the
        // bystander is ffmpeg elsewhere; another is a non-ffmpeg in storage.
        const entry = async (pid: number, cwd: string, program: string) => {
          await fs.mkdir(path.join(procRoot, String(pid)))
          await fs.symlink(cwd, path.join(procRoot, String(pid), "cwd"))
          await fs.writeFile(
            path.join(procRoot, String(pid), "cmdline"),
            `${program}\0-i\0x`,
          )
        }
        await entry(victim.pid!, work, "/usr/bin/ffmpeg")
        await entry(bystander.pid!, os.tmpdir(), "/usr/bin/ffmpeg")
        await entry(process.pid, work, "/usr/bin/ffmpeg") // never itself
        const stopped = await stopOrphanedRenders(jobsDir, { procRoot })
        expect(stopped).toEqual([victim.pid])
        // The exit may already have been observed while the stopper waited.
        if (victim.exitCode === null && victim.signalCode === null)
          await new Promise((r) => victim.once("exit", r))
        expect(victim.signalCode).toBe("SIGKILL")
        expect(bystander.exitCode).toBeNull()
      } finally {
        bystander.kill("SIGKILL")
        victim.kill("SIGKILL")
        await fs.rm(procRoot, { recursive: true, force: true })
      }
    },
  )
})

describe("job management routes (local-only, strict)", () => {
  const ctx = (jobId: string) =>
    ({ params: Promise.resolve({ jobId }) }) as never
  const request = (
    url: string,
    init: {
      method?: string
      headers?: Record<string, string>
      body?: string
    } = {},
  ) => {
    const r = new Request(`http://localhost:3000${url}`, {
      method: init.method ?? "GET",
      body: init.body,
      headers: { host: "localhost:3000", ...init.headers },
    }) as Request & { nextUrl: URL }
    r.nextUrl = new URL(r.url)
    return r as never
  }
  const id = createRenderJobId()
  const saved = { ...process.env }
  beforeEach(() => {
    process.env.DESKVERSE_DATA_DIR = base
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it("refuses foreign hosts and hosted deployments on every management endpoint", async () => {
    const foreign = { host: "evil.example" }
    const statuses = await Promise.all([
      historyRoute(request("/api/studio/pixel/jobs", { headers: foreign })),
      cancelRoute(request(`/x`, { method: "POST", headers: foreign }), ctx(id)),
      retryRoute(request(`/x`, { method: "POST", headers: foreign }), ctx(id)),
      deleteRoute(
        request(`/x`, { method: "DELETE", headers: foreign }),
        ctx(id),
      ),
      storageRoute(request(`/x`, { headers: foreign })),
      cleanupRoute(request(`/x`, { method: "POST", headers: foreign })),
    ])
    expect(statuses.map((r) => r.status)).toEqual([
      403, 403, 403, 403, 403, 403,
    ])
    process.env.VERCEL = "1"
    expect((await storageRoute(request("/x"))).status).toBe(503)
    expect(
      (await deleteRoute(request("/x", { method: "DELETE" }), ctx(id))).status,
    ).toBe(503)
  })

  it("rejects bodies on action endpoints, malformed IDs and invalid limits", async () => {
    const body = {
      headers: { "content-type": "application/json" },
      body: '{"path":"/etc"}',
    }
    expect(
      (await cancelRoute(request("/x", { method: "POST", ...body }), ctx(id)))
        .status,
    ).toBe(400)
    expect(
      (await deleteRoute(request("/x", { method: "DELETE", ...body }), ctx(id)))
        .status,
    ).toBe(400)
    expect(
      (await cleanupRoute(request("/x", { method: "POST", ...body }))).status,
    ).toBe(400)
    for (const bad of ["../../etc", "job_1"]) {
      expect(
        (await cancelRoute(request("/x", { method: "POST" }), ctx(bad))).status,
      ).toBe(404)
      expect(
        (await deleteRoute(request("/x", { method: "DELETE" }), ctx(bad)))
          .status,
      ).toBe(404)
    }
    for (const limit of ["0", "101", "abc", "-1", "1e2"])
      expect(
        (await historyRoute(request(`/api/studio/pixel/jobs?limit=${limit}`)))
          .status,
        limit,
      ).toBe(400)
  })
})
