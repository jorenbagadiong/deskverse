import { describe, expect, it } from "vitest"

import {
  aspectRatioOf,
  formatDuration,
  MAX_SCENE_FRAMES,
  MAX_TOTAL_FRAMES,
  MIN_SCENE_FRAMES,
  MIN_TOTAL_FRAMES,
  VIDEO_FORMAT,
} from "@/lib/video/format"
import {
  createAssetId,
  createRenderJobId,
  isAssetId,
  isRenderJobId,
  type AssetId,
} from "@/lib/video/ids"
import {
  canTransition,
  isTerminalState,
  RENDER_JOB_STATES,
} from "@/lib/video/render-job"
import {
  buildStoryboard,
  fitDurations,
  storyboardFrames,
} from "@/lib/video/storyboard"
import type { ProductInfo } from "@/lib/video/types"
import {
  DEFAULT_VIDEO_SETTINGS,
  MEDIA_LIMITS,
  normalizeText,
  sanitizeDisplayName,
  TEXT_LIMITS,
  validateMediaMetadata,
  validateProduct,
  validateSceneDuration,
  validateScenes,
  validateTotalDuration,
  validateVideoProject,
  validateVideoSettings,
} from "@/lib/video/validation"

const product = (overrides: Partial<ProductInfo> = {}): ProductInfo => ({
  name: "AeroPress Go",
  headline: "Barista coffee anywhere",
  benefits: ["Brews in one minute", "Fits in a backpack", "Easy to clean"],
  callToAction: "Tap the link to shop",
  disclosure: "#ad · I earn a commission from qualifying purchases.",
  ...overrides,
})

const image = (overrides: Record<string, unknown> = {}) => ({
  fileName: "hero.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 2_000_000,
  width: 1200,
  height: 1600,
  ...overrides,
})

const asset = (id: AssetId) => ({
  id,
  kind: "image",
  mimeType: "image/png",
  sizeBytes: 500_000,
  width: 1080,
  height: 1920,
  displayName: "shot.png",
})

function issuesOf(result: { ok: boolean; issues?: { path: string }[] }) {
  return result.ok ? [] : (result.issues ?? []).map((i) => i.path)
}

describe("video format", () => {
  it("is a 1080×1920, 9:16, 30 fps H.264 MP4", () => {
    expect(VIDEO_FORMAT).toMatchObject({
      width: 1080,
      height: 1920,
      aspectRatio: "9:16",
      fps: 30,
      container: "mp4",
      videoCodec: "h264",
      pixelFormat: "yuv420p",
      audio: "none",
    })
  })

  it("has a resolution that actually reduces to its declared aspect ratio", () => {
    expect(aspectRatioOf(VIDEO_FORMAT.width, VIDEO_FORMAT.height)).toBe(
      VIDEO_FORMAT.aspectRatio,
    )
    expect(VIDEO_FORMAT.width / VIDEO_FORMAT.height).toBeCloseTo(9 / 16)
    // H.264 with 4:2:0 chroma needs even dimensions.
    expect(VIDEO_FORMAT.width % 2).toBe(0)
    expect(VIDEO_FORMAT.height % 2).toBe(0)
  })

  it("targets 15–30 seconds", () => {
    expect(MIN_TOTAL_FRAMES).toBe(15 * 30)
    expect(MAX_TOTAL_FRAMES).toBe(30 * 30)
    expect(formatDuration(450)).toBe("15 s")
    expect(formatDuration(375)).toBe("12.5 s")
  })

  it("only accepts the exact default settings", () => {
    expect(validateVideoSettings(DEFAULT_VIDEO_SETTINGS).ok).toBe(true)
    for (const bad of [
      { ...DEFAULT_VIDEO_SETTINGS, width: 720 },
      { ...DEFAULT_VIDEO_SETTINGS, height: 1280 },
      { ...DEFAULT_VIDEO_SETTINGS, fps: 60 },
      { ...DEFAULT_VIDEO_SETTINGS, videoCodec: "hevc" },
      { ...DEFAULT_VIDEO_SETTINGS, container: "mov" },
      { ...DEFAULT_VIDEO_SETTINGS, audio: "aac" },
    ])
      expect(validateVideoSettings(bad).ok, JSON.stringify(bad)).toBe(false)
  })

  it("rejects FFmpeg arguments smuggled in as extra settings", () => {
    const result = validateVideoSettings({
      ...DEFAULT_VIDEO_SETTINGS,
      ffmpegArgs: ["-f", "lavfi", "-i", "/etc/passwd"],
    })
    expect(issuesOf(result)).toEqual(["settings.ffmpegArgs"])
    expect(
      validateVideoSettings({ ...DEFAULT_VIDEO_SETTINGS, filter: "x" }).ok,
    ).toBe(false)
  })

  it("rejects non-object settings", () => {
    for (const bad of [null, "1080x1920", [], 42, undefined])
      expect(validateVideoSettings(bad).ok).toBe(false)
  })
})

