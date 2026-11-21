import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { FfmpegCapabilityReport } from "@/lib/video/capabilities"
import { createAssetId } from "@/lib/video/ids"
import type {
  RenderJob,
  RenderOutput,
  RenderProgress,
} from "@/lib/video/render-job"
import type { ProductInfo } from "@/lib/video/types"
import type {
  Runner,
  SpawnOptions,
  Spawner,
} from "@/server/process/run-executable"
import { fontDirectory, loadVideoFont } from "@/server/video/font-metrics"
import { buildTrustedProject } from "@/server/video/project"
import {
  MAX_WAITING,
  QueueError,
  RenderQueue,
} from "@/server/video/render-queue"
import {
  RenderFailure,
  renderVideo,
  type RenderDeps,
} from "@/server/video/render-service"
import {
  createVideoStorage,
  StorageError,
  type VideoStorage,
} from "@/server/video/storage"
import { createUploadVerifier } from "@/server/video/upload-verify"

const fonts = { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") }

/** One `framecrc` line: what a successful single-frame test decode prints. */
const FRAME_LINE = "0,          0,          0,        1,  1749600, 0x1f2e3d4c\n"

function png(width: number, height: number) {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  b.set([0x49, 0x48, 0x44, 0x52], 12)
  const view = new DataView(b.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return b
}

const product: ProductInfo = {
  name: "Trailblazer travel mug",
  headline: "Hot coffee for 12 hours",
  benefits: ["Leak-proof lid", "Fits every cup holder"],
  callToAction: "Tap the link to shop",
  disclosure: "#ad · I may earn a commission.",
}

const READY: FfmpegCapabilityReport = {
  status: "ready",
  checkedAt: "2026-11-21T00:00:00.000Z",
  ffmpeg: { available: true, version: "6.1.1", problem: null },
  ffprobe: { available: true, version: "6.1.1", problem: null },
  filters: [],
  h264Encoders: [{ name: "libx264", hardware: false, works: true }],
  selectedH264Encoder: "libx264",
  aacEncoder: "aac",
  audio: { ready: true, missingFilters: [], reason: null },
  license: "gpl",
  issues: [],
}

const OUTPUT: RenderOutput = {
  fileName: "video.mp4",
  sizeBytes: 1000,
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

let base: string
let storage: VideoStorage

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-pipeline-"))
  storage = createVideoStorage(base)
})

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

/** A draft job with `count` uploaded (header-only) PNGs. */
async function draftWithImages(count = 3) {
  const job = await storage.createJob()
  for (let i = 0; i < count; i++)
    await storage.addImageAsset(job.id, {
      bytes: png(1080, 1920),
      declaredType: "image/png",
      fileName: `shot-${i}.png`,
    })
  return storage.readJob(job.id)
}

/** A queued-ready job with a stored, server-built project. */
async function preparedJob() {
  const job = await draftWithImages()
  const project = buildTrustedProject(
    job,
    { product, assetIds: job.assets.map((a) => a.id) },
    fonts,
  )
  if (!project.ok) throw new Error(JSON.stringify(project.issues))
  await storage.writeProject(job.id, project.value)
  return { job, project: project.value }
}

// ---------------------------------------------------------------------------

describe("server-side project reconstruction", () => {
  it("rebuilds the storyboard from validated text and this job's images", async () => {
    const job = await draftWithImages()
    const ids = job.assets.map((a) => a.id)
    const result = buildTrustedProject(
      job,
      { product, assetIds: [ids[2], ids[0], ids[1]] },
      fonts,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.assets.map((a) => a.id)).toEqual([
      ids[2],
      ids[0],
      ids[1],
    ])
    expect(result.value.scenes[0]).toMatchObject({
      kind: "hook",
      assetId: ids[2],
    })
    expect(
      result.value.scenes.reduce((n, s) => n + s.durationFrames, 0),
    ).toBeGreaterThanOrEqual(450)
    expect(result.value.settings.width).toBe(1080)
  })

  it("rejects client storyboards, timings and encoder options", async () => {
    const job = await draftWithImages()
    const assetIds = job.assets.map((a) => a.id)
    for (const extra of [
      { scenes: [{ durationFrames: 9000 }] },
      { settings: { width: 4096 } },
      { ffmpegArgs: ["-i", "/etc/passwd"] },
      { outputPath: "/tmp/x.mp4" },
    ]) {
      const result = buildTrustedProject(
        job,
        { product, assetIds, ...extra },
        fonts,
      )
      expect(result.ok, JSON.stringify(extra)).toBe(false)
      if (!result.ok)
        expect(result.issues[0].message).toMatch(/decided by the server/)
    }
  })

  it("rejects images from another job, duplicates and too few images", async () => {
    const job = await draftWithImages()
    const other = await draftWithImages()
    const ids = job.assets.map((a) => a.id)
    const cross = buildTrustedProject(
      job,
      { product, assetIds: [ids[0], ids[1], other.assets[0].id] },
      fonts,
    )
    expect(cross.ok).toBe(false)
    if (!cross.ok)
      expect(cross.issues).toEqual([
        {
          path: "assetIds.2",
          message: "That image wasn't uploaded to this video.",
        },
      ])
    expect(
      buildTrustedProject(
        job,
        { product, assetIds: [ids[0], ids[0], ids[1]] },
        fonts,
      ).ok,
    ).toBe(false)
    expect(
      buildTrustedProject(job, { product, assetIds: ids.slice(0, 2) }, fonts)
        .ok,
    ).toBe(false)
    expect(
      buildTrustedProject(
        job,
        { product, assetIds: [...ids, "../../job.json"] },
        fonts,
      ).ok,
    ).toBe(false)
    expect(
      buildTrustedProject(
        job,
        { product, assetIds: [createAssetId(), ...ids.slice(1)] },
        fonts,
      ).ok,
    ).toBe(false)
  })

  it("re-validates product text and rejects characters the font can't draw", async () => {
    const job = await draftWithImages()
    const assetIds = job.assets.map((a) => a.id)
    expect(
      buildTrustedProject(
        job,
        { product: { ...product, headline: "" }, assetIds },
        fonts,
      ).ok,
    ).toBe(false)
    expect(
      buildTrustedProject(
        job,
        { product: { ...product, name: "x".repeat(61) }, assetIds },
        fonts,
      ).ok,
    ).toBe(false)
    const emoji = buildTrustedProject(
      job,
      { product: { ...product, callToAction: "Shop now ☕" }, assetIds },
      fonts,
    )
    expect(emoji.ok).toBe(false)
    if (!emoji.ok) {
      expect(emoji.issues[0].path).toBe("product.callToAction")
      expect(emoji.issues[0].message).toMatch(/can't draw \(☕\)/)
    }
  })

  it("rejects non-object requests", async () => {
    const job = await draftWithImages()
    for (const body of [null, [], "render", 42])
      expect(buildTrustedProject(job, body, fonts).ok).toBe(false)
  })
})

describe("project storage", () => {
  it("stores the project once, then refuses rewrites after queueing", async () => {
    const { job, project } = await preparedJob()
    expect(await storage.readProject(job.id)).toEqual(project)
    await storage.transitionJob(job.id, "queued")
    await expect(storage.writeProject(job.id, project)).rejects.toMatchObject({
      code: "invalid-state",
    })
  })

  it("refuses a project.json tampered to point at another job's image", async () => {
    const { job, project } = await preparedJob()
    const other = await draftWithImages()
    const tampered = {
      ...project,
      assets: [other.assets[0], ...project.assets.slice(1)],
    }
    await fs.writeFile(
      path.join(storage.root, "jobs", job.id, "project.json"),
      JSON.stringify(tampered),
    )
    await expect(storage.readProject(job.id)).rejects.toMatchObject({
      code: "corrupt-metadata",
    })
  })

  it("runs the upload verifier and discards files it rejects", async () => {
    const job = await storage.createJob()
    const failingRun: Runner = async () => ({
      ok: false,
      reason: "failed",
      exitCode: 1,
    })
    await expect(
      storage.addImageAsset(
        job.id,
        {
          bytes: png(1080, 1920),
          declaredType: "image/png",
          fileName: "bad.png",
        },
        {
          verify: createUploadVerifier(failingRun, {
            ffmpeg: "ffmpeg",
            ffprobe: "ffprobe",
          }),
        },
      ),
    ).rejects.toMatchObject({
      code: "invalid-upload",
      message: expect.stringMatching(/couldn't be verified/),
    })
    expect((await storage.readJob(job.id)).assets).toEqual([])
    expect(
      await fs.readdir(path.join(storage.root, "jobs", job.id, "assets")),
    ).toEqual([])
  })

  it("treats any decode error output as a damaged image", async () => {
    const job = await storage.createJob()
    const run: Runner = async (_command, args) =>
      args.includes("-show_entries")
        ? {
            ok: true,
            stdout: JSON.stringify({
              streams: [{ codec_name: "png", width: 1080, height: 1920 }],
            }),
            stderr: "",
          }
        : {
            ok: true,
            // A frame came out, but the decoder reported a real error.
            stdout: FRAME_LINE,
            stderr: "[png @ 0x1] IDAT: invalid code lengths set\n",
          }
    await expect(
      storage.addImageAsset(
        job.id,
        {
          bytes: png(1080, 1920),
          declaredType: "image/png",
          fileName: "broken.png",
        },
        {
          verify: createUploadVerifier(run, {
            ffmpeg: "ffmpeg",
            ffprobe: "ffprobe",
          }),
        },
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/doesn't decode cleanly/),
    })
  })
})

describe("WebP uploads with metadata-only decoder notices", () => {
  /** Header-only WebP (VP8X): enough for byte sniffing and dimensions. */
  function webp(width: number, height: number) {
    const b = new Uint8Array(30)
    const text = (at: number, value: string) =>
      [...value].forEach((c, i) => (b[at + i] = c.charCodeAt(0)))
    text(0, "RIFF")
    new DataView(b.buffer).setUint32(4, 22, true)
    text(8, "WEBPVP8X")
    b[16] = 10
    b[20] = 0x08 // EXIF flag
    const put24 = (at: number, v: number) => {
      b[at] = v & 0xff
      b[at + 1] = (v >> 8) & 0xff
      b[at + 2] = (v >> 16) & 0xff
    }
    put24(24, width - 1)
    put24(27, height - 1)
    return b
  }

  const fakeFfmpeg =
    (decode: Awaited<ReturnType<Runner>>): Runner =>
    async (_command, args) =>
      args.includes("-show_entries")
        ? {
            ok: true,
            stdout: JSON.stringify({
              streams: [{ codec_name: "webp", width: 1080, height: 1080 }],
            }),
            stderr: "",
          }
        : decode

  async function upload(decode: Awaited<ReturnType<Runner>>) {
    const job = await storage.createJob()
    return storage.addImageAsset(
      job.id,
      {
        bytes: webp(1080, 1080),
        declaredType: "image/webp",
        fileName: "ph-11134207.webp",
      },
      {
        verify: createUploadVerifier(fakeFfmpeg(decode), {
          ffmpeg: "ffmpeg",
          ffprobe: "ffprobe",
        }),
      },
    )
  }

  const NOTICE =
    "[webp @ 0x592d434ec1c0] invalid TIFF header in Exif data\n[webp @ 0x592d434f3080] invalid TIFF header in Exif data\n"

  it("accepts a WebP whose only stderr is FFmpeg's Exif-prefix notice", async () => {
    const asset = await upload({ ok: true, stdout: FRAME_LINE, stderr: NOTICE })
    expect(asset).toMatchObject({ mimeType: "image/webp", width: 1080 })
  })

  it("still rejects it when a real decoding error comes with the notice", async () => {
    await expect(
      upload({
        ok: true,
        stdout: FRAME_LINE,
        stderr: `${NOTICE}[webp @ 0x1] Not enough data for the frame\n`,
      }),
    ).rejects.toMatchObject({
      code: "invalid-upload",
      message:
        "“ph-11134207.webp” couldn't be verified: it doesn't decode cleanly (the file may be damaged).",
    })
  })

  it("rejects a failed or frameless decode, notice or not", async () => {
    await expect(
      upload({ ok: false, reason: "failed", exitCode: 69 }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/FFmpeg stopped with a decoding error/),
    })
    await expect(
      upload({ ok: true, stdout: "", stderr: NOTICE }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/couldn't decode a picture/),
    })
  })
})

describe("render queue", () => {
  it("renders one job at a time and completes it with the verified output", async () => {
    let running = 0
    let maxRunning = 0
    const queue = new RenderQueue(storage, async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await new Promise((r) => setTimeout(r, 20))
      running--
      return OUTPUT
    })
    const jobs = [await preparedJob(), await preparedJob(), await preparedJob()]
    for (const { job } of jobs) await queue.enqueue(job.id)
    // The first job is already being prepared; the others wait in order.
    expect(queue.progressOf(jobs[0].job.id)).toEqual({ phase: "preparing" })
    expect(queue.progressOf(jobs[1].job.id)).toEqual({
      phase: "waiting",
      position: 1,
    })
    expect(queue.progressOf(jobs[2].job.id)).toEqual({
      phase: "waiting",
      position: 2,
    })
    await queue.whenIdle()
    expect(maxRunning).toBe(1)
    for (const { job } of jobs) {
      const done = await storage.readJob(job.id)
      expect(done.state).toBe("completed")
      expect(done.output).toEqual(OUTPUT)
    }
  })

  it("refuses duplicate starts and jobs that aren't drafts", async () => {
    let release!: () => void
    const queue = new RenderQueue(
      storage,
      () => new Promise((r) => (release = () => r(OUTPUT))),
    )
    const { job } = await preparedJob()
    await queue.enqueue(job.id)
    await expect(queue.enqueue(job.id)).rejects.toBeInstanceOf(QueueError)
    await new Promise((r) => setTimeout(r, 10))
    release()
    await queue.whenIdle()
    await expect(queue.enqueue(job.id)).rejects.toBeInstanceOf(StorageError)
  })

  it("bounds the number of waiting jobs", async () => {
    const pending: (() => void)[] = []
    const queue = new RenderQueue(
      storage,
      () => new Promise((r) => pending.push(() => r(OUTPUT))),
    )
    const first = await preparedJob()
    await queue.enqueue(first.job.id)
    await new Promise((r) => setTimeout(r, 10)) // first is now rendering
    for (let i = 0; i < MAX_WAITING; i++)
      await queue.enqueue((await preparedJob()).job.id)
    const overflow = await preparedJob()
    await expect(queue.enqueue(overflow.job.id)).rejects.toMatchObject({
      code: "busy",
    })
    expect((await storage.readJob(overflow.job.id)).state).toBe("draft")
    while (queue.isBusy() || pending.length) {
      pending.shift()?.()
      await new Promise((r) => setTimeout(r, 5))
    }
    await queue.whenIdle()
  })

  it("marks failures with the renderer's message and never completes them", async () => {
    const queue = new RenderQueue(storage, async () => {
      throw new RenderFailure(
        "render-failed",
        "The libx264 encoder failed while encoding the video.",
      )
    })
    const { job } = await preparedJob()
    await queue.enqueue(job.id)
    await queue.whenIdle()
    const failed = await storage.readJob(job.id)
    expect(failed.state).toBe("failed")
    expect(failed.output).toBeNull()
    expect(failed.error).toEqual({
      code: "render-failed",
      message: "The libx264 encoder failed while encoding the video.",
    })
    expect(await storage.resolveCompletedOutput(job.id)).toBeNull()
  })

  it("hides unexpected errors behind a generic message", async () => {
    const queue = new RenderQueue(
      storage,
      async () => {
        throw new Error("ENOENT /home/someone/secret/path")
      },
      () => {},
    )
    const { job } = await preparedJob()
    await queue.enqueue(job.id)
    await queue.whenIdle()
    const failed = await storage.readJob(job.id)
    expect(failed.error?.message).not.toContain("/home")
    expect(failed.error?.code).toBe("render-failed")
  })

  it("marks jobs interrupted by a server restart as failed, not completed", async () => {
    const queued = await preparedJob()
    await storage.transitionJob(queued.job.id, "queued")
    const rendering = await preparedJob()
    await storage.transitionJob(rendering.job.id, "queued")
    await storage.transitionJob(rendering.job.id, "rendering")
    // A half-written output from the crashed process must not survive.
    await fs.writeFile(
      path.join(storage.root, "jobs", rendering.job.id, "output", "video.mp4"),
      "partial",
    )
    const draft = await preparedJob()

    const restarted = new RenderQueue(storage, async () => OUTPUT)
    expect((await restarted.recover()).sort()).toEqual(
      [queued.job.id, rendering.job.id].sort(),
    )
    for (const id of [queued.job.id, rendering.job.id]) {
      const job = await storage.readJob(id)
      expect(job.state).toBe("failed")
      expect(job.error?.code).toBe("interrupted")
    }
    await expect(
      fs.access(
        path.join(
          storage.root,
          "jobs",
          rendering.job.id,
          "output",
          "video.mp4",
        ),
      ),
    ).rejects.toThrow()
    expect((await storage.readJob(draft.job.id)).state).toBe("draft")
  })
})

describe("render service (mocked FFmpeg)", () => {
  /** Fake FFmpeg: scene commands write a PNG, the encode writes render.mp4 and reports progress. */
  function fakeSpawn({ encodeFails = false } = {}): Spawner & {
    calls: string[][]
  } {
    const calls: string[][] = []
    const spawn = (async (
      _command: string,
      args: readonly string[],
      options: SpawnOptions,
    ) => {
      calls.push([...args])
      const out = args.at(-1)!.replace(/^file:/, "")
      if (args.includes("-progress")) {
        if (encodeFails)
          return {
            ok: false,
            reason: "failed",
            exitCode: 1,
            stderrTail: "x264 [error]",
          }
        options.onStdout?.("out_time_us=7500000\nprogress=continue\n")
        options.onStdout?.("out_time_us=15000000\nprogress=end\n")
      }
      await fs.writeFile(path.join(options.cwd, out), "fake")
      return { ok: true, stderrTail: "" }
    }) as Spawner & { calls: string[][] }
    spawn.calls = calls
    return spawn
  }

  const probeJson = (patch: object = {}) =>
    JSON.stringify({
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1080,
          height: 1920,
          pix_fmt: "yuv420p",
          r_frame_rate: "30/1",
          avg_frame_rate: "30/1",
          ...patch,
        },
      ],
      format: {
        format_name: "mov,mp4",
        duration: "15.000",
        size: "4",
        tags: { major_brand: "isom" },
      },
    })

  function deps(overrides: Partial<RenderDeps> = {}): RenderDeps {
    return {
      storage,
      spawn: fakeSpawn(),
      run: async () => ({ ok: true, stdout: probeJson(), stderr: "" }),
      getCapabilities: async () => READY,
      commands: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
      fonts,
      fontDir: fontDirectory(),
      threads: 2,
      timeouts: { sceneMs: 1000, encodeMs: 1000 },
      ...overrides,
    }
  }

  async function rendering() {
    const prepared = await preparedJob()
    await storage.transitionJob(prepared.job.id, "queued")
    await storage.transitionJob(prepared.job.id, "rendering")
    return prepared
  }

  it("normalizes images, composes each scene, encodes segments with real progress, joins, verifies and publishes", async () => {
    const { job, project } = await rendering()
    const spawn = fakeSpawn()
    const progress: RenderProgress[] = []
    const output = await renderVideo(job.id, deps({ spawn }), (p) =>
      progress.push(p),
    )

    // One normalization per image, one still per scene, one segment per
    // scene, then the join.
    const images = new Set(project.scenes.map((s) => s.assetId)).size
    expect(spawn.calls).toHaveLength(images + 2 * project.scenes.length + 1)
    expect(
      spawn.calls.slice(0, images).every((a) => a.includes("-noautorotate")),
    ).toBe(true)
    const join = spawn.calls.at(-1)!
    expect(join).toContain("concat")
    expect(join[join.indexOf("-c") + 1]).toBe("copy")
    expect(output).toMatchObject({
      width: 1080,
      height: 1920,
      fps: 30,
      encoder: "libx264",
      durationSeconds: 15,
    })
    const fractions = progress
      .filter((p) => p.phase === "encoding")
      .map((p) => (p as { fraction: number }).fraction)
    // Monotonic, from 0 to exactly 1, across all segments.
    expect(fractions[0]).toBe(0)
    expect(fractions.at(-1)).toBe(1)
    for (let i = 1; i < fractions.length; i++)
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1])
    expect(progress.at(-1)).toEqual({ phase: "verifying" })
    await storage.transitionJob(job.id, "completed", { output })
    expect(
      await fs.readFile(
        (await storage.resolveCompletedOutput(job.id))!.path,
        "utf8",
      ),
    ).toBe("fake")
    expect(await fs.readdir(await storage.workDir(job.id))).toEqual([])
  })

  it("fails clearly when FFmpeg isn't ready", async () => {
    const { job } = await rendering()
    const missing: FfmpegCapabilityReport = {
      ...READY,
      status: "missing",
      selectedH264Encoder: null,
      issues: [
        {
          code: "ffmpeg-missing",
          severity: "error",
          message: "FFmpeg wasn't found on this computer.",
        },
      ],
    }
    await expect(
      renderVideo(
        job.id,
        deps({ getCapabilities: async () => missing }),
        () => {},
      ),
    ).rejects.toMatchObject({
      code: "ffmpeg-unavailable",
      message: "FFmpeg wasn't found on this computer.",
    })
  })

  it("reports an encoder failure without paths and keeps nothing", async () => {
    const { job } = await rendering()
    const logs: string[] = []
    const failure = renderVideo(
      job.id,
      deps({
        spawn: fakeSpawn({ encodeFails: true }),
        log: (m) => logs.push(m),
      }),
      () => {},
    )
    await expect(failure).rejects.toMatchObject({
      code: "render-failed",
      message: "The libx264 encoder failed while encoding the video.",
    })
    expect(logs.join()).toContain("x264 [error]") // diagnostics stay server-side
    expect(await fs.readdir(await storage.workDir(job.id))).toEqual([])
    expect(
      await fs.readdir(path.join(storage.root, "jobs", job.id, "output")),
    ).toEqual([])
  })

  it("refuses to publish an output that fails FFprobe verification", async () => {
    const { job } = await rendering()
    const run: Runner = async () => ({
      ok: true,
      stdout: probeJson({ width: 720, height: 1280 }),
      stderr: "",
    })
    await expect(
      renderVideo(job.id, deps({ run }), () => {}),
    ).rejects.toMatchObject({
      code: "verification-failed",
      message: expect.stringMatching(/720×1280/),
    })
    expect(
      await fs.readdir(path.join(storage.root, "jobs", job.id, "output")),
    ).toEqual([])
  })

  it("passes the right font and caption files to FFmpeg's working directory", async () => {
    const { job } = await rendering()
    let seen: string[] = []
    const spawn: Spawner = async (_c, args, options) => {
      if (seen.length === 0) seen = (await fs.readdir(options.cwd)).sort()
      return fakeSpawn()(_c, args, options)
    }
    await renderVideo(job.id, deps({ spawn }), () => {})
    expect(seen).toContain("font-bold.ttf")
    expect(seen).toContain("font-medium.ttf")
    expect(seen).toContain("scene-1-caption-1.txt")
    expect(seen.every((name) => /^[a-z0-9-]+\.(ttf|txt)$/.test(name))).toBe(
      true,
    )
  })

  it("only completes through the queue after verification", async () => {
    const queue = new RenderQueue(storage, (id, onProgress) =>
      renderVideo(
        id,
        deps({ spawn: fakeSpawn({ encodeFails: true }) }),
        onProgress,
      ),
    )
    const { job } = await preparedJob()
    await queue.enqueue(job.id)
    await queue.whenIdle()
    const done: RenderJob = await storage.readJob(job.id)
    expect(done.state).toBe("failed")
    expect(done.output).toBeNull()
  })
})
