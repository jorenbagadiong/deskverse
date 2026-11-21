/**
 * Real FFmpeg regression tests for WebP uploads. Run with `yarn test:integration`.
 *
 * Many encoders write a WebP's EXIF chunk with an "Exif\0\0" prefix (the JPEG
 * APP1 convention) instead of raw TIFF. FFmpeg 6.1 then logs "invalid TIFF
 * header in Exif data" at error level but decodes the picture normally. The
 * upload check used to treat any stderr output as damage and rejected such
 * photos. These tests build that exact structure with libwebp, prove FFmpeg
 * really logs the notice and decodes identical pixels, and check that valid
 * variants are accepted while genuinely damaged files are still rejected.
 */
import { execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { FfmpegCapabilityReport } from "@/lib/video/capabilities"
import { STATIC_EFFECTS } from "@/lib/video/effects"
import type { ProductInfo } from "@/lib/video/types"
import { createRunner, spawnTool } from "@/server/process/run-executable"
import { detectFfmpegCapabilities } from "@/server/video/ffmpeg-capabilities"
import { fontDirectory, loadVideoFont } from "@/server/video/font-metrics"
import { buildTrustedProject } from "@/server/video/project"
import { RenderQueue } from "@/server/video/render-queue"
import { renderVideo } from "@/server/video/render-service"
import { createVideoStorage, StorageError } from "@/server/video/storage"
import { createUploadVerifier } from "@/server/video/upload-verify"

const commands = { ffmpeg: "ffmpeg", ffprobe: "ffprobe" }
const fonts = { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") }
const NOTICE = /^\[webp @ 0x[0-9a-f]+\] invalid TIFF header in Exif data$/

let base: string
let capabilities: FfmpegCapabilityReport

function ffmpeg(args: string[]) {
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args], {
    stdio: "ignore",
  })
}

/** Encodes a real WebP with libwebp. */
async function encodeWebp(
  name: string,
  options: string[],
  source = "testsrc2=s=1200x1200",
  pixFmt = "yuv420p",
) {
  const file = path.join(base, name)
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    source,
    "-frames:v",
    "1",
    "-pix_fmt",
    pixFmt,
    "-c:v",
    "libwebp",
    ...options,
    file,
  ])
  return fs.readFile(file)
}

type Chunk = { type: string; data: Buffer }

function chunks(webp: Buffer): Chunk[] {
  const list: Chunk[] = []
  for (let i = 12; i + 8 <= webp.length;) {
    const size = webp.readUInt32LE(i + 4)
    list.push({
      type: webp.toString("latin1", i, i + 4),
      data: webp.subarray(i + 8, i + 8 + size),
    })
    i += 8 + size + (size % 2)
  }
  return list
}

function riff(list: Chunk[]) {
  const body = Buffer.concat([
    Buffer.from("WEBP", "latin1"),
    ...list.map(({ type, data }) => {
      const head = Buffer.alloc(8)
      head.write(type, 0, "latin1")
      head.writeUInt32LE(data.length, 4)
      return Buffer.concat([
        head,
        data,
        data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
      ])
    }),
  ])
  const head = Buffer.alloc(8)
  head.write("RIFF", 0, "latin1")
  head.writeUInt32LE(body.length, 4)
  return Buffer.concat([head, body])
}

/** A little-endian TIFF with one IFD0 entry (Orientation = 1). */
function tiff() {
  const t = Buffer.alloc(26)
  t.write("II", 0, "latin1")
  t.writeUInt16LE(42, 2)
  t.writeUInt32LE(8, 4)
  t.writeUInt16LE(1, 8)
  t.writeUInt16LE(0x0112, 10)
  t.writeUInt16LE(3, 12)
  t.writeUInt32LE(1, 14)
  t.writeUInt16LE(1, 18)
  return t
}

/**
 * Turns a simple lossy WebP into the extended format with an EXIF chunk,
 * like the reported photo: VP8X (EXIF flag), VP8, EXIF.
 */
function withExif(
  simple: Buffer,
  prefixed: boolean,
  width = 1200,
  height = 1200,
) {
  const vp8 = chunks(simple).find((c) => c.type === "VP8 ")!
  const vp8x = Buffer.alloc(10)
  vp8x[0] = 0x08 // EXIF present
  vp8x.writeUIntLE(width - 1, 4, 3)
  vp8x.writeUIntLE(height - 1, 7, 3)
  const exif = prefixed
    ? Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff()])
    : tiff()
  return riff([
    { type: "VP8X", data: vp8x },
    { type: "VP8 ", data: vp8.data },
    { type: "EXIF", data: exif },
  ])
}

/** Raw first-frame decode: checksum line(s) and stderr lines. */
function rawDecode(file: string) {
  try {
    const stdout = execFileSync(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        file,
        "-frames:v",
        "1",
        "-f",
        "framemd5",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    ).toString()
    return { stdout, ok: true }
  } catch {
    return { stdout: "", ok: false }
  }
}

function decodeStderr(file: string) {
  const result = execFileSync("bash", [
    "-c",
    'ffmpeg -nostdin -hide_banner -loglevel error -i "$1" -frames:v 1 -f null - 2>&1',
    "_",
    file,
  ]).toString()
  return result.split("\n").filter(Boolean)
}

const frameHash = (stdout: string) =>
  stdout
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(",").at(-1)!.trim())

async function upload(name: string, bytes: Buffer) {
  const storage = createVideoStorage(path.join(base, "storage"))
  const job = await storage.createJob()
  const verify = createUploadVerifier(
    createRunner({ timeoutMs: 15_000 }),
    commands,
  )
  return {
    storage,
    job,
    result: storage.addImageAsset(
      job.id,
      { bytes, declaredType: "image/webp", fileName: name },
      { verify },
    ),
  }
}