describe("identifiers and job states", () => {
  it("generates unique IDs that match their strict patterns", () => {
    const ids = new Set(Array.from({ length: 200 }, () => createRenderJobId()))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(isRenderJobId(id)).toBe(true)
    expect(isAssetId(createAssetId())).toBe(true)
  })

  it("rejects anything that isn't a generated ID", () => {
    for (const bad of [
      "",
      "job_",
      "job_../../etc",
      `job_${"A".repeat(32)}`,
      `job_${"a".repeat(31)}`,
      `job_${"a".repeat(32)}/x`,
      `asset_${"a".repeat(32)}`,
      "../job_" + "a".repeat(32),
      42,
      null,
    ])
      expect(isRenderJobId(bad), String(bad)).toBe(false)
    expect(isAssetId(`job_${"a".repeat(32)}`)).toBe(false)
  })

  it("only allows the documented state transitions", () => {
    expect(canTransition("draft", "queued")).toBe(true)
    expect(canTransition("queued", "rendering")).toBe(true)
    expect(canTransition("rendering", "completed")).toBe(true)
    expect(canTransition("failed", "queued")).toBe(true)
    expect(canTransition("draft", "completed")).toBe(false)
    expect(canTransition("completed", "rendering")).toBe(false)
    expect(RENDER_JOB_STATES.filter(isTerminalState)).toEqual([
      "completed",
      "cancelled",
    ])
  })
})

