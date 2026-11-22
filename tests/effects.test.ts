/**
 * DV-003D2: EXIF orientation, visual-effects settings, frame math and the
 * render plan for gentle zoom and crossfades. Pure or mocked FFmpeg; the
 * pixels themselves are checked by tests/integration/effects.integration.test.ts.
 */
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  EFFECT_FILTERS,
  type FfmpegCapabilityReport,
} from "@/lib/video/capabilities"
import {
  CROSSFADE,
  DEFAULT_EFFECTS,
  describeEffects,
  effectAvailability,
  GENTLE_ZOOM,
  missingEffectFilters,
  missingEffectsMessage,
  sceneTimings,
  STATIC_EFFECTS,
} from "@/lib/video/effects"
import { createAssetId, type AssetId } from "@/lib/video/ids"
import { buildStoryboard } from "@/lib/video/storyboard"
import type {
  MediaAsset,
  ProductInfo,
  VideoProject,
  VisualEffects,
} from "@/lib/video/types"
import {
  DEFAULT_VIDEO_SETTINGS,
  validateVideoProject,
  validateVisualEffects,
} from "@/lib/video/validation"
import type { SpawnOptions, Spawner } from "@/server/process/run-executable"
import {
  ORIENTATION_FILTERS,
  orientedDimensions,
  readJpegOrientation,
  type ExifOrientation,
} from "@/server/video/exif"
import {
  buildRenderPlan,
  encoderOptions,
  imageNormalizeFilters,
  LAYOUT,
  normalizedSize,
  NORMALIZED_MAX_SIDE,
  PRODUCT_CANVAS,
  zoomFilter,
  type ImageSource,
} from "@/server/video/ffmpeg-command"
import { fontDirectory, loadVideoFont } from "@/server/video/font-metrics"
import { buildTrustedProject } from "@/server/video/project"
import { RenderQueue } from "@/server/video/render-queue"
import {
  RenderCancelled,
  renderVideo,
  type RenderDeps,
} from "@/server/video/render-service"
import { createVideoStorage, type VideoStorage } from "@/server/video/storage"
import { testLease } from "./support/test-lease"

/** A real render-gate lease (DV-005C): renderVideo requires one. */
const lease = await testLease()