beforeAll(async () => {
  capabilities = await detectFfmpegCapabilities({
    run: createRunner({ timeoutMs: 30_000 }),
  })
  if (capabilities.status !== "ready")
    throw new Error(`FFmpeg isn't ready (${capabilities.status}).`)
  base = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-webp-"))
})

afterAll(async () => {
  if (base) await fs.rm(base, { recursive: true, force: true })
})

describe("WebP uploads with real FFmpeg", () => {
  it("reproduces the report: FFmpeg logs an Exif notice but decodes identical pixels", async () => {
    const simple = await encodeWebp("simple.webp", ["-quality", "80"])
    const prefixed = path.join(base, "prefixed.webp")
    const conformant = path.join(base, "conformant.webp")
    await fs.writeFile(prefixed, withExif(simple, true))
    await fs.writeFile(conformant, withExif(simple, false))

    const stderr = decodeStderr(prefixed)
    expect(stderr.length).toBeGreaterThan(0)
    expect(stderr.every((line) => NOTICE.test(line))).toBe(true)
    expect(decodeStderr(conformant)).toEqual([])

    const hashes = [path.join(base, "simple.webp"), prefixed, conformant].map(
      (file) => frameHash(rawDecode(file).stdout),
    )
    expect(hashes[0]).toHaveLength(1)
    expect(hashes[1]).toEqual(hashes[0])
    expect(hashes[2]).toEqual(hashes[0])
  })

  it("accepts the Exif-prefixed WebP and valid variants", async () => {
    const simple = await encodeWebp("lossy.webp", ["-quality", "80"])
    const variants: [string, Buffer][] = [
      ["exif-prefixed.webp", withExif(simple, true)],
      ["exif-raw-tiff.webp", withExif(simple, false)],
      ["lossy.webp", simple],
      [
        "lossless.webp",
        await encodeWebp(
          "lossless.webp",
          ["-lossless", "1"],
          "testsrc2=s=1100x900",
          "bgra",
        ),
      ],
      [
        "alpha.webp",
        await encodeWebp(
          "alpha.webp",
          ["-quality", "80"],
          "color=c=red@0.5:s=1080x1350,format=yuva420p",
          "yuva420p",
        ),
      ],
    ]
    for (const [name, bytes] of variants) {
      const { result } = await upload(name, bytes)
      const asset = await result
      expect(asset.mimeType, name).toBe("image/webp")
      expect(asset.width, name).toBeGreaterThanOrEqual(1080)
    }
  })

  it("still rejects damaged WebPs, with or without the Exif notice", async () => {
    const simple = await encodeWebp("base.webp", ["-quality", "80"])
    const prefixed = withExif(simple, true)
    // Cut off: the header and dimensions are intact, the picture data isn't.
    const truncated = prefixed.subarray(0, Math.floor(prefixed.length / 3))
    // VP8 frame tag destroyed: the bitstream can't start.
    const broken = Buffer.from(prefixed)
    const vp8At = broken.indexOf("VP8 ", 12, "latin1") + 8
    broken.fill(0xff, vp8At, vp8At + 10)
    for (const [name, bytes] of [
      ["truncated.webp", truncated],
      ["broken.webp", broken],
    ] as const) {
      const { storage, job, result } = await upload(name, bytes)
      await expect(result, name).rejects.toBeInstanceOf(StorageError)
      await expect(result, name).rejects.toMatchObject({
        code: "invalid-upload",
        message: expect.stringMatching(
          new RegExp(`^“${name}” couldn't be verified: `),
        ),
      })
      expect((await storage.readJob(job.id)).assets).toEqual([])
    }
  })

  it("renders a video from an Exif-prefixed WebP", async () => {
    const storage = createVideoStorage(path.join(base, "render"))
    const job = await storage.createJob()
    const verify = createUploadVerifier(
      createRunner({ timeoutMs: 15_000 }),
      commands,
    )
    const simple = await encodeWebp("render.webp", ["-quality", "80"])
    const ids = []
    for (const [i, bytes] of [
      withExif(simple, true),
      await encodeWebp(
        "render-2.webp",
        ["-quality", "80"],
        "mandelbrot=s=1200x1200",
      ),
      withExif(simple, true),
    ].entries()) {
      const asset = await storage.addImageAsset(
        job.id,
        { bytes, declaredType: "image/webp", fileName: `photo-${i}.webp` },
        { verify },
      )
      ids.push(asset.id)
    }
    const product: ProductInfo = {
      name: "Trailblazer travel mug",
      headline: "Hot coffee for 12 hours",
      benefits: ["Leak-proof lid for your bag"],
      callToAction: "Tap the link to shop",
      disclosure: "#ad · I may earn a commission if you buy through my link.",
    }
    const project = buildTrustedProject(
      await storage.readJob(job.id),
      { product, assetIds: ids, effects: STATIC_EFFECTS },
      fonts,
    )
    if (!project.ok) throw new Error(JSON.stringify(project.issues))
    await storage.writeProject(job.id, project.value)
    const queue = new RenderQueue(storage, (jobId, onProgress, signal) =>
      renderVideo(
        jobId,
        {
          storage,
          spawn: spawnTool,
          run: createRunner({ timeoutMs: 60_000 }),
          getCapabilities: async () => capabilities,
          commands,
          fonts,
          fontDir: fontDirectory(),
          threads: 4,
          timeouts: { sceneMs: 60_000, encodeMs: 5 * 60_000 },
          log: () => {},
        },
        onProgress,
        signal,
      ),
    )
    await queue.enqueue(job.id)
    await queue.whenIdle()
    const done = await storage.readJob(job.id)
    expect(done.state).toBe("completed")
    expect(done.output).toMatchObject({ width: 1080, height: 1920, fps: 30 })
  })
})