describe("text validation", () => {
  it("accepts a complete product and normalizes whitespace", () => {
    const result = validateProduct(
      product({ name: "  AeroPress\n  Go ", headline: "Cafe\u0301 quality" }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.name).toBe("AeroPress Go")
    // NFC: e + combining acute becomes é.
    expect(result.value.headline).toBe("Café quality")
  })

  it("requires every field and explains what's missing", () => {
    const result = validateProduct(
      product({ name: " ", headline: "", callToAction: "", disclosure: "" }),
    )
    expect(issuesOf(result)).toEqual([
      "name",
      "headline",
      "callToAction",
      "disclosure",
    ])
    if (result.ok) return
    expect(result.issues[0].message).toBe("Enter a product name.")
    expect(result.issues[3].message).toMatch(/commission/)
  })

  it("enforces length limits in characters, not bytes", () => {
    const exactly = "é".repeat(TEXT_LIMITS.name)
    expect(validateProduct(product({ name: exactly })).ok).toBe(true)
    const result = validateProduct(product({ name: `${exactly}x` }))
    expect(issuesOf(result)).toEqual(["name"])
    if (!result.ok)
      expect(result.issues[0].message).toMatch(/60 characters or fewer/)
    // Emoji count as one character each.
    expect(validateProduct(product({ name: "☕".repeat(60) })).ok).toBe(true)
  })

  it("rejects control, bidi-override and other invisible characters", () => {
    for (const sneaky of [
      "Price\u0000",
      "Buy \u202Enow",
      "Zero\u200Bwidth",
      "Private\uE000use",
      "Lone \uD800 surrogate",
    ])
      expect(validateProduct(product({ name: sneaky })).ok, sneaky).toBe(false)
    // Emoji ZWJ sequences stay allowed.
    expect(
      validateProduct(
        product({ name: "Family \u{1F469}\u200D\u{1F469}\u200D\u{1F467}" }),
      ).ok,
    ).toBe(true)
  })

  it("needs 1–5 benefits, each filled in", () => {
    expect(issuesOf(validateProduct(product({ benefits: [] })))).toEqual([
      "benefits",
    ])
    expect(
      issuesOf(validateProduct(product({ benefits: Array(6).fill("Great") }))),
    ).toEqual(["benefits"])
    const blank = validateProduct(product({ benefits: ["Fast", "  "] }))
    expect(issuesOf(blank)).toEqual(["benefits.1"])
    if (!blank.ok)
      expect(blank.issues[0].message).toBe("Enter benefit 2 or remove it.")
  })

  it("rejects unsupported input shapes", () => {
    expect(validateProduct(null).ok).toBe(false)
    expect(validateProduct("AeroPress").ok).toBe(false)
    expect(validateProduct([]).ok).toBe(false)
    expect(validateProduct(product({ name: 42 as unknown as string })).ok).toBe(
      false,
    )
    expect(
      issuesOf(validateProduct({ ...product(), command: "rm -rf /" })),
    ).toEqual(["command"])
    // Prototype tricks are not plain objects.
    expect(validateProduct(Object.create({ name: "x" })).ok).toBe(false)
  })

  it("collapses newlines so captions stay on one line", () => {
    expect(normalizeText("Line one\r\nline\ttwo")).toBe("Line one line two")
  })
})

describe("media metadata validation", () => {
  it("accepts JPEG, PNG and WebP within limits", () => {
    expect(validateMediaMetadata(image()).ok).toBe(true)
    expect(
      validateMediaMetadata(image({ fileName: "a.PNG", mimeType: "image/png" }))
        .ok,
    ).toBe(true)
    expect(
      validateMediaMetadata(
        image({ fileName: "a.webp", mimeType: "image/webp" }),
      ).ok,
    ).toBe(true)
  })

  it("rejects unsafe or unsupported file types", () => {
    for (const [fileName, mimeType] of [
      ["logo.svg", "image/svg+xml"],
      ["anim.gif", "image/gif"],
      ["page.html", "text/html"],
      ["clip.mp4", "video/mp4"],
      ["run.exe", "application/octet-stream"],
    ])
      expect(
        validateMediaMetadata(image({ fileName, mimeType })).ok,
        fileName,
      ).toBe(false)
  })

  it("rejects extensions that don't match the type", () => {
    expect(validateMediaMetadata(image({ fileName: "hero.png" })).ok).toBe(
      false,
    )
    expect(validateMediaMetadata(image({ fileName: "hero" })).ok).toBe(false)
    expect(validateMediaMetadata(image({ fileName: "hero.jpg.svg" })).ok).toBe(
      false,
    )
  })

  it("rejects empty and oversized files", () => {
    expect(validateMediaMetadata(image({ sizeBytes: 0 })).ok).toBe(false)
    expect(validateMediaMetadata(image({ sizeBytes: -5 })).ok).toBe(false)
    expect(validateMediaMetadata(image({ sizeBytes: 1.5 })).ok).toBe(false)
    expect(
      validateMediaMetadata(image({ sizeBytes: MEDIA_LIMITS.maxBytes })).ok,
    ).toBe(true)
    const big = validateMediaMetadata(
      image({ sizeBytes: MEDIA_LIMITS.maxBytes + 1 }),
    )
    expect(big.ok).toBe(false)
    if (!big.ok) expect(big.issues[0].message).toMatch(/10 MB or smaller/)
  })

  it("rejects images that are too small or too large", () => {
    expect(validateMediaMetadata(image({ width: 319 })).ok).toBe(false)
    expect(validateMediaMetadata(image({ width: 320, height: 320 })).ok).toBe(
      true,
    )
    expect(validateMediaMetadata(image({ width: 9000 })).ok).toBe(false)
    expect(validateMediaMetadata(image({ width: 8000, height: 8000 })).ok).toBe(
      false,
    )
    expect(validateMediaMetadata(image({ width: Number.NaN })).ok).toBe(false)
  })

  it("keeps only a harmless display name", () => {
    expect(sanitizeDisplayName("../../etc/passwd")).toBe("passwd")
    expect(sanitizeDisplayName("C:\\Users\\me\\shot.png")).toBe("shot.png")
    expect(sanitizeDisplayName("evil\u202Egnp.exe")).toBe("evilgnp.exe")
    expect(sanitizeDisplayName("")).toBe("image")
    expect(Array.from(sanitizeDisplayName("a".repeat(500))).length).toBe(100)
  })

  it("rejects unknown metadata fields such as a server path", () => {
    expect(
      issuesOf(validateMediaMetadata({ ...image(), path: "/etc/passwd" })),
    ).toEqual(["path"])
  })
})

describe("storyboard and scene durations", () => {
  const ids = [createAssetId(), createAssetId()]

  it("builds hook → benefits → call to action", () => {
    const scenes = buildStoryboard(product(), ids)
    expect(scenes.map((s) => s.kind)).toEqual([
      "hook",
      "benefit",
      "benefit",
      "benefit",
      "call-to-action",
    ])
    expect(scenes.map((s) => s.id)).toEqual([
      "scene-1",
      "scene-2",
      "scene-3",
      "scene-4",
      "scene-5",
    ])
    expect(scenes[0].caption).toMatchObject({
      text: "Barista coffee anywhere",
      subtext: "AeroPress Go",
    })
    expect(scenes.at(-1)!.caption.text).toBe("Tap the link to shop")
    // Hero image opens and closes; benefits cycle through the others.
    expect(scenes.map((s) => s.assetId)).toEqual([
      ids[0],
      ids[1],
      ids[0],
      ids[1],
      ids[0],
    ])
  })

  it("always lands within 15–30 s, every scene within 2–8 s, in whole frames", () => {
    for (let n = 1; n <= 5; n++) {
      const scenes = buildStoryboard(
        product({
          benefits: Array.from({ length: n }, (_, i) => `Benefit ${i}`),
        }),
        ids,
      )
      const total = storyboardFrames(scenes)
      expect(total, `${n} benefits`).toBeGreaterThanOrEqual(MIN_TOTAL_FRAMES)
      expect(total, `${n} benefits`).toBeLessThanOrEqual(MAX_TOTAL_FRAMES)
      for (const scene of scenes) {
        expect(Number.isInteger(scene.durationFrames)).toBe(true)
        expect(scene.durationFrames).toBeGreaterThanOrEqual(MIN_SCENE_FRAMES)
        expect(scene.durationFrames).toBeLessThanOrEqual(MAX_SCENE_FRAMES)
      }
      expect(validateScenes(scenes, new Set(ids)).ok, `${n} benefits`).toBe(
        true,
      )
    }
  })

  it("stretches a short storyboard to exactly 15 s", () => {
    const scenes = buildStoryboard(product({ benefits: ["Only one"] }), ids)
    expect(storyboardFrames(scenes)).toBe(MIN_TOTAL_FRAMES)
  })

  it("fits durations into range and distributes rounding frames", () => {
    expect(fitDurations([90, 120, 120]).reduce((a, b) => a + b)).toBe(450)
    expect(
      fitDurations([240, 240, 240, 240, 240]).reduce((a, b) => a + b),
    ).toBe(900)
    expect(fitDurations([100, 100, 100, 100, 100])).toEqual([
      100, 100, 100, 100, 100,
    ])
  })

  it("uses solid backgrounds when there are no images", () => {
    expect(
      buildStoryboard(product(), []).every((s) => s.assetId === null),
    ).toBe(true)
  })

  it("validates individual scene durations", () => {
    expect(validateSceneDuration(60).ok).toBe(true)
    expect(validateSceneDuration(240).ok).toBe(true)
    expect(validateSceneDuration(59).ok).toBe(false)
    expect(validateSceneDuration(241).ok).toBe(false)
    expect(validateSceneDuration(90.5).ok).toBe(false)
    expect(validateSceneDuration("90").ok).toBe(false)
  })

  it("validates the total duration", () => {
    expect(validateTotalDuration(449).ok).toBe(false)
    expect(validateTotalDuration(450).ok).toBe(true)
    expect(validateTotalDuration(900).ok).toBe(true)
    expect(validateTotalDuration(901).ok).toBe(false)
  })

  it("rejects tampered scenes", () => {
    const known = new Set<string>(ids)
    const good = buildStoryboard(product(), ids)
    const tamper = (fn: (s: ReturnType<typeof buildStoryboard>) => unknown) => {
      const copy = structuredClone(good)
      fn(copy)
      return validateScenes(copy, known)
    }
    expect(tamper(() => {}).ok).toBe(true)
    expect(tamper((s) => (s[1].durationFrames = 10)).ok).toBe(false)
    expect(tamper((s) => (s[1].assetId = createAssetId())).ok).toBe(false)
    expect(tamper((s) => (s[1].id = "scene-1")).ok).toBe(false)
    expect(tamper((s) => (s[0].kind = "benefit")).ok).toBe(false)
    expect(tamper((s) => (s[1].caption.text = "x".repeat(81))).ok).toBe(false)
    expect(
      tamper((s) =>
        Object.assign(s[1], { filter: "drawtext=textfile=/etc/passwd" }),
      ).ok,
    ).toBe(false)
    expect(
      tamper((s) => Object.assign(s[1].caption, { fontfile: "/etc/passwd" }))
        .ok,
    ).toBe(false)
    // Too long overall: every scene at 8 s.
    expect(tamper((s) => s.forEach((x) => (x.durationFrames = 240))).ok).toBe(
      false,
    )
    expect(validateScenes(good.slice(0, 2), known).ok).toBe(false)
  })
})

describe("whole project validation", () => {
  it("accepts a consistent project and rejects broken references", () => {
    const ids = [createAssetId()]
    const project = {
      product: product(),
      assets: ids.map(asset),
      scenes: buildStoryboard(product(), ids),
      settings: DEFAULT_VIDEO_SETTINGS,
    }
    expect(validateVideoProject(project).ok).toBe(true)
    expect(validateVideoProject({ ...project, assets: [] }).ok).toBe(false)
    expect(
      validateVideoProject({
        ...project,
        settings: { ...DEFAULT_VIDEO_SETTINGS, fps: 24 },
      }).ok,
    ).toBe(false)
    expect(
      validateVideoProject({ ...project, outputPath: "/tmp/x.mp4" }).ok,
    ).toBe(false)
    expect(
      validateVideoProject({
        ...project,
        assets: [{ ...asset(ids[0]), id: "../../secret" }],
      }).ok,
    ).toBe(false)
  })
})