const fonts = { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") }

// ---------------------------------------------------------------------------
// JPEG fixtures (headers only: the parser never decodes pixels)
// ---------------------------------------------------------------------------

function segment(marker: number, payload: Uint8Array) {
  const out = new Uint8Array(4 + payload.length)
  out.set([
    0xff,
    marker,
    (payload.length + 2) >> 8,
    (payload.length + 2) & 0xff,
  ])
  out.set(payload, 4)
  return out
}

/** An Exif APP1 payload with IFD0 entries [tag, type, count, value]. */
function exifPayload(
  entries: [number, number, number, number][],
  { little = false, magic = 42, ifdOffset = 8 } = {},
) {
  const tiff = new Uint8Array(8 + 2 + entries.length * 12 + 4)
  const view = new DataView(tiff.buffer)
  tiff.set(little ? [0x49, 0x49] : [0x4d, 0x4d])
  view.setUint16(2, magic, little)
  view.setUint32(4, ifdOffset, little)
  view.setUint16(8, entries.length, little)
  entries.forEach(([tag, type, count, value], i) => {
    const at = 10 + i * 12
    view.setUint16(at, tag, little)
    view.setUint16(at + 2, type, little)
    view.setUint32(at + 4, count, little)
    view.setUint16(at + 8, value, little)
  })
  const header = new TextEncoder().encode("Exif\0\0")
  const payload = new Uint8Array(header.length + tiff.length)
  payload.set(header)
  payload.set(tiff, header.length)
  return payload
}

function sof(width: number, height: number) {
  return segment(
    0xc0,
    new Uint8Array([
      8,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      3,
    ]),
  )
}

function jpeg(...segments: Uint8Array[]) {
  const parts = [
    new Uint8Array([0xff, 0xd8]),
    ...segments,
    new Uint8Array([0xff, 0xd9]),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const withOrientation = (value: number, options = {}) =>
  jpeg(
    segment(0xe1, exifPayload([[0x0112, 3, 1, value]], options)),
    sof(1600, 1200),
  )

describe("EXIF orientation", () => {
  it("reads all eight orientations, big- and little-endian", () => {
    for (let value = 1; value <= 8; value++) {
      expect(readJpegOrientation(withOrientation(value))).toBe(value)
      expect(
        readJpegOrientation(withOrientation(value, { little: true })),
      ).toBe(value)
    }
  })

  it("finds the tag among other IFD0 entries and after other APP segments", () => {
    const bytes = jpeg(
      segment(0xe0, new TextEncoder().encode("JFIF\0\u0001\u0002")),
      segment(
        0xe1,
        new TextEncoder().encode("http://ns.adobe.com/xap/1.0/\0<x/>"),
      ),
      segment(
        0xe1,
        exifPayload([
          [0x010f, 2, 4, 0], // Make
          [0x0110, 2, 4, 0], // Model
          [0x0112, 3, 1, 6],
        ]),
      ),
      sof(4032, 3024),
    )
    expect(readJpegOrientation(bytes)).toBe(6)
  })

  it("treats missing or malformed EXIF as upright (1), never throwing", () => {
    const cases: Uint8Array[] = [
      jpeg(sof(100, 100)), // no EXIF at all
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]), // not a JPEG
      new Uint8Array([]),
      withOrientation(0),
      withOrientation(9),
      withOrientation(0xffff),
      withOrientation(6, { magic: 43 }), // bad TIFF magic
      withOrientation(6, { ifdOffset: 4000 }), // IFD outside the segment
      withOrientation(6, { ifdOffset: 2 }),
      jpeg(segment(0xe1, exifPayload([[0x0112, 4, 1, 6]]))), // LONG, not SHORT
      jpeg(segment(0xe1, exifPayload([[0x0112, 3, 2, 6]]))), // count 2
      jpeg(segment(0xe1, new TextEncoder().encode("Exif\0\0MM"))), // truncated TIFF
      // Segment length running past the end of the file.
      new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x45, 0x78]),
      // Image data before any EXIF: metadata after SOS is ignored.
      jpeg(
        segment(0xda, new Uint8Array([1, 2, 3])),
        segment(0xe1, exifPayload([[0x0112, 3, 1, 6]])),
      ),
      // A garbage byte where a marker should be.
      jpeg(
        new Uint8Array([0x00, 0x11]),
        segment(0xe1, exifPayload([[0x0112, 3, 1, 6]])),
      ),
    ]
    for (const bytes of cases) expect(readJpegOrientation(bytes)).toBe(1)
  })

  it("uses only the first Exif segment (as browsers do)", () => {
    const bytes = jpeg(
      segment(0xe1, exifPayload([[0x0112, 3, 1, 8]])),
      segment(0xe1, exifPayload([[0x0112, 3, 1, 3]])),
    )
    expect(readJpegOrientation(bytes)).toBe(8)
  })

  it("swaps width and height for the 90°/270° orientations only", () => {
    const stored = { width: 4032, height: 3024 }
    for (const o of [1, 2, 3, 4] as ExifOrientation[])
      expect(orientedDimensions(stored, o)).toEqual(stored)
    for (const o of [5, 6, 7, 8] as ExifOrientation[])
      expect(orientedDimensions(stored, o)).toEqual({
        width: 3024,
        height: 4032,
      })
  })

  it("maps each orientation to the verified FFmpeg transform", () => {
    expect(ORIENTATION_FILTERS).toEqual({
      1: [],
      2: ["hflip"],
      3: ["hflip", "vflip"],
      4: ["vflip"],
      5: ["transpose=cclock_flip"],
      6: ["transpose=clock"],
      7: ["transpose=clock_flip"],
      8: ["transpose=cclock"],
    })
  })
})

