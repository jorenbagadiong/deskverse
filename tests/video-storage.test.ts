import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createRenderJobId } from "@/lib/video/ids"
import type { RenderOutput } from "@/lib/video/render-job"
import { MEDIA_LIMITS } from "@/lib/video/validation"
import { readImageDimensions, sniffImageType } from "@/server/video/image-sniff"
import {
  createVideoStorage,
  resolveDataRoot,
  resolveInside,
  StorageError,
  type VideoStorage,
} from "@/server/video/storage"

// --- Minimal image headers (enough for sniffing and dimension parsing) ------

function png(width: number, height: number) {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  b.set([0x49, 0x48, 0x44, 0x52], 12) // IHDR
  const view = new DataView(b.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return b
}

function jpeg(width: number, height: number) {
  return new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0, // APP0 (JFIF)
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xd9,
  ])
}

function webpVp8x(width: number, height: number) {
  const b = new Uint8Array(30)
  b.set([
    ...Buffer.from("RIFF"),
    22,
    0,
    0,
    0,
    ...Buffer.from("WEBPVP8X"),
    10,
    0,
    0,
    0,
  ])
  const w = width - 1
  const h = height - 1
  b.set(
    [
      w & 0xff,
      (w >> 8) & 0xff,
      (w >> 16) & 0xff,
      h & 0xff,
      (h >> 8) & 0xff,
      (h >> 16) & 0xff,
    ],
    24,
  )
  return b
}

const renderOutput = (sizeBytes: number): RenderOutput => ({
  fileName: "video.mp4",
  sizeBytes,
  durationSeconds: 15,
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: "h264",
  pixelFormat: "yuv420p",
  encoder: "libx264",
  renderSeconds: 4.2,
  audio: null,
})

const upload = (
  bytes: Uint8Array,
  declaredType = "image/png",
  fileName = "shot.png",
) => ({
  bytes,
  declaredType,
  fileName,
})

async function expectStorageError(
  promise: Promise<unknown>,
  code: StorageError["code"],
) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof StorageError && error.code === code,
  )
}

// ---------------------------------------------------------------------------

