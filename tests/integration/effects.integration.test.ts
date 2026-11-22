/**
 * Real FFmpeg tests for EXIF orientation and visual effects (DV-003D2).
 * Run with `yarn test:integration`.
 *
 * Nothing is mocked. Orientation is checked pixel by pixel: real JPEGs with
 * four colored quadrants carry each EXIF orientation 1–8, and the colors
 * must land in the upright places, both in the normalized image and in the
 * product area of a rendered video. Effects are checked on decoded frames:
 * the product must move within a scene while captions and the disclosure
 * stay still, cuts must change in one frame, and dissolves must blend
 * smoothly across exactly the planned frames without black flashes, with
 * the storyboard's exact frame count.
 */
import { execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { FfmpegCapabilityReport } from "@/lib/video/capabilities"
import { DEFAULT_EFFECTS, STATIC_EFFECTS } from "@/lib/video/effects"
import type { RenderProgress } from "@/lib/video/render-job"
import type {
  AudioConfig,
  ProductInfo,
  VideoProject,
  VisualEffects,
} from "@/lib/video/types"
import {
  createRunner,
  spawnTool,
  type Spawner,
} from "@/server/process/run-executable"
import { type ExifOrientation } from "@/server/video/exif"
import { detectFfmpegCapabilities } from "@/server/video/ffmpeg-capabilities"
import { buildRenderPlan, encoderOptions } from "@/server/video/ffmpeg-command"
import { createAssetId } from "@/lib/video/ids"
import { buildStoryboard } from "@/lib/video/storyboard"
import { DEFAULT_VIDEO_SETTINGS } from "@/lib/video/validation"
import { fontDirectory, loadVideoFont } from "@/server/video/font-metrics"
import { buildTrustedProject } from "@/server/video/project"
import { RenderQueue } from "@/server/video/render-queue"
import { renderVideo } from "@/server/video/render-service"
import { createVideoStorage, type VideoStorage } from "@/server/video/storage"
import {
  createAudioInspector,
  createUploadVerifier,
} from "@/server/video/upload-verify"
import { testLease } from "../support/test-lease"

/** A real render-gate lease (DV-005C): renderVideo requires one. */
const lease = await testLease()

const commands = { ffmpeg: "ffmpeg", ffprobe: "ffprobe" }
const fonts = { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") }
const product: ProductInfo = {
  name: "Trailblazer travel mug",
  headline: "Hot coffee for 12 hours",
  benefits: [
    "Leak-proof lid for your bag",
    "Fits every cup holder",
    "Keeps ice for a day",
    "Dishwasher safe",
  ],
  callToAction: "Tap the link to shop",
  disclosure: "#ad · I may earn a commission if you buy through my link.",
}

let base: string
let media: string
let capabilities: FfmpegCapabilityReport

function ffmpeg(args: string[], cwd?: string) {
  return execFileSync("ffmpeg", ["-nostdin", "-v", "error", ...args], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  })
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Color = "R" | "G" | "B" | "Y" | "W" | "K"
const RGB: Record<Color, [number, number, number]> = {
  R: [230, 30, 30],
  G: [30, 200, 60],
  B: [40, 60, 230],
  Y: [240, 220, 40],
  W: [235, 235, 235],
  K: [20, 20, 20],
}
const hex = (c: Color) =>
  "0x" + RGB[c].map((v) => v.toString(16).padStart(2, "0")).join("")

/** A real 800 × 400 JPEG: TL red, TR green, BL blue, BR yellow. */
function quadrantJpeg(file: string) {
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=${hex("R")}:s=400x200`,
    "-f",
    "lavfi",
    "-i",
    `color=c=${hex("G")}:s=400x200`,
    "-f",
    "lavfi",
    "-i",
    `color=c=${hex("B")}:s=400x200`,
    "-f",
    "lavfi",
    "-i",
    `color=c=${hex("Y")}:s=400x200`,
    "-filter_complex",
    "[0][1]hstack[top];[2][3]hstack[bottom];[top][bottom]vstack",
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-y",
    file,
  ])
}

/** Inserts an EXIF APP1 segment with the given orientation after SOI. */
function withExif(jpeg: Buffer, orientation: number, little = false) {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4)
  tiff.write(little ? "II" : "MM", 0, "latin1")
  const u16 = (v: number, at: number) =>
    little ? tiff.writeUInt16LE(v, at) : tiff.writeUInt16BE(v, at)
  const u32 = (v: number, at: number) =>
    little ? tiff.writeUInt32LE(v, at) : tiff.writeUInt32BE(v, at)
  u16(42, 2)
  u32(8, 4)
  u16(1, 8)
  u16(0x0112, 10)
  u16(3, 12)
  u32(1, 14)
  u16(orientation, 18)
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff])
  const header = Buffer.from([0xff, 0xe1, 0, 0])
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)])
}

/** Expected quadrant colors (TL, TR, BL, BR) once correctly turned upright. */
const UPRIGHT: Record<ExifOrientation, string> = {
  1: "RGBY",
  2: "GRYB",
  3: "YBGR",
  4: "BYRG",
  5: "RBGY",
  6: "BRYG",
  7: "YGBR",
  8: "GYRB",
}

function nearest([r, g, b]: number[]): Color {
  let best: Color = "K"
  let distance = Infinity
  for (const [name, [cr, cg, cb]] of Object.entries(RGB) as [
    Color,
    number[],
  ][]) {
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
    if (d < distance) {
      distance = d
      best = name
    }
  }
  return best
}

/** Average RGB of a small box, from an image file or one frame of a video. */
function sample(
  file: string,
  x: number,
  y: number,
  { frame, size = 16 }: { frame?: number; size?: number } = {},
) {
  const select = frame === undefined ? [] : [`select=eq(n\\,${frame})`]
  const out = ffmpeg([
    "-i",
    file,
    "-vf",
    [
      ...select,
      `crop=${size}:${size}:${x - size / 2}:${y - size / 2}`,
      "scale=1:1:flags=area",
      "format=rgb24",
    ].join(","),
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-",
  ])
  return [out[0], out[1], out[2]]
}

/** Mean luma per frame and frame-to-frame change, for a region of a video. */
function frameStats(file: string, crop?: string) {
  const run = (vf: string) =>
    execFileSync(
      "ffmpeg",
      ["-nostdin", "-hide_banner", "-i", file, "-vf", vf, "-f", "null", "-"],
      { maxBuffer: 64 * 1024 * 1024 },
    )
      .toString()
      .split("\n")
      .filter((l) => l.includes("YAVG="))
      .map((l) => Number(l.split("=")[1]))
  const prefix = crop ? `${crop},` : ""
  const meta = "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-"
  return {
    luma: run(`${prefix}${meta}`),
    change: [0, ...run(`${prefix}tblend=all_mode=difference,${meta}`)],
  }
}

function probeFrames(file: string) {
  const out = execFileSync("ffprobe", [
    "-v",
    "error",
    "-count_frames",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=nb_read_frames:format=duration",
    "-of",
    "json",
    file,
  ]).toString()
  const json = JSON.parse(out)
  return {
    frames: Number(json.streams[0].nb_read_frames),
    duration: Number(json.format.duration),
  }
}

// Regions of the 1080 × 1920 frame (see LAYOUT / PRODUCT_CANVAS).
const PRODUCT = "crop=1008:840:36:365"
const CAPTIONS = "crop=1080:480:0:1225"
const DISCLOSURE = "crop=1080:140:0:198"

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

async function prepare(
  storage: VideoStorage,
  {
    images,
    benefits = 2,
    effects,
    audio = false,
  }: {
    images: { file: string; type: string }[]
    benefits?: number
    effects?: VisualEffects
    audio?: boolean
  },
) {
  const job = await storage.createJob()
  const verify = createUploadVerifier(
    createRunner({ timeoutMs: 15_000 }),
    commands,
  )
  const assetIds = []
  for (const [i, image] of images.entries()) {
    const asset = await storage.addImageAsset(
      job.id,
      {
        bytes: await fs.readFile(image.file),
        declaredType: image.type,
        fileName: `photo-${i + 1}`,
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
    const add = async (role: "voiceover" | "music", name: string) =>
      (
        await storage.addAudioAsset(
          job.id,
          {
            bytes: await fs.readFile(path.join(media, name)),
            declaredType: "audio/wav",
            fileName: name,
            role,
          },
          { inspect },
        )
      ).id
    audioConfig = {
      mode: "voiceover-and-music",
      voiceoverAssetId: await add("voiceover", "voice.wav"),
      musicAssetId: await add("music", "music.wav"),
      musicLevel: "low",
    }
  }
  const project = buildTrustedProject(
    await storage.readJob(job.id),
    {
      product: { ...product, benefits: product.benefits.slice(0, benefits) },
      assetIds,
      ...(audioConfig ? { audio: audioConfig } : {}),
      ...(effects ? { effects } : {}),
    },
    fonts,
  )
  if (!project.ok) throw new Error(JSON.stringify(project.issues))
  await storage.writeProject(job.id, project.value)
  return { jobId: job.id, project: project.value }
}

function queueFor(
  storage: VideoStorage,
  hooks: {
    spawn?: Spawner
    onProgress?: (progress: RenderProgress) => void
    threads?: number
  } = {},
) {
  return new RenderQueue(
    storage,
    (jobId, onProgress, signal) =>
      renderVideo(
        jobId,
        {
          storage,
          spawn: hooks.spawn ?? spawnTool,
          run: createRunner({ timeoutMs: 60_000 }),
          lease,
          getCapabilities: async () => capabilities,
          commands,
          fonts,
          fontDir: fontDirectory(),
          threads: hooks.threads ?? 4,
          timeouts: { sceneMs: 60_000, encodeMs: 5 * 60_000, audioMs: 120_000 },
          log: () => {},
        },
        (progress) => {
          onProgress(progress)
          hooks.onProgress?.(progress)
        },
        signal,
      ),
    () => {},
  )
}

/** Renders a prepared job through a real queue and returns the MP4's path. */
async function render(
  storage: VideoStorage,
  jobId: string,
  hooks?: Parameters<typeof queueFor>[1],
) {
  const queue = queueFor(storage, hooks)
  await queue.enqueue(jobId)
  await queue.whenIdle()
  const job = await storage.readJob(jobId)
  if (job.state !== "completed")
    throw new Error(`Render ${job.state}: ${job.error?.message}`)
  const out = await storage.resolveCompletedOutput(jobId)
  return { file: out!.path, job }
}

/** Storyboard boundaries (output frames where each later scene starts). */
function boundaries(project: VideoProject) {
  const list: number[] = []
  let at = 0
  for (const scene of project.scenes.slice(0, -1)) {
    at += scene.durationFrames
    list.push(at)
  }
  return list
}

const totalFrames = (project: VideoProject) =>
  project.scenes.reduce((n, s) => n + s.durationFrames, 0)

// Brightness-distinct photos, so cuts and dissolves are measurable.
const SHADES: Color[] = ["K", "W", "B", "Y", "R", "G"]
const shadeFile = (c: Color) => path.join(media, `shade-${c}.png`)

beforeAll(async () => {
  capabilities = await detectFfmpegCapabilities({
    run: createRunner({ timeoutMs: 30_000 }),
  })
  if (capabilities.status !== "ready" || !capabilities.audio.ready)
    throw new Error("FFmpeg with audio support is required for these tests.")
  for (const name of ["perspective", "pad", "xfade", "transpose"])
    if (!capabilities.filters.some((f) => f.name === name && f.available))
      throw new Error(`This FFmpeg lacks the ${name} filter.`)
  base = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-effects-"))
  media = path.join(base, "media")
  await fs.mkdir(media)
  quadrantJpeg(path.join(media, "quadrants.jpg"))
  const plain = await fs.readFile(path.join(media, "quadrants.jpg"))
  for (let o = 1; o <= 8; o++)
    await fs.writeFile(
      path.join(media, `exif-${o}.jpg`),
      withExif(plain, o, o % 2 === 0),
    )
  for (const c of SHADES)
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `color=c=${hex(c)}:s=1200x1200`,
      // A little texture so the product edge and zoom are visible.
      "-vf",
      "drawgrid=w=100:h=100:t=4:c=gray@0.5",
      "-frames:v",
      "1",
      "-y",
      shadeFile(c),
    ])
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=300:sample_rate=48000:duration=10",
    "-c:a",
    "pcm_s16le",
    "-y",
    path.join(media, "voice.wav"),
  ])
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=800:sample_rate=44100:duration=4",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    "-y",
    path.join(media, "music.wav"),
  ])
})

afterAll(async () => {
  if (base) await fs.rm(base, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// EXIF orientation
// ---------------------------------------------------------------------------

describe("EXIF orientation with real FFmpeg", () => {
  it("FFmpeg's own JPEG handling is not reliable (why Deskverse normalizes)", () => {
    // Documented finding for FFmpeg 6.1: without -noautorotate, sideways
    // orientations keep their stored size. Deskverse never depends on it.
    const out = execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      path.join(media, "exif-6.jpg"),
    ])
      .toString()
      .trim()
    expect(out).toBe("800,400")
  })

  for (let o = 1 as ExifOrientation; o <= 8; o++) {
    const orientation = o
    it(`normalizes orientation ${orientation} upright, exactly once`, async () => {
      const dir = path.join(base, `normalize-${orientation}`)
      await fs.mkdir(dir)
      const source = path.join(media, `exif-${orientation}.jpg`)
      // Only the normalization command is needed: take it from a real plan.
      const id = createAssetId()
      const p = { ...product, benefits: product.benefits.slice(0, 1) }
      const plan = buildRenderPlan({
        project: {
          product: p,
          assets: [],
          scenes: buildStoryboard(p, [id]),
          settings: DEFAULT_VIDEO_SETTINGS,
        },
        imageSources: new Map([
          [
            id,
            { path: source, orientation, storedWidth: 800, storedHeight: 400 },
          ],
        ]),
        fonts,
        encoder: { name: "libx264", options: encoderOptions("libx264") },
        threads: 1,
      })
      expect(plan.images).toHaveLength(1)
      const [image] = plan.images
      const result = await spawnTool("ffmpeg", image.args, {
        cwd: dir,
        timeoutMs: 30_000,
      })
      expect(result.ok).toBe(true)
      const out = path.join(dir, image.output)
      const size = execFileSync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        out,
      ])
        .toString()
        .trim()
      const sideways = orientation >= 5
      expect(size).toBe(sideways ? "400,800" : "800,400")
      const [w, h] = sideways ? [400, 800] : [800, 400]
      const colors = [
        sample(out, w / 4, h / 4),
        sample(out, (3 * w) / 4, h / 4),
        sample(out, w / 4, (3 * h) / 4),
        sample(out, (3 * w) / 4, (3 * h) / 4),
      ]
        .map(nearest)
        .join("")
      expect(colors).toBe(UPRIGHT[orientation])
    })
  }

  it("uploads a sideways and a mirrored phone photo with upright sizes and renders them upright", async () => {
    const storage = createVideoStorage(path.join(base, "exif-render"))
    const { jobId, project } = await prepare(storage, {
      images: [
        { file: path.join(media, "exif-6.jpg"), type: "image/jpeg" },
        { file: path.join(media, "exif-5.jpg"), type: "image/jpeg" },
        { file: path.join(media, "exif-3.jpg"), type: "image/jpeg" },
      ],
      benefits: 1,
      effects: STATIC_EFFECTS,
    })
    // The real FFprobe verifier accepted them, and sizes are the upright ones.
    expect(project.assets.map((a) => [a.width, a.height])).toEqual([
      [400, 800],
      [400, 800],
      [800, 400],
    ])
    // Originals are kept byte for byte.
    for (const [i, name] of [
      "exif-6.jpg",
      "exif-5.jpg",
      "exif-3.jpg",
    ].entries())
      expect(
        Buffer.compare(
          await fs.readFile(
            await storage.assetPath(jobId, project.assets[i].id),
          ),
          await fs.readFile(path.join(media, name)),
        ),
      ).toBe(0)
    const { file } = await render(storage, jobId)
    // Scene 1 (hook) shows exif-6 and scene 2 shows exif-5: portrait 400 × 800
    // fitted into 960 × 800 → 400 × 800 centered at (540, 785).
    const quadrants = (frame: number) =>
      [
        [440, 585],
        [640, 585],
        [440, 985],
        [640, 985],
      ]
        .map(([x, y]) => nearest(sample(file, x, y, { frame })))
        .join("")
    expect(quadrants(45)).toBe(UPRIGHT[6])
    expect(quadrants(project.scenes[0].durationFrames + 45)).toBe(UPRIGHT[5])
  })
})

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

const shades = (n: number) =>
  SHADES.slice(0, n).map((c) => ({ file: shadeFile(c), type: "image/png" }))

describe("visual effects with real FFmpeg", () => {
  it("static + cuts: still within scenes, one-frame cuts, exact frames", async () => {
    const storage = createVideoStorage(path.join(base, "static"))
    const { jobId, project } = await prepare(storage, {
      images: shades(3),
      benefits: 1,
      effects: STATIC_EFFECTS,
    })
    const { file } = await render(storage, jobId)
    expect(probeFrames(file)).toEqual({
      frames: totalFrames(project),
      duration: totalFrames(project) / 30,
    })
    const product = frameStats(file, PRODUCT)
    for (const b of boundaries(project)) {
      // The whole change happens on the boundary frame.
      expect(product.change[b]).toBeGreaterThan(10)
      for (const f of [b - 5, b - 1, b + 1, b + 5])
        expect(product.change[f]).toBeLessThan(0.5)
    }
    // Within a scene (after the fade-in), nothing moves.
    for (let f = 20; f < boundaries(project)[0] - 1; f++)
      expect(product.change[f]).toBeLessThan(0.2)
  })

  it("gentle zoom: the product moves every frame, captions and disclosure stay still", async () => {
    const storage = createVideoStorage(path.join(base, "zoom"))
    const { jobId, project } = await prepare(storage, {
      // A bright photo first: its edge stands out against the dark backdrop.
      images: ["W", "B", "K"].map((c) => ({
        file: shadeFile(c as Color),
        type: "image/png",
      })),
      benefits: 1,
      effects: { motion: "gentle-zoom", transition: "cut" },
    })
    const { file } = await render(storage, jobId)
    expect(probeFrames(file).frames).toBe(totalFrames(project))
    const product = frameStats(file, PRODUCT)
    const captions = frameStats(file, CAPTIONS)
    const disclosure = frameStats(file, DISCLOSURE)
    const [first] = boundaries(project)
    const within = Array.from({ length: first - 20 }, (_, i) => i + 15)
    for (const f of within) {
      expect(product.change[f], `product frame ${f}`).toBeGreaterThan(0.01)
      expect(captions.change[f], `captions frame ${f}`).toBeLessThan(0.1)
      expect(disclosure.change[f], `disclosure frame ${f}`).toBeLessThan(0.1)
    }
    // Smooth: no single frame jumps far beyond the scene's typical motion.
    const changes = within.map((f) => product.change[f])
    const mean = changes.reduce((a, b) => a + b, 0) / changes.length
    expect(Math.max(...changes)).toBeLessThan(mean * 4 + 0.2)
    // The product grows by ~5 %: the photo (a 1200 px square fitted to
    // 800 px) reaches past its starting edge by the end of the scene.
    const edgeAt = (frame: number) => {
      // The first column of a row (y = 800) that belongs to the bright photo.
      const row = ffmpeg([
        "-i",
        file,
        "-vf",
        `select=eq(n\\,${frame}),format=rgb24,crop=100:1:100:800`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-",
      ])
      for (let x = 0; x < 100; x++)
        if (nearest([row[3 * x], row[3 * x + 1], row[3 * x + 2]]) === "W")
          return 100 + x
      return 200
    }
    const startEdge = edgeAt(15)
    const endEdge = edgeAt(first - 2)
    expect(startEdge).toBeGreaterThanOrEqual(138)
    expect(startEdge).toBeLessThanOrEqual(142)
    // 800 px × 1.05 ≈ 840 px: the left edge moves out by ~20 px, never more.
    expect(startEdge - endEdge).toBeGreaterThanOrEqual(15)
    expect(startEdge - endEdge).toBeLessThanOrEqual(22)
  })

  it("crossfade only: dissolves over exactly 9 frames around each boundary, no black flash", async () => {
    const storage = createVideoStorage(path.join(base, "crossfade"))
    const { jobId, project } = await prepare(storage, {
      images: shades(4),
      benefits: 2,
      effects: { motion: "none", transition: "crossfade" },
    })
    const { file } = await render(storage, jobId)
    expect(probeFrames(file)).toEqual({
      frames: totalFrames(project),
      duration: totalFrames(project) / 30,
    })
    const { luma, change } = frameStats(file, PRODUCT)
    for (const b of boundaries(project)) {
      const before = luma[b - 6]
      const after = luma[b + 6]
      // Frames b-4 … b+4 change steadily; outside the window nothing does.
      for (let f = b - 3; f <= b + 5; f++)
        expect(change[f], `frame ${f}`).toBeGreaterThan(
          Math.abs(after - before) / 18,
        )
      expect(change[b - 5]).toBeLessThan(0.5)
      expect(change[b + 6]).toBeLessThan(0.5)
      // Every dissolve frame lies between the two scenes: no dip to black,
      // no flash, and luma moves monotonically.
      const lo = Math.min(before, after) - 1
      const hi = Math.max(before, after) + 1
      for (let f = b - 4; f <= b + 5; f++) {
        expect(luma[f]).toBeGreaterThanOrEqual(lo)
        expect(luma[f]).toBeLessThanOrEqual(hi)
        if (f > b - 4)
          expect(Math.sign(luma[f] - luma[f - 1])).not.toBe(
            -Math.sign(after - before),
          )
      }
      // Halfway through, the picture is a real mix of both scenes.
      const mid = luma[b]
      expect(mid).toBeGreaterThan(lo + (hi - lo) * 0.2)
      expect(mid).toBeLessThan(hi - (hi - lo) * 0.2)
    }
  })

  it("gentle zoom + crossfade, six scenes (stress): exact frames, every transition blended", async () => {
    const storage = createVideoStorage(path.join(base, "stress"))
    const { jobId, project } = await prepare(storage, {
      images: shades(6),
      benefits: 4,
      effects: DEFAULT_EFFECTS,
    })
    expect(project.scenes).toHaveLength(6)
    const { file, job } = await render(storage, jobId)
    expect(probeFrames(file)).toEqual({
      frames: totalFrames(project),
      duration: totalFrames(project) / 30,
    })
    expect(job.output?.durationSeconds).toBe(totalFrames(project) / 30)
    const { luma, change } = frameStats(file, PRODUCT)
    // No duplicated or frozen frames anywhere after the fade-in: the product
    // is always zooming or dissolving.
    for (let f = 10; f < luma.length - 14; f++)
      expect(change[f], `frame ${f}`).toBeGreaterThan(0.01)
    for (const b of boundaries(project)) {
      const lo = Math.min(luma[b - 6], luma[b + 6]) - 2
      const hi = Math.max(luma[b - 6], luma[b + 6]) + 2
      for (let f = b - 4; f <= b + 5; f++) {
        expect(luma[f]).toBeGreaterThanOrEqual(lo)
        expect(luma[f]).toBeLessThanOrEqual(hi)
      }
    }
  })

  it("gentle zoom + crossfade with voiceover and music: AAC muxed, frames exact", async () => {
    const storage = createVideoStorage(path.join(base, "audio"))
    const { jobId, project } = await prepare(storage, {
      images: shades(3),
      benefits: 1,
      effects: DEFAULT_EFFECTS,
      audio: true,
    })
    const { file, job } = await render(storage, jobId)
    expect(job.output?.audio).toMatchObject({
      codec: "aac",
      sampleRate: 48000,
      channels: 2,
    })
    expect(probeFrames(file).frames).toBe(totalFrames(project))
    const streams = JSON.parse(
      execFileSync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name",
        "-of",
        "json",
        file,
      ]).toString(),
    ).streams
    expect(streams).toEqual([
      { codec_type: "video", codec_name: "h264" },
      { codec_type: "audio", codec_name: "aac" },
    ])
  })
})

// ---------------------------------------------------------------------------
// Job management with effects
// ---------------------------------------------------------------------------

describe("effects and job management with real FFmpeg", () => {
  it("cancels mid-effect: FFmpeg stops, nothing is published, no scratch files", async () => {
    const storage = createVideoStorage(path.join(base, "cancel"))
    const { jobId } = await prepare(storage, {
      images: shades(3),
      benefits: 1,
      effects: DEFAULT_EFFECTS,
    })
    let cancelled: Promise<unknown> | null = null
    const queue = queueFor(storage, {
      threads: 1,
      onProgress: (progress) => {
        if (
          cancelled ||
          progress.phase !== "encoding" ||
          progress.fraction < 0.3
        )
          return
        cancelled = queue.cancel(jobId)
      },
    })
    await queue.enqueue(jobId)
    await queue.whenIdle()
    await cancelled
    const job = await storage.readJob(jobId)
    expect(job.state).toBe("cancelled")
    expect(await storage.resolveCompletedOutput(jobId)).toBeNull()
    expect(await fs.readdir(await storage.workDir(jobId))).toEqual([])
  })

  it("retries after a failed effect segment, reusing the uploads and saved effects", async () => {
    const storage = createVideoStorage(path.join(base, "retry"))
    const { jobId, project } = await prepare(storage, {
      images: shades(3),
      benefits: 1,
      effects: DEFAULT_EFFECTS,
    })
    let failed = false
    const failingOnce: Spawner = async (command, args, options) => {
      if (
        !failed &&
        args.includes("-progress") &&
        args.join(" ").includes("segment-2")
      ) {
        failed = true
        return {
          ok: false,
          reason: "failed",
          exitCode: 1,
          stderrTail: "simulated",
        }
      }
      return spawnTool(command, args, options)
    }
    const queue = queueFor(storage, { spawn: failingOnce })
    await queue.enqueue(jobId)
    await queue.whenIdle()
    expect((await storage.readJob(jobId)).state).toBe("failed")
    expect(await fs.readdir(await storage.workDir(jobId))).toEqual([])

    await queue.retry(jobId)
    await queue.whenIdle()
    const job = await storage.readJob(jobId)
    expect(job.state).toBe("completed")
    expect((await storage.readProject(jobId)).effects).toEqual(DEFAULT_EFFECTS)
    const out = await storage.resolveCompletedOutput(jobId)
    expect(probeFrames(out!.path).frames).toBe(totalFrames(project))
  })
})