describe("image normalization", () => {
  const source = (
    orientation: ExifOrientation,
    storedWidth: number,
    storedHeight: number,
  ): ImageSource => ({
    path: "/data/x.jpg",
    orientation,
    storedWidth,
    storedHeight,
  })

  it("rotates first, then scales down to at most 2160 px (never up)", () => {
    expect(imageNormalizeFilters(source(1, 1200, 1600))).toBe("null")
    expect(normalizedSize(source(1, 1200, 1600))).toEqual({
      width: 1200,
      height: 1600,
    })
    expect(imageNormalizeFilters(source(6, 4032, 3024))).toBe(
      "transpose=clock,scale=1620:2160",
    )
    expect(normalizedSize(source(6, 4032, 3024))).toEqual({
      width: 1620,
      height: 2160,
    })
    expect(imageNormalizeFilters(source(3, 6400, 4000))).toBe(
      "hflip,vflip,scale=2160:1350",
    )
    expect(imageNormalizeFilters(source(1, 2160, 100))).toBe("null")
    const huge = normalizedSize(source(8, 9000, 3000))
    expect(Math.max(huge.width, huge.height)).toBe(NORMALIZED_MAX_SIDE)
    expect(huge).toEqual({ width: 720, height: 2160 })
  })
})

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe("visual effects settings", () => {
  it("accepts exactly the named choices", () => {
    for (const motion of ["none", "gentle-zoom"])
      for (const transition of ["cut", "crossfade"])
        expect(validateVisualEffects({ motion, transition })).toEqual({
          ok: true,
          value: { motion, transition },
        })
  })

  it("rejects unknown values, extra keys and FFmpeg-looking input", () => {
    const bad: unknown[] = [
      null,
      "gentle-zoom",
      [],
      {},
      { motion: "zoom", transition: "cut" },
      { motion: "none", transition: "wipe" },
      { motion: "none", transition: "cut", zoom: 0.5 },
      { motion: "none", transition: "cut", durationFrames: 30 },
      { motion: "gentle-zoom", transition: "xfade=transition=fade:duration=9" },
      { motion: "none;rm -rf /", transition: "cut" },
      { motion: "GENTLE-ZOOM", transition: "cut" },
    ]
    for (const input of bad) expect(validateVisualEffects(input).ok).toBe(false)
    const extra = validateVisualEffects({
      motion: "none",
      transition: "cut",
      filter: "drawtext",
    })
    expect(!extra.ok && extra.issues[0].path).toBe("effects.filter")
  })

  it("defaults: new projects get gentle zoom + crossfade, old ones stay static", () => {
    expect(DEFAULT_EFFECTS).toEqual({
      motion: "gentle-zoom",
      transition: "crossfade",
    })
    expect(STATIC_EFFECTS).toEqual({ motion: "none", transition: "cut" })
    expect(describeEffects(DEFAULT_EFFECTS)).toBe("Gentle zoom · Crossfade")
    expect(describeEffects(STATIC_EFFECTS)).toBe("Still photos · Cuts")
  })

  it("keeps projects without effects valid (backward compatible) and validates stored ones", () => {
    const { project } = fixture()
    const legacy = validateVideoProject(project)
    expect(legacy.ok && legacy.value.effects).toBeUndefined()
    const withEffects = validateVideoProject({
      ...project,
      effects: DEFAULT_EFFECTS,
    })
    expect(withEffects.ok && withEffects.value.effects).toEqual(DEFAULT_EFFECTS)
    const invalid = validateVideoProject({
      ...project,
      effects: { motion: "spin", transition: "cut" },
    })
    expect(!invalid.ok && invalid.issues[0].path).toBe("effects.motion")
  })
})

// ---------------------------------------------------------------------------
// Frame math
// ---------------------------------------------------------------------------

