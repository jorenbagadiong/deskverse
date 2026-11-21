import { describe, expect, it } from "vitest"

import { createAssetId, type AssetId } from "@/lib/video/ids"
import { buildStoryboard } from "@/lib/video/storyboard"
import type { MediaAsset, ProductInfo, VideoProject } from "@/lib/video/types"
import { DEFAULT_VIDEO_SETTINGS } from "@/lib/video/validation"
import {
  buildRenderPlan,
  encoderOptions,
  escapeFilterValue,
  fitText,
  LAYOUT,
  wrapBalanced,
  wrapText,
} from "@/server/video/ffmpeg-command"
import {
  createProgressParser,
  imageDecodeArgs,
  imageProbeArgs,
  outputProbeArgs,
  parseImageProbe,
  verifyOutputProbe,
} from "@/server/video/ffprobe"
import {
  FontParseError,
  loadVideoFont,
  measureText,
  missingGlyphs,
  parseFont,
} from "@/server/video/font-metrics"

const fonts = { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") }

const product = (overrides: Partial<ProductInfo> = {}): ProductInfo => ({
  name: "Trailblazer travel mug",
  headline: "Hot coffee for 12 hours",
  benefits: ["Leak-proof lid", "Fits every cup holder"],
  callToAction: "Tap the link to shop",
  disclosure: "#ad · I may earn a commission if you buy through my link.",
  ...overrides,
})

function project(overrides: Partial<ProductInfo> = {}): {
  project: VideoProject
  paths: Map<string, string>
} {
  const ids: AssetId[] = [createAssetId(), createAssetId(), createAssetId()]
  const p = product(overrides)
  const assets: MediaAsset[] = ids.map((id) => ({
    id,
    kind: "image",
    mimeType: "image/jpeg",
    sizeBytes: 1000,
    width: 1200,
    height: 1600,
    displayName: "x.jpg",
  }))
  return {
    project: {
      product: p,
      assets,
      scenes: buildStoryboard(p, ids),
      settings: DEFAULT_VIDEO_SETTINGS,
    },
    paths: new Map(
      ids.map((id) => [
        id,
        `/data/deskverse/video/jobs/job_x/assets/${id}.jpg`,
      ]),
    ),
  }
}

const plan = (overrides: Partial<ProductInfo> = {}) => {
  const { project: p, paths } = project(overrides)
  return {
    project: p,
    paths,
    plan: buildRenderPlan({
      project: p,
      assetPaths: paths,
      fonts,
      encoder: { name: "libx264", options: encoderOptions("libx264") },
      threads: 4,
    }),
  }
}

describe("bundled video font", () => {
  it("parses Inter and measures real glyph widths", () => {
    expect(fonts.bold.unitsPerEm).toBeGreaterThan(0)
    expect(fonts.bold.hasGlyph("A".codePointAt(0)!)).toBe(true)
    expect(fonts.bold.hasGlyph("é".codePointAt(0)!)).toBe(true)
    // Proportional: "W" is wider than "i", bold wider than medium.
    expect(measureText(fonts.bold, "W", 80)).toBeGreaterThan(
      measureText(fonts.bold, "i", 80),
    )
    expect(measureText(fonts.bold, "Hello", 80)).toBeGreaterThan(
      measureText(fonts.medium, "Hello", 80),
    )
  })

  it("reports characters the font can't draw", () => {
    expect(missingGlyphs(fonts.bold, "Café 12% · “quoted” — fine")).toEqual([])
    expect(missingGlyphs(fonts.bold, "Coffee ☕ 咖啡")).toEqual([
      "☕",
      "咖",
      "啡",
    ])
  })

  it("rejects files that aren't fonts", () => {
    expect(() => parseFont(new TextEncoder().encode("<svg></svg>"))).toThrow(
      FontParseError,
    )
    expect(() => parseFont(new Uint8Array(4))).toThrow(FontParseError)
  })
})

describe("caption layout", () => {
  it("wraps by measured width and keeps every line inside the safe column", () => {
    const text =
      "Leak-proof lid that survives every backpack, commute and road trip"
    const lines = wrapText(fonts.bold, text, 76, LAYOUT.textWidth)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join(" ")).toBe(text)
    for (const line of lines)
      expect(measureText(fonts.bold, line, 76)).toBeLessThanOrEqual(
        LAYOUT.textWidth,
      )
  })

  it("breaks a single over-long word by character", () => {
    const word = "Supercalifragilisticexpialidociously-long-model-name"
    const lines = wrapText(fonts.bold, word, 84, LAYOUT.textWidth)
    expect(lines.join("")).toBe(word)
    for (const line of lines)
      expect(measureText(fonts.bold, line, 84)).toBeLessThanOrEqual(
        LAYOUT.textWidth,
      )
  })

  it("balances lines instead of leaving an orphan word", () => {
    const text = "#ad · I may earn a commission if you buy through my link."
    const greedy = wrapText(fonts.medium, text, 32, LAYOUT.textWidth)
    const balanced = wrapBalanced(fonts.medium, text, 32, LAYOUT.textWidth)
    expect(balanced).toHaveLength(greedy.length)
    const spread = (lines: string[]) => {
      const widths = lines.map((l) => measureText(fonts.medium, l, 32))
      return Math.max(...widths) - Math.min(...widths)
    }
    expect(spread(balanced)).toBeLessThan(spread(greedy))
  })

  it("shrinks text to fit at most three lines in the caption block", () => {
    const long = "x ".repeat(40).trim()
    const fitted = fitText(fonts.bold, long, {
      maxSize: 84,
      minSize: 52,
      maxWidth: LAYOUT.textWidth,
      maxLines: 3,
      maxBlockHeight: LAYOUT.caption.maxBlockHeight,
    })
    expect(fitted.fontSize).toBeLessThan(84)
    expect(fitted.lines.length).toBeLessThanOrEqual(3)
    expect(fitted.lines.length * fitted.lineHeight).toBeLessThanOrEqual(
      LAYOUT.caption.maxBlockHeight,
    )
    const short = fitText(fonts.bold, "Tap to shop", {
      maxSize: 84,
      minSize: 52,
      maxWidth: LAYOUT.textWidth,
      maxLines: 3,
      maxBlockHeight: LAYOUT.caption.maxBlockHeight,
    })
    expect(short).toMatchObject({ fontSize: 84, lines: ["Tap to shop"] })
  })
})