describe("data directory", () => {
  const home = "/home/ada"
  const projectRoot = "/home/ada/projects/deskverse"

  it("uses the XDG data directory on Linux and WSL", () => {
    expect(
      resolveDataRoot({
        env: {},
        platform: "linux",
        homedir: home,
        projectRoot,
      }),
    ).toBe("/home/ada/.local/share/deskverse")
    expect(
      resolveDataRoot({
        env: { XDG_DATA_HOME: "/data/xdg" },
        platform: "linux",
        homedir: home,
        projectRoot,
      }),
    ).toBe("/data/xdg/deskverse")
    // A relative XDG_DATA_HOME is invalid per the spec and ignored.
    expect(
      resolveDataRoot({
        env: { XDG_DATA_HOME: "rel" },
        platform: "linux",
        homedir: home,
        projectRoot,
      }),
    ).toBe("/home/ada/.local/share/deskverse")
  })

  it("uses the conventional app-data folders on macOS and Windows", () => {
    expect(
      resolveDataRoot({
        env: {},
        platform: "darwin",
        homedir: "/Users/ada",
        projectRoot,
      }),
    ).toBe("/Users/ada/Library/Application Support/Deskverse")
    expect(
      resolveDataRoot({
        env: { LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" },
        platform: "win32",
        homedir: "C:\\Users\\ada",
        projectRoot: "C:\\code\\deskverse",
      }),
    ).toBe("C:\\Users\\ada\\AppData\\Local\\Deskverse")
  })

  it("honours an absolute DESKVERSE_DATA_DIR override", () => {
    expect(
      resolveDataRoot({
        env: { DESKVERSE_DATA_DIR: "/mnt/fast/dv/" },
        platform: "linux",
        homedir: home,
        projectRoot,
      }),
    ).toBe("/mnt/fast/dv")
    expect(() =>
      resolveDataRoot({
        env: { DESKVERSE_DATA_DIR: "data" },
        platform: "linux",
        homedir: home,
        projectRoot,
      }),
    ).toThrow(StorageError)
  })

  it("refuses any location inside the project (so nothing lands in public/ or git)", () => {
    for (const dir of [
      projectRoot,
      `${projectRoot}/public/uploads`,
      `${projectRoot}/.data`,
      `${projectRoot}/x/../public`,
    ])
      expect(
        () =>
          resolveDataRoot({
            env: { DESKVERSE_DATA_DIR: dir },
            platform: "linux",
            homedir: home,
            projectRoot,
          }),
        dir,
      ).toThrow(/outside the project/)
    // Default location, if the "home" were the project itself.
    expect(() =>
      resolveDataRoot({
        env: { XDG_DATA_HOME: `${projectRoot}/share` },
        platform: "linux",
        homedir: home,
        projectRoot,
      }),
    ).toThrow(/outside the project/)
    // A sibling folder whose name merely starts with the project name is fine.
    expect(
      resolveDataRoot({
        env: { DESKVERSE_DATA_DIR: `${projectRoot}-data` },
        platform: "linux",
        homedir: home,
        projectRoot,
      }),
    ).toBe(`${projectRoot}-data`)
  })
})

describe("path safety", () => {
  it("joins safe segments inside the base", () => {
    expect(resolveInside("/data/jobs", "job_x", "assets", "a.png")).toBe(
      "/data/jobs/job_x/assets/a.png",
    )
  })

  it("rejects traversal, separators, absolute and odd segments", () => {
    for (const bad of [
      "..",
      ".",
      "",
      "a/b",
      "a\\b",
      "/etc",
      "..\\x",
      "a\0b",
      ".hidden",
      "trailing.",
      "a..b",
      "C:",
    ])
      expect(
        () => resolveInside("/data/jobs", bad),
        JSON.stringify(bad),
      ).toThrow(StorageError)
  })

  it("never returns the base itself", () => {
    expect(() => resolveInside("/data/jobs")).toThrow(StorageError)
  })
})

describe("image sniffing", () => {
  it("identifies images by their bytes", () => {
    expect(sniffImageType(png(10, 10))).toBe("image/png")
    expect(sniffImageType(jpeg(10, 10))).toBe("image/jpeg")
    expect(sniffImageType(webpVp8x(10, 10))).toBe("image/webp")
  })

  it("rejects everything else, whatever it is called", () => {
    for (const text of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "<!doctype html><html>",
      "GIF89a",
      "MZ\x90\x00", // Windows executable
      "PK\x03\x04", // zip
      "",
    ])
      expect(sniffImageType(new TextEncoder().encode(text)), text).toBeNull()
  })

  it("reads dimensions from headers", () => {
    expect(readImageDimensions(png(1080, 1920), "image/png")).toEqual({
      width: 1080,
      height: 1920,
    })
    expect(readImageDimensions(jpeg(1600, 1200), "image/jpeg")).toEqual({
      width: 1600,
      height: 1200,
    })
    expect(readImageDimensions(webpVp8x(4000, 3000), "image/webp")).toEqual({
      width: 4000,
      height: 3000,
    })
  })

  it("gives up on truncated or malformed headers", () => {
    expect(
      readImageDimensions(png(10, 10).slice(0, 20), "image/png"),
    ).toBeNull()
    expect(
      readImageDimensions(
        new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        "image/jpeg",
      ),
    ).toBeNull()
    expect(
      readImageDimensions(
        new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00]),
        "image/jpeg",
      ),
    ).toBeNull()
    expect(
      readImageDimensions(webpVp8x(10, 10).slice(0, 20), "image/webp"),
    ).toBeNull()
  })
})