describe("crossfade timing", () => {
  it("keeps every scene's own length with cuts", () => {
    const timings = sceneTimings([150, 120, 120], "cut")
    expect(timings.map((t) => t.clipFrames)).toEqual([150, 120, 120])
    expect(timings.every((t) => t.transitionStart === null)).toBe(true)
  })

  for (const frames of [
    [150, 120, 150],
    [150, 120, 120, 150],
    [90, 120, 120, 120, 120, 150],
    [60, 60, 60, 60, 60, 60, 60, 60],
  ])
    it(`overlaps never change the total (${frames.length} scenes)`, () => {
      const timings = sceneTimings(frames, "crossfade")
      const total = frames.reduce((a, b) => a + b, 0)
      const clips = timings.reduce((n, t) => n + t.clipFrames, 0)
      expect(clips - (frames.length - 1) * CROSSFADE.frames).toBe(total)
      expect(timings[0].leadIn).toBe(0)
      expect(timings.at(-1)!.tail).toBe(0)
      let boundary = 0
      timings.forEach((t, i) => {
        if (i > 0) {
          // Centered on the storyboard boundary: 4 frames before, 5 after.
          expect(t.transitionStart).toBe(boundary - CROSSFADE.framesBefore)
          expect(t.leadIn).toBe(CROSSFADE.framesBefore)
        }
        if (i < frames.length - 1)
          expect(t.tail).toBe(CROSSFADE.frames - CROSSFADE.framesBefore)
        boundary += frames[i]
      })
    })

  it("uses a fixed 0.3 s (9-frame) dissolve", () => {
    expect(CROSSFADE.frames).toBe(9)
    expect(CROSSFADE.frames / 30).toBeCloseTo(0.3)
  })
})

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

const product: ProductInfo = {
  name: "Trailblazer travel mug",
  headline: "Hot coffee for 12 hours",
  benefits: ["Leak-proof lid", "Fits every cup holder", "Dishwasher safe"],
  callToAction: "Tap the link to shop",
  disclosure: "#ad · I may earn a commission if you buy through my link.",
}

function fixture(
  effects?: VisualEffects,
  { benefits = 2, orientation = 1 as ExifOrientation } = {},
) {
  const ids: AssetId[] = [createAssetId(), createAssetId(), createAssetId()]
  const p = { ...product, benefits: product.benefits.slice(0, benefits) }
  const assets: MediaAsset[] = ids.map((id) => ({
    id,
    kind: "image",
    mimeType: "image/jpeg",
    sizeBytes: 1000,
    width: 1200,
    height: 1600,
    displayName: "x.jpg",
  }))
  const project: VideoProject = {
    product: p,
    assets,
    scenes: buildStoryboard(p, ids),
    settings: DEFAULT_VIDEO_SETTINGS,
    ...(effects ? { effects } : {}),
  }
  const sources = new Map<string, ImageSource>(
    ids.map((id) => [
      id,
      {
        path: `/data/jobs/job_x/assets/${id}.jpg`,
        orientation,
        storedWidth: 1600,
        storedHeight: 1200,
      },
    ]),
  )
  return { project, sources }
}

function planFor(effects?: VisualEffects, options = {}) {
  const { project, sources } = fixture(effects, options)
  return {
    project,
    plan: buildRenderPlan({
      project,
      imageSources: sources,
      fonts,
      encoder: { name: "libx264", options: encoderOptions("libx264") },
      threads: 2,
    }),
  }
}

const graphOf = (args: readonly string[]) =>
  args[args.indexOf("-filter_complex") + 1]