describe("FFmpeg filter escaping", () => {
  it("escapes option- and graph-level special characters", () => {
    expect(escapeFilterValue("plain.txt")).toBe("plain.txt")
    expect(escapeFilterValue("a:b")).toBe("a\\\\:b")
    expect(escapeFilterValue("it's")).toBe("it\\\\\\'s")
    expect(escapeFilterValue("[out];x,y")).toBe("\\[out\\]\\;x\\,y")
    expect(escapeFilterValue("back\\slash")).toBe("back\\\\\\\\slash")
  })

  it("refuses NUL and line breaks", () => {
    expect(() => escapeFilterValue("a\nb")).toThrow()
    expect(() => escapeFilterValue("a\0b")).toThrow()
  })
})

describe("render plan (safe FFmpeg arguments)", () => {
  const hostile = {
    name: 'Mug\'; rm -rf ~; echo "$(id)"',
    headline: "%{pts} %{eif:1:d} [out] text='x':fontfile=/etc/passwd",
    benefits: [
      "50% off; drawtext=textfile=/etc/shadow",
      "Back\\slash, comma: colon",
    ],
    callToAction: "Shop -> now | `whoami`",
  }

  it("never puts caption text into arguments or filter graphs", () => {
    const { plan: p } = plan(hostile)
    const allArgs = [...p.scenes.flatMap((s) => s.args), ...p.encode.args].join(
      "\n",
    )
    for (const text of [
      hostile.name,
      hostile.headline,
      ...hostile.benefits,
      hostile.callToAction,
    ])
      expect(allArgs).not.toContain(text)
    expect(allArgs).not.toMatch(/etc\/(passwd|shadow)|whoami|rm -rf|%\{/)
  })

  it("writes the exact caption text to UTF-8 files drawn with expansion=none", () => {
    const { plan: p } = plan(hostile)
    const files = p.scenes.flatMap((s) => s.textFiles)
    const drawn = files.map((f) => f.content).join(" ")
    expect(drawn).toContain("%{pts}")
    expect(drawn).toContain("50% off;")
    for (const file of files) expect(file.name).toMatch(/^[a-z0-9-]+\.txt$/)
    for (const scene of p.scenes) {
      const graph = scene.args[scene.args.indexOf("-filter_complex") + 1]
      const draws = graph.match(/drawtext=[^,;]+/g) ?? []
      expect(draws.length).toBe(scene.textFiles.length)
      for (const draw of draws) {
        expect(draw).toContain("expansion=none")
        expect(draw).toMatch(
          /textfile=scene-\d+-(disclosure-\d+|caption-\d+|subtext)\.txt/,
        )
        expect(draw).toMatch(/fontfile=font-(bold|medium)\.ttf/)
      }
    }
  })

  it("shows the disclosure on every scene and the product name on hook and CTA", () => {
    const { plan: p, project: proj } = plan()
    for (const scene of p.scenes)
      expect(scene.textFiles.some((f) => f.name.includes("disclosure"))).toBe(
        true,
      )
    const subtexts = p.scenes.map((s) =>
      s.textFiles.find((f) => f.name.endsWith("subtext.txt")),
    )
    expect(subtexts[0]?.content).toBe(proj.product.name)
    expect(subtexts.at(-1)?.content).toBe(proj.product.name)
    expect(subtexts.slice(1, -1).every((s) => s === undefined)).toBe(true)
  })

  it("composes scenes from stored images with safe input handling", () => {
    const { plan: p, paths } = plan()
    for (const scene of p.scenes) {
      expect(scene.args.slice(0, 4)).toEqual([
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
      ])
      expect(scene.args).toContain("-protocol_whitelist")
      const input = scene.args[scene.args.indexOf("-i") + 1]
      expect(input).toBe(`file:${scene.inputPath}`)
      expect([...paths.values()]).toContain(scene.inputPath)
      expect(scene.args.at(-1)).toMatch(/^file:scene-\d+\.png$/)
      const graph = scene.args[scene.args.indexOf("-filter_complex") + 1]
      // Image paths stay out of the graph; images keep their proportions.
      expect(graph).not.toContain("/data/")
      expect(graph).toContain("force_original_aspect_ratio=decrease")
    }
  })

  it("encodes H.264 yuv420p at 30 fps, silent, exact frame count, faststart", () => {
    const { plan: p, project: proj } = plan()
    const args = p.encode.args
    const value = (flag: string) => args[args.indexOf(flag) + 1]
    expect(value("-c:v")).toBe("libx264")
    expect(value("-pix_fmt")).toBe("yuv420p")
    expect(value("-r")).toBe("30")
    expect(value("-movflags")).toBe("+faststart")
    expect(value("-f")).toBe("mp4")
    expect(value("-progress")).toBe("pipe:1")
    expect(args).toContain("-an")
    expect(args).toContain("-nostdin")
    const total = proj.scenes.reduce((n, s) => n + s.durationFrames, 0)
    expect(p.totalFrames).toBe(total)
    expect(value("-frames:v")).toBe(String(total))
    const graph = value("-filter_complex")
    for (const scene of proj.scenes)
      expect(graph).toContain(
        `loop=loop=${scene.durationFrames - 1}:size=1:start=0`,
      )
    // Single still-frame inputs (no -loop): memory doesn't grow with length.
    expect(args).not.toContain("-loop")
    expect(graph).toContain("settb=1/30,setpts=N")
    expect(graph).toContain(`concat=n=${proj.scenes.length}:v=1:a=0`)
    expect(args.at(-1)).toBe("file:render.mp4")
  })

  it("uses fixed per-encoder options", () => {
    expect(encoderOptions("libx264")).toContain("-crf")
    expect(encoderOptions("libopenh264")).toEqual(["-b:v", "6M"])
    expect(encoderOptions("h264_nvenc")).toEqual(["-b:v", "8M"])
  })

  it("refuses a scene whose image isn't in the plan's asset map", () => {
    const { project: proj } = project()
    expect(() =>
      buildRenderPlan({
        project: proj,
        assetPaths: new Map(),
        fonts,
        encoder: { name: "libx264", options: [] },
        threads: 1,
      }),
    ).toThrow(/unknown image/)
  })
})

describe("FFprobe parsing", () => {
  it("builds read-only probe commands with the file protocol", () => {
    for (const args of [
      imageProbeArgs("/x/a.jpg"),
      outputProbeArgs("/x/v.mp4"),
    ]) {
      expect(args).toContain("-protocol_whitelist")
      expect(args.at(-1)).toMatch(/^file:\/x\//)
    }
    expect(imageDecodeArgs("/x/a.jpg").slice(-3)).toEqual(["-f", "null", "-"])
  })

  it("accepts an image whose codec and size match the sniffed header", () => {
    const stdout = JSON.stringify({
      streams: [{ codec_name: "mjpeg", width: 1200, height: 1600 }],
    })
    expect(
      parseImageProbe(stdout, {
        mimeType: "image/jpeg",
        width: 1200,
        height: 1600,
      }).ok,
    ).toBe(true)
  })

  it("rejects mismatched, empty or unreadable probe results", () => {
    const expected = {
      mimeType: "image/png" as const,
      width: 1200,
      height: 1600,
    }
    expect(
      parseImageProbe(
        JSON.stringify({
          streams: [{ codec_name: "mjpeg", width: 1200, height: 1600 }],
        }),
        expected,
      ).ok,
    ).toBe(false)
    expect(
      parseImageProbe(
        JSON.stringify({
          streams: [{ codec_name: "png", width: 10, height: 10 }],
        }),
        expected,
      ).ok,
    ).toBe(false)
    expect(parseImageProbe(JSON.stringify({ streams: [] }), expected).ok).toBe(
      false,
    )
    expect(parseImageProbe("not json", expected).ok).toBe(false)
  })

  const goodOutput = (
    patch: { format?: object; stream?: object; extraStreams?: object[] } = {},
  ) =>
    JSON.stringify({
      streams: [
        {
          index: 0,
          codec_type: "video",
          codec_name: "h264",
          width: 1080,
          height: 1920,
          pix_fmt: "yuv420p",
          r_frame_rate: "30/1",
          avg_frame_rate: "30/1",
          nb_frames: "450",
          ...patch.stream,
        },
        ...(patch.extraStreams ?? []),
      ],
      format: {
        format_name: "mov,mp4,m4a,3gp,3g2,mj2",
        duration: "15.000000",
        size: "774081",
        tags: { major_brand: "isom" },
        ...patch.format,
      },
    })

  it("verifies a correct 1080×1920 H.264 30 fps MP4", () => {
    const result = verifyOutputProbe(goodOutput(), 450)
    expect(result).toEqual({
      ok: true,
      value: {
        durationSeconds: 15,
        sizeBytes: 774081,
        width: 1080,
        height: 1920,
        fps: 30,
        videoCodec: "h264",
        pixelFormat: "yuv420p",
        frames: 450,
        audio: null,
      },
    })
  })

  it("rejects outputs that miss the target in any way", () => {
    const cases: [string, ReturnType<typeof goodOutput>, RegExp][] = [
      [
        "size",
        goodOutput({ stream: { width: 720, height: 1280 } }),
        /720×1280/,
      ],
      ["codec", goodOutput({ stream: { codec_name: "hevc" } }), /hevc/],
      [
        "pixel format",
        goodOutput({ stream: { pix_fmt: "yuv444p" } }),
        /yuv444p/,
      ],
      [
        "fps",
        goodOutput({
          stream: { avg_frame_rate: "25/1", r_frame_rate: "25/1" },
        }),
        /25\/1/,
      ],
      [
        "audio",
        goodOutput({
          extraStreams: [{ codec_type: "audio", codec_name: "aac" }],
        }),
        /audio/,
      ],
      [
        "too short",
        goodOutput({ format: { duration: "12.0" } }),
        /outside 15–30/,
      ],
      [
        "mismatch",
        goodOutput({ format: { duration: "16.5" } }),
        /doesn't match/,
      ],
      ["frames", goodOutput({ stream: { nb_frames: "449" } }), /449 frames/],
      [
        "quicktime",
        goodOutput({ format: { tags: { major_brand: "qt  " } } }),
        /brand/,
      ],
      ["empty", goodOutput({ format: { size: "0" } }), /empty/],
    ]
    for (const [label, stdout, problem] of cases) {
      const result = verifyOutputProbe(stdout, 450)
      expect(result.ok, label).toBe(false)
      if (!result.ok) expect(result.problems.join("; "), label).toMatch(problem)
    }
    expect(verifyOutputProbe("{oops", 450).ok).toBe(false)
  })

  it("parses -progress output across chunk boundaries", () => {
    const updates: { encodedSeconds: number; done: boolean }[] = []
    const feed = createProgressParser((u) => updates.push(u))
    feed("frame=30\nout_time_us=1000")
    feed("000\nprogress=continue\nframe=60\nout_time_ms=2500000\n")
    feed("progress=continue\nout_time_us=N/A\nprogress=continue\n")
    feed("out_time_us=15000000\nprogress=end\n")
    expect(updates).toEqual([
      { encodedSeconds: 1, done: false },
      { encodedSeconds: 2.5, done: false },
      // "N/A" is ignored: the last real value is reported again.
      { encodedSeconds: 2.5, done: false },
      { encodedSeconds: 15, done: true },
    ])
  })
})