describe("local job storage", () => {
  let base: string
  let storage: VideoStorage

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-storage-"))
    storage = createVideoStorage(base)
  })

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true })
  })

  it("requires an absolute root", () => {
    expect(() => createVideoStorage("relative/dir")).toThrow(StorageError)
  })

  it("creates an isolated, private job directory named by a generated ID", async () => {
    const job = await storage.createJob()
    expect(job.state).toBe("draft")
    const dir = path.join(base, "video", "jobs", job.id)
    expect((await fs.readdir(dir)).sort()).toEqual([
      "assets",
      "job.json",
      "output",
      "work",
    ])
    if (process.platform !== "win32") {
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700)
      expect((await fs.stat(path.join(dir, "job.json"))).mode & 0o777).toBe(
        0o600,
      )
    }
    expect(await storage.readJob(job.id)).toEqual(job)
    const other = await storage.createJob()
    expect(other.id).not.toBe(job.id)
  })

  it("stores uploads under generated names, never the user's file name", async () => {
    const job = await storage.createJob()
    const asset = await storage.addImageAsset(
      job.id,
      upload(png(1080, 1920), "image/png", "../../../evil.png"),
    )
    expect(asset).toMatchObject({
      kind: "image",
      mimeType: "image/png",
      width: 1080,
      height: 1920,
      displayName: "evil.png",
    })
    const files = await fs.readdir(
      path.join(base, "video", "jobs", job.id, "assets"),
    )
    expect(files).toEqual([`${asset.id}.png`])
    expect((await storage.readJob(job.id)).assets).toEqual([asset])
    const assetPath = await storage.assetPath(job.id, asset.id)
    expect(assetPath).toBe(
      path.join(base, "video", "jobs", job.id, "assets", `${asset.id}.png`),
    )
    // Nothing was written outside the storage root.
    await expect(fs.access(path.join(base, "..", "evil.png"))).rejects.toThrow()
  })

  it("doesn't depend on the client's file name or extension (display only)", async () => {
    const job = await storage.createJob()
    for (const fileName of ["image", "", "photo.jpeg", "no-extension"]) {
      const asset = await storage.addImageAsset(
        job.id,
        upload(png(1080, 1920), "image/png", fileName),
      )
      expect(asset.mimeType).toBe("image/png")
      expect(
        await fs.readdir(path.join(base, "video", "jobs", job.id, "assets")),
      ).toContain(`${asset.id}.png`)
    }
  })

  it("rejects files whose bytes don't match a supported image type", async () => {
    const job = await storage.createJob()
    const svg = new TextEncoder().encode("<svg onload=alert(1)>")
    await expectStorageError(
      storage.addImageAsset(job.id, upload(svg, "image/png", "x.png")),
      "invalid-upload",
    )
    // A real JPEG declared as PNG is refused too.
    await expectStorageError(
      storage.addImageAsset(job.id, upload(jpeg(800, 800), "image/png")),
      "invalid-upload",
    )
    await expectStorageError(
      storage.addImageAsset(job.id, upload(new Uint8Array())),
      "invalid-upload",
    )
    expect((await storage.readJob(job.id)).assets).toEqual([])
  })

  it("rejects oversized, undersized and excess images", async () => {
    const job = await storage.createJob()
    const huge = new Uint8Array(MEDIA_LIMITS.maxBytes + 1)
    huge.set(png(1080, 1920))
    await expectStorageError(
      storage.addImageAsset(job.id, upload(huge)),
      "invalid-upload",
    )
    await expectStorageError(
      storage.addImageAsset(job.id, upload(png(100, 100))),
      "invalid-upload",
    )
    for (let i = 0; i < MEDIA_LIMITS.maxCount; i++)
      await storage.addImageAsset(job.id, upload(png(1080, 1920)))
    await expectStorageError(
      storage.addImageAsset(job.id, upload(png(1080, 1920))),
      "too-many-assets",
    )
  })

  it("serializes concurrent uploads to one job", async () => {
    const job = await storage.createJob()
    await Promise.all(
      Array.from({ length: 4 }, () =>
        storage.addImageAsset(job.id, upload(png(1080, 1920))),
      ),
    )
    expect((await storage.readJob(job.id)).assets).toHaveLength(4)
  })

  it("refuses invalid and unknown job IDs", async () => {
    for (const bad of ["../../etc", "job_../x", "", `job_${"a".repeat(32)}/..`])
      await expectStorageError(storage.readJob(bad), "invalid-id")
    await expectStorageError(storage.readJob(createRenderJobId()), "not-found")
    const job = await storage.createJob()
    await expectStorageError(
      storage.assetPath(job.id, "../job.json"),
      "invalid-id",
    )
  })

  it("enforces job state transitions", async () => {
    const job = await storage.createJob()
    await expectStorageError(
      storage.transitionJob(job.id, "completed"),
      "invalid-state",
    )
    await storage.transitionJob(job.id, "queued")
    await expectStorageError(
      storage.addImageAsset(job.id, upload(png(1080, 1920))),
      "invalid-state",
    )
    await storage.transitionJob(job.id, "rendering")
    const failed = await storage.transitionJob(job.id, "failed", {
      error: { code: "render-failed", message: "FFmpeg exited with an error." },
    })
    expect(failed.error?.code).toBe("render-failed")
    const retried = await storage.transitionJob(job.id, "queued")
    expect(retried.error).toBeNull()
  })

  it("only hands out a completed output that is a real file inside storage", async () => {
    const job = await storage.createJob()
    expect(await storage.resolveCompletedOutput(job.id)).toBeNull()
    const output = path.join(
      base,
      "video",
      "jobs",
      job.id,
      "output",
      "video.mp4",
    )
    await fs.writeFile(output, "fake mp4")
    // Not completed yet: still nothing.
    expect(await storage.resolveCompletedOutput(job.id)).toBeNull()
    await storage.transitionJob(job.id, "queued")
    await storage.transitionJob(job.id, "rendering")
    await storage.transitionJob(job.id, "completed", {
      output: renderOutput(8),
    })
    expect(await storage.resolveCompletedOutput(job.id)).toEqual({
      path: output,
      sizeBytes: 8,
    })
  })

  it.skipIf(process.platform === "win32")(
    "refuses symlinks that point outside storage",
    async () => {
      const outside = path.join(base, "outside-secret.txt")
      await fs.writeFile(outside, "secret")

      // A completed output replaced by a link to another file.
      const job = await storage.createJob()
      for (const state of ["queued", "rendering"] as const)
        await storage.transitionJob(job.id, state)
      await storage.transitionJob(job.id, "completed", {
        output: renderOutput(6),
      })
      await fs.symlink(
        outside,
        path.join(base, "video", "jobs", job.id, "output", "video.mp4"),
      )
      await expectStorageError(
        storage.resolveCompletedOutput(job.id),
        "unsafe-path",
      )

      // A job directory that is itself a link.
      const fakeId = createRenderJobId()
      const elsewhere = await fs.mkdtemp(
        path.join(os.tmpdir(), "deskverse-elsewhere-"),
      )
      try {
        await fs.symlink(elsewhere, path.join(base, "video", "jobs", fakeId))
        await expectStorageError(storage.readJob(fakeId), "unsafe-path")
      } finally {
        await fs.rm(elsewhere, { recursive: true, force: true })
      }
    },
  )

  it("cleans up temporary files and deletes jobs", async () => {
    const job = await storage.createJob()
    const work = path.join(base, "video", "jobs", job.id, "work")
    await fs.writeFile(path.join(work, "frame-0001.png"), "x")
    await storage.cleanupWork(job.id)
    expect(await fs.readdir(work)).toEqual([])
    await storage.deleteJob(job.id)
    await expectStorageError(storage.readJob(job.id), "not-found")
  })

  it("removes stale jobs but never active jobs or unknown folders", async () => {
    let now = new Date("2026-01-01T00:00:00Z")
    const clocked = createVideoStorage(base, { now: () => now })
    const old = await clocked.createJob()
    const active = await clocked.createJob()
    await clocked.transitionJob(active.id, "queued")
    const notOurs = path.join(base, "video", "jobs", "my-notes")
    await fs.mkdir(notOurs)

    now = new Date("2026-01-02T00:00:00Z")
    const fresh = await clocked.createJob()
    const removed = await clocked.cleanupStaleJobs({
      olderThanMs: 12 * 60 * 60 * 1000,
    })

    expect(removed).toEqual([old.id])
    await expectStorageError(clocked.readJob(old.id), "not-found")
    expect((await clocked.readJob(active.id)).state).toBe("queued")
    expect((await clocked.readJob(fresh.id)).state).toBe("draft")
    await expect(fs.access(notOurs)).resolves.toBeUndefined()
  })

  it("rejects tampered metadata", async () => {
    const job = await storage.createJob()
    const file = path.join(base, "video", "jobs", job.id, "job.json")
    await fs.writeFile(
      file,
      JSON.stringify({ ...job, id: createRenderJobId() }),
    )
    await expectStorageError(storage.readJob(job.id), "corrupt-metadata")
    await fs.writeFile(file, "{ not json")
    await expectStorageError(storage.readJob(job.id), "corrupt-metadata")
  })
})