describe("render plan with effects", () => {
  it("renders projects without effects static with cuts", () => {
    const { plan } = planFor()
    expect(plan.effects).toEqual(STATIC_EFFECTS)
    expect(plan.scenes.every((s) => s.productOutput === null)).toBe(true)
    for (const s of plan.segments) {
      expect(graphOf(s.args)).not.toMatch(/perspective|xfade/)
    }
  })

  it("applies the EXIF transform exactly once: in normalization, never again", () => {
    const { plan } = planFor(DEFAULT_EFFECTS, { orientation: 6 })
    for (const image of plan.images) {
      expect(image.args).toContain("-noautorotate")
      expect(image.args[image.args.indexOf("-vf") + 1]).toBe("transpose=clock")
      expect({ width: image.width, height: image.height }).toEqual({
        width: 1200,
        height: 1600,
      })
    }
    // Scenes read the normalized copies, which have no EXIF, and add no
    // rotation of their own.
    for (const scene of plan.scenes) {
      expect(graphOf(scene.args)).not.toMatch(/transpose|hflip|vflip/)
      expect(scene.args[scene.args.indexOf("-i") + 1]).toMatch(
        /^file:image-\d\.png$/,
      )
    }
  })

  it("splits the product into its own layer for gentle zoom; text stays in the still", () => {
    const { plan } = planFor({ motion: "gentle-zoom", transition: "cut" })
    for (const [i, scene] of plan.scenes.entries()) {
      expect(scene.productOutput).toBe(`scene-${i + 1}-product.png`)
      const graph = graphOf(scene.args)
      // drawtext goes on the backdrop still, never on the product layer.
      const productChain = graph
        .split(";")
        .find((c) => c.endsWith("[product]"))!
      expect(productChain).not.toContain("drawtext")
      expect(productChain).toContain(
        `pad=${PRODUCT_CANVAS.width}:${PRODUCT_CANVAS.height}`,
      )
      expect(graph.split(";").find((c) => c.endsWith("[out]"))).toContain(
        "drawtext",
      )
      expect(scene.args.filter((a) => a === "-map")).toHaveLength(2)
    }
    for (const s of plan.segments) {
      const graph = graphOf(s.args)
      expect(graph).toContain("perspective=")
      expect(graph).toContain(
        `overlay=x=${PRODUCT_CANVAS.x}:y=${PRODUCT_CANVAS.y}`,
      )
    }
  })

  it("zooms by exactly GENTLE_ZOOM.amount over each clip, continuing across segments", () => {
    expect(GENTLE_ZOOM.amount).toBeGreaterThanOrEqual(0.03)
    expect(GENTLE_ZOOM.amount).toBeLessThanOrEqual(0.06)
    expect(zoomFilter(150)).toContain("(1+0.05*in/149)")
    expect(zoomFilter(155, 9)).toContain("(1+0.05*(in+9)/154)")
    const { plan, project } = planFor(DEFAULT_EFFECTS)
    const timings = sceneTimings(
      project.scenes.map((s) => s.durationFrames),
      "crossfade",
    )
    plan.segments.forEach((s, i) => {
      const graph = graphOf(s.args)
      const clip = timings[i].clipFrames
      // This scene: from clip frame 9 (its lead-in was shown in the previous dissolve).
      expect(graph).toContain(
        i === 0 ? `0.05*in/${clip - 1})` : `0.05*(in+9)/${clip - 1})`,
      )
      // The next scene's lead-in, starting its own zoom at clip frame 0.
      if (i < plan.segments.length - 1)
        expect(graph).toContain(`0.05*in/${timings[i + 1].clipFrames - 1})`)
    })
  })

  it("never lets the zoomed product reach the captions or the disclosure", () => {
    const top = PRODUCT_CANVAS.y
    const bottom = PRODUCT_CANVAS.y + PRODUCT_CANVAS.height
    const d = LAYOUT.disclosure
    const disclosureBottom =
      d.top + (d.maxLines - 1) * d.lineHeight + d.fontSize + d.border
    expect(top).toBeGreaterThan(disclosureBottom)
    // Largest caption box border: 84 px text × 0.2.
    expect(bottom).toBeLessThan(LAYOUT.caption.top - Math.round(84 * 0.2))
    expect(PRODUCT_CANVAS.x).toBeGreaterThanOrEqual(0)
    expect(PRODUCT_CANVAS.x + PRODUCT_CANVAS.width).toBeLessThanOrEqual(1080)
    // The canvas leaves exactly the zoom's room around the fit box.
    expect(PRODUCT_CANVAS.width / LAYOUT.image.maxWidth).toBeCloseTo(1.05, 2)
    expect(PRODUCT_CANVAS.height / LAYOUT.image.maxHeight).toBeCloseTo(1.05, 2)
  })

  for (const benefits of [1, 2, 3])
    it(`crossfades: exact frames and frame-exact offsets (${benefits + 2} scenes)`, () => {
      const { plan, project } = planFor(
        { motion: "none", transition: "crossfade" },
        { benefits },
      )
      const total = project.scenes.reduce((n, s) => n + s.durationFrames, 0)
      expect(plan.segments.reduce((n, s) => n + s.frames, 0)).toBe(total)
      expect(plan.totalFrames).toBe(total)
      let boundary = 0
      plan.segments.forEach((s, i) => {
        const graph = graphOf(s.args)
        const last = i === plan.segments.length - 1
        // Segment i ends where its dissolve into scene i + 1 ends: 5 frames
        // past the storyboard boundary.
        boundary += project.scenes[i].durationFrames
        expect(s.startFrame + s.frames).toBe(last ? total : boundary + 5)
        if (last) {
          expect(graph).not.toContain("xfade")
          return
        }
        const match =
          /xfade=transition=fade:duration=([\d.]+):offset=([\d.]+)/.exec(graph)!
        expect(match[1]).toBe("0.300000")
        // Offsets are whole frames, and FFmpeg rounds them back exactly.
        expect(Math.round(Number(match[2]) * 30)).toBe(s.frames - 9)
        expect(Math.abs(Number(match[2]) * 30 - (s.frames - 9))).toBeLessThan(
          1e-4,
        )
        // The incoming scene contributes exactly the 9 dissolve frames.
        expect(graph).toContain("loop=loop=8:size=1:start=0")
      })
    })

  it("generates only fixed numbers and generated names in effect graphs", () => {
    const { plan } = planFor(DEFAULT_EFFECTS)
    for (const s of plan.segments) {
      const graph = graphOf(s.args)
      expect(graph).not.toContain(product.name)
      expect(graph).not.toContain("/data/")
      for (const input of s.args.filter((_, i) => s.args[i - 1] === "-i"))
        expect(input).toMatch(/^file:scene-\d(-product)?\.png$/)
    }
  })
})

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const filters = (available: readonly string[]) =>
  EFFECT_FILTERS.map((name) => ({
    name,
    available: available.includes(name),
    required: false,
    purpose: "video" as const,
  }))

describe("effect filter availability", () => {
  it("knows which filters each effect needs", () => {
    const none = { filters: filters([]) }
    expect(missingEffectFilters(STATIC_EFFECTS, none)).toEqual([])
    expect(missingEffectFilters(DEFAULT_EFFECTS, none)).toEqual([
      "perspective",
      "pad",
      "xfade",
    ])
    expect(effectAvailability(none)).toEqual({
      gentleZoom: false,
      crossfade: false,
    })
    expect(
      effectAvailability({ filters: filters(["perspective", "pad", "xfade"]) }),
    ).toEqual({ gentleZoom: true, crossfade: true })
  })

  it("explains which choice avoids a missing filter", () => {
    expect(missingEffectsMessage(DEFAULT_EFFECTS, ["xfade"])).toBe(
      "This FFmpeg build lacks the xfade filter needed for crossfades. Choose Scene transitions: Cuts, or install a full FFmpeg build.",
    )
    expect(
      missingEffectsMessage(DEFAULT_EFFECTS, ["perspective", "xfade"]),
    ).toContain(
      "needed for gentle zoom and crossfades. Choose Product motion: None and Scene transitions: Cuts",
    )
  })
})

// ---------------------------------------------------------------------------
// Render service and queue (mocked FFmpeg)
// ---------------------------------------------------------------------------

const READY: FfmpegCapabilityReport = {
  status: "ready",
  checkedAt: "2026-11-21T00:00:00.000Z",
  ffmpeg: { available: true, version: "6.1.1", problem: null },
  ffprobe: { available: true, version: "6.1.1", problem: null },
  filters: filters(["perspective", "pad", "xfade"]),
  h264Encoders: [{ name: "libx264", hardware: false, works: true }],
  selectedH264Encoder: "libx264",
  aacEncoder: "aac",
  audio: { ready: true, missingFilters: [], reason: null },
  license: "gpl",
  issues: [],
}

const probeJson = JSON.stringify({
  streams: [
    {
      codec_type: "video",
      codec_name: "h264",
      width: 1080,
      height: 1920,
      pix_fmt: "yuv420p",
      r_frame_rate: "30/1",
      avg_frame_rate: "30/1",
    },
  ],
  format: {
    format_name: "mov,mp4",
    duration: "15.000",
    size: "4",
    tags: { major_brand: "isom" },
  },
})

/** A 1600 × 1200 JPEG header with EXIF orientation 6 (stored sideways). */
const SIDEWAYS_JPEG = withOrientation(6)

let base: string
let storage: VideoStorage

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-effects-"))
  storage = createVideoStorage(base)
})

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

async function renderingJob(effects?: VisualEffects) {
  const job = await storage.createJob()
  for (let i = 0; i < 3; i++)
    await storage.addImageAsset(job.id, {
      bytes: SIDEWAYS_JPEG,
      declaredType: "image/jpeg",
      fileName: `phone-${i}.jpg`,
    })
  const fresh = await storage.readJob(job.id)
  const project = buildTrustedProject(
    fresh,
    {
      product: { ...product, benefits: product.benefits.slice(0, 1) },
      assetIds: fresh.assets.map((a) => a.id),
      ...(effects ? { effects } : {}),
    },
    fonts,
  )
  if (!project.ok) throw new Error(JSON.stringify(project.issues))
  await storage.writeProject(job.id, project.value)
  await storage.transitionJob(job.id, "queued")
  await storage.transitionJob(job.id, "rendering")
  return { id: job.id, project: project.value }
}

/** Fake FFmpeg writing every `file:` output; can block on a given step. */
function fakeSpawn(
  hooks: {
    onCall?: (
      args: readonly string[],
      options: SpawnOptions,
    ) => Promise<void> | void
    fail?: (args: readonly string[]) => boolean
  } = {},
) {
  const calls: string[][] = []
  const spawn = (async (
    _cmd: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => {
    calls.push([...args])
    await hooks.onCall?.(args, options)
    if (options.signal?.aborted)
      return { ok: false, reason: "cancelled", exitCode: null, stderrTail: "" }
    if (hooks.fail?.(args))
      return { ok: false, reason: "failed", exitCode: 1, stderrTail: "boom" }
    for (const [i, a] of args.entries())
      if (a.startsWith("file:") && args[i - 1] !== "-i" && !a.includes("/"))
        await fs.writeFile(path.join(options.cwd, a.slice(5)), "fake")
    return { ok: true, stderrTail: "" }
  }) as Spawner & { calls: string[][] }
  spawn.calls = calls
  return spawn
}

function deps(overrides: Partial<RenderDeps> = {}): RenderDeps {
  return {
    storage,
    spawn: fakeSpawn(),
    run: async () => ({ ok: true, stdout: probeJson, stderr: "" }),
    lease,
    getCapabilities: async () => READY,
    commands: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
    fonts,
    fontDir: fontDirectory(),
    threads: 2,
    timeouts: { sceneMs: 1000, encodeMs: 1000 },
    ...overrides,
  }
}

describe("render service with effects (mocked FFmpeg)", () => {
  it("stores the upright size of a sideways phone photo", async () => {
    const { project } = await renderingJob()
    expect(project.assets[0]).toMatchObject({ width: 1200, height: 1600 })
  })

  it("normalizes with the photo's own EXIF, renders zoom + crossfade, cleans up", async () => {
    const { id, project } = await renderingJob(DEFAULT_EFFECTS)
    const spawn = fakeSpawn()
    await renderVideo(id, deps({ spawn }), () => {})
    const normalize = spawn.calls.filter((a) => a.includes("-noautorotate"))
    // Once per photo the storyboard uses, even when scenes share a photo.
    expect(normalize).toHaveLength(
      new Set(project.scenes.map((s) => s.assetId)).size,
    )
    for (const a of normalize)
      expect(a[a.indexOf("-vf") + 1]).toBe("transpose=clock")
    const segments = spawn.calls.filter((a) => a.includes("-progress"))
    expect(segments.map(graphOf).every((g) => g.includes("perspective"))).toBe(
      true,
    )
    expect(
      segments.slice(0, -1).every((a) => graphOf(a).includes("xfade")),
    ).toBe(true)
    expect(await fs.readdir(await storage.workDir(id))).toEqual([])
  })

  it("fails before any FFmpeg work when an effect's filter is missing", async () => {
    const { id } = await renderingJob(DEFAULT_EFFECTS)
    const spawn = fakeSpawn()
    await expect(
      renderVideo(
        id,
        deps({
          spawn,
          lease,
          getCapabilities: async () => ({
            ...READY,
            filters: filters(["pad"]),
          }),
        }),
        () => {},
      ),
    ).rejects.toMatchObject({ code: "effects-unavailable" })
    expect(spawn.calls).toEqual([])
  })

  it("still renders static projects on a build without effect filters", async () => {
    const { id } = await renderingJob(STATIC_EFFECTS)
    await expect(
      renderVideo(
        id,
        deps({ getCapabilities: async () => ({ ...READY, filters: [] }) }),
        () => {},
      ),
    ).resolves.toMatchObject({ width: 1080 })
  })

  for (const [stage, match] of [
    ["normalization", (a: readonly string[]) => a.includes("-noautorotate")],
    [
      "a zoom/crossfade segment",
      (a: readonly string[]) => a.includes("-progress"),
    ],
    ["joining", (a: readonly string[]) => a.includes("concat")],
  ] as const)
    it(`cancels during ${stage}, stops FFmpeg and leaves no scratch files`, async () => {
      const { id } = await renderingJob(DEFAULT_EFFECTS)
      const controller = new AbortController()
      const spawn = fakeSpawn({
        onCall: (args) => {
          if (match(args)) controller.abort()
        },
      })
      await expect(
        renderVideo(id, deps({ spawn }), () => {}, controller.signal),
      ).rejects.toBeInstanceOf(RenderCancelled)
      // Nothing after the cancelled step ran.
      expect(spawn.calls.filter(match)).toHaveLength(1)
      expect(await fs.readdir(await storage.workDir(id))).toEqual([])
    })

  it("retries a failed effects render with the same saved settings", async () => {
    const { id } = await renderingJob({
      motion: "gentle-zoom",
      transition: "cut",
    })
    const graphs: string[] = []
    let failNext = true
    const spawn = fakeSpawn({
      fail: (args) => {
        if (!args.includes("-progress")) return false
        graphs.push(graphOf(args))
        if (failNext) {
          failNext = false
          return true
        }
        return false
      },
    })
    const queue = new RenderQueue(
      storage,
      (jobId, onProgress, signal) =>
        renderVideo(jobId, deps({ spawn }), onProgress, signal),
      () => {},
    )
    // The job is "rendering" from the helper: mark it failed as a crash would.
    await storage.transitionJob(id, "failed", {
      error: { code: "render-failed", message: "x" },
    })
    await queue.retry(id)
    await queue.whenIdle()
    expect((await storage.readJob(id)).state).toBe("failed")
    await queue.retry(id)
    await queue.whenIdle()
    const job = await storage.readJob(id)
    expect(job.state).toBe("completed")
    expect((await storage.readProject(id)).effects).toEqual({
      motion: "gentle-zoom",
      transition: "cut",
    })
    // Both attempts zoomed, neither crossfaded.
    expect(graphs.every((g) => g.includes("perspective"))).toBe(true)
    expect(graphs.some((g) => g.includes("xfade"))).toBe(false)
    expect(await fs.readdir(await storage.workDir(id))).toEqual([])
  })
})
