import "server-only"

import { VIDEO_FORMAT } from "@/lib/video/format"
import type { VideoProject, VideoScene } from "@/lib/video/types"
import {
  measureText,
  VIDEO_FONTS,
  type FontMetrics,
  type VideoFontWeight,
} from "@/server/video/font-metrics"

/**
 * Builds every FFmpeg invocation for a render as plain argument arrays.
 *
 * Pure: no I/O, so it is unit-tested without FFmpeg. Rules it enforces:
 * - Arguments are arrays for spawn(); nothing is ever passed through a shell.
 * - User text never appears in arguments or filter graphs. Captions are
 *   written to UTF-8 text files and drawn with `drawtext=textfile=…:
 *   expansion=none`, so `%{…}` sequences, quotes, colons or brackets in a
 *   caption are drawn literally and can't change the filter graph.
 * - Filter-graph values are generated (fixed numbers, colors and file names
 *   like `scene-2-caption-1.txt`) and still escaped and allowlisted.
 * - FFmpeg runs with the job's work directory as its cwd, so filter graphs
 *   reference only relative file names, never absolute paths.
 * - Inputs and outputs use the `file:` protocol and `-protocol_whitelist
 *   file`, so a name can't be read as a URL or another protocol.
 */

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * Escapes a value for use inside a filter option (`key=value`) of a filter
 * graph passed with -filter_complex. Two levels, per FFmpeg's quoting rules:
 * first the option level (`\`, `'`, `:`), then the graph level (`\`, `'`,
 * `[`, `]`, `,`, `;`).
 */
export function escapeFilterValue(value: string) {
  if (/[\0\r\n]/.test(value))
    throw new Error("Filter values can't contain NUL or line breaks.")
  const optionLevel = value.replace(/[\\':]/g, (c) => `\\${c}`)
  return optionLevel.replace(/[\\'[\],;]/g, (c) => `\\${c}`)
}

/** Generated file names only: lowercase words, digits and dashes plus one extension. */
const SAFE_FILE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*\.(txt|ttf|png|mp4)$/

function fileRef(name: string) {
  if (!SAFE_FILE_NAME.test(name))
    throw new Error(`Unsafe generated file name: ${JSON.stringify(name)}`)
  return escapeFilterValue(name)
}

// ---------------------------------------------------------------------------
// Layout (1080 × 1920, mobile safe areas)
// ---------------------------------------------------------------------------

/**
 * Vertical-video safe areas: platform UI covers roughly the top ~200 px
 * (tabs), the bottom ~400 px (description, buttons) and a right-hand rail
 * (likes, comments). Text stays between y = 210 and y ≈ 1560 and inside a
 * centered 820 px column.
 */
export const LAYOUT = {
  width: VIDEO_FORMAT.width,
  height: VIDEO_FORMAT.height,
  textWidth: 820,
  background: "0x0b1424",
  disclosure: {
    top: 210,
    fontSize: 32,
    lineHeight: 46,
    maxLines: 3,
    border: 12,
    color: "white",
    box: "black@0.62",
  },
  image: { maxWidth: 960, maxHeight: 800, centerY: 785 },
  caption: { top: 1240, maxBlockHeight: 270, maxLines: 3 },
  subtext: { fontSize: 42, gap: 30, color: "white@0.92" },
} as const

const CAPTION_STYLE: Record<
  VideoScene["caption"]["role"],
  { maxSize: number; minSize: number; color: string; box: string }
> = {
  headline: { maxSize: 84, minSize: 56, color: "white", box: "black@0.55" },
  benefit: { maxSize: 76, minSize: 52, color: "white", box: "black@0.55" },
  // Deskverse accent (dark theme): readable dark text on a warm pill.
  "call-to-action": {
    maxSize: 76,
    minSize: 52,
    color: "0x2b1500",
    box: "0xffb86b@0.96",
  },
}

export interface TextLayout {
  lines: string[]
  fontSize: number
  lineHeight: number
}

/** Greedy word wrap by real glyph widths; over-long words break by character. */
export function wrapText(
  font: FontMetrics,
  text: string,
  fontSize: number,
  maxWidth: number,
): string[] {
  const lines: string[] = []
  let line = ""
  const fits = (candidate: string) =>
    measureText(font, candidate, fontSize) <= maxWidth
  for (const word of text.split(" ").filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word
    if (fits(candidate)) {
      line = candidate
      continue
    }
    if (line) lines.push(line)
    if (fits(word)) {
      line = word
      continue
    }
    // A single word wider than the column: split it by characters.
    line = ""
    for (const char of word) {
      if (line && !fits(line + char)) {
        lines.push(line)
        line = char
      } else line += char
    }
  }
  if (line) lines.push(line)
  return lines
}

/**
 * Wraps into the same number of lines as greedy wrapping, but at the
 * narrowest width that allows it, so lines come out evenly balanced instead
 * of leaving a single orphan word on the last line.
 */
export function wrapBalanced(
  font: FontMetrics,
  text: string,
  fontSize: number,
  maxWidth: number,
): string[] {
  const greedy = wrapText(font, text, fontSize, maxWidth)
  if (greedy.length <= 1) return greedy
  let lo = 1
  let hi = Math.floor(maxWidth)
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (wrapText(font, text, fontSize, mid).length <= greedy.length) hi = mid
    else lo = mid + 1
  }
  return wrapText(font, text, fontSize, hi)
}

/** Largest font size (step 4 px) whose wrapped text fits the line and height limits. */
export function fitText(
  font: FontMetrics,
  text: string,
  {
    maxSize,
    minSize,
    maxWidth,
    maxLines,
    maxBlockHeight,
  }: {
    maxSize: number
    minSize: number
    maxWidth: number
    maxLines: number
    maxBlockHeight: number
  },
): TextLayout {
  let layout: TextLayout | null = null
  for (let size = maxSize; size >= minSize; size -= 4) {
    const lines = wrapBalanced(font, text, size, maxWidth)
    const lineHeight = Math.round(size * 1.2)
    layout = { lines, fontSize: size, lineHeight }
    if (lines.length <= maxLines && lines.length * lineHeight <= maxBlockHeight)
      return layout
  }
  // Validation limits keep this rare; draw at the minimum size, all lines.
  return layout!
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface TextFile {
  /** Generated, relative to the work directory. */
  name: string
  /** Exactly what is drawn (one line, already validated and wrapped). */
  content: string
}

export interface SceneCommand {
  sceneId: string
  /** Absolute path of the stored source image (an argv element, not in the graph). */
  inputPath: string
  output: string
  args: string[]
  textFiles: TextFile[]
}

export interface EncoderChoice {
  name: string
  /** Fixed options for that encoder (never from the client). */
  options: readonly string[]
}

export interface RenderPlan {
  scenes: SceneCommand[]
  encode: { args: string[]; output: string }
  /** Font files to copy into the work directory under these names. */
  fonts: { weight: VideoFontWeight; name: string }[]
  totalFrames: number
}

const FONT_FILE: Record<VideoFontWeight, string> = {
  bold: "font-bold.ttf",
  medium: "font-medium.ttf",
}

const COMMON = ["-nostdin", "-hide_banner", "-loglevel", "error"] as const

function drawText({
  file,
  weight,
  fontSize,
  color,
  y,
  box,
}: {
  file: string
  weight: VideoFontWeight
  fontSize: number
  color: string
  y: number
  box?: { color: string; border: number }
}) {
  const options = [
    `fontfile=${fileRef(FONT_FILE[weight])}`,
    `textfile=${fileRef(file)}`,
    "expansion=none",
    `fontsize=${fontSize}`,
    `fontcolor=${escapeFilterValue(color)}`,
    "x=(w-text_w)/2",
    `y=${Math.round(y)}`,
    "fix_bounds=1",
  ]
  if (box)
    options.push(
      "box=1",
      `boxcolor=${escapeFilterValue(box.color)}`,
      `boxborderw=${box.border}`,
    )
  return `drawtext=${options.join(":")}`
}

/** Layout + drawtext filters + text files for one scene's overlays. */
export function sceneOverlays(
  scene: VideoScene,
  index: number,
  disclosure: string,
  fonts: Record<VideoFontWeight, FontMetrics>,
) {
  const n = index + 1
  const files: TextFile[] = []
  const filters: string[] = []

  // Affiliate disclosure, top of every scene.
  const d = LAYOUT.disclosure
  const disclosureLines = wrapBalanced(
    fonts.medium,
    disclosure,
    d.fontSize,
    LAYOUT.textWidth,
  ).slice(0, d.maxLines)
  disclosureLines.forEach((content, i) => {
    const name = `scene-${n}-disclosure-${i + 1}.txt`
    files.push({ name, content })
    filters.push(
      drawText({
        file: name,
        weight: "medium",
        fontSize: d.fontSize,
        color: d.color,
        y: d.top + i * d.lineHeight,
        box: { color: d.box, border: d.border },
      }),
    )
  })

  // Caption: headline, benefit or call to action.
  const style = CAPTION_STYLE[scene.caption.role]
  const caption = fitText(fonts.bold, scene.caption.text, {
    maxSize: style.maxSize,
    minSize: style.minSize,
    maxWidth: LAYOUT.textWidth,
    maxLines: LAYOUT.caption.maxLines,
    maxBlockHeight: LAYOUT.caption.maxBlockHeight,
  })
  const border = Math.round(caption.fontSize * 0.2)
  caption.lines.forEach((content, i) => {
    const name = `scene-${n}-caption-${i + 1}.txt`
    files.push({ name, content })
    filters.push(
      drawText({
        file: name,
        weight: "bold",
        fontSize: caption.fontSize,
        color: style.color,
        y: LAYOUT.caption.top + i * caption.lineHeight,
        box: { color: style.box, border },
      }),
    )
  })

  // Product name under the hook and the call to action.
  if (scene.caption.subtext) {
    const s = LAYOUT.subtext
    const [line] = wrapText(
      fonts.medium,
      scene.caption.subtext,
      s.fontSize,
      LAYOUT.textWidth,
    )
    const name = `scene-${n}-subtext.txt`
    files.push({ name, content: line })
    filters.push(
      drawText({
        file: name,
        weight: "medium",
        fontSize: s.fontSize,
        color: s.color,
        y:
          LAYOUT.caption.top +
          caption.lines.length * caption.lineHeight +
          s.gap,
      }),
    )
  }

  return { files, filters, caption }
}

/**
 * Filter graph for one scene's still frame: the image as a blurred, darkened
 * full-bleed backdrop, the whole image fitted on top (proportions preserved),
 * then the text overlays. Transparent images sit on the brand background.
 */
export function sceneFilterGraph(overlays: readonly string[]) {
  const { width: W, height: H, image } = LAYOUT
  return [
    `color=c=${LAYOUT.background}:s=${W}x${H}:d=1[base]`,
    "[0:v]split=2[a][b]",
    `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=36,colorchannelmixer=rr=0.5:gg=0.5:bb=0.5[bg]`,
    `[b]scale=${image.maxWidth}:${image.maxHeight}:force_original_aspect_ratio=decrease[fg]`,
    "[base][bg]overlay=0:0[x]",
    [
      `[x][fg]overlay=x=(main_w-overlay_w)/2:y=${image.centerY}-overlay_h/2`,
      ...overlays,
      "format=rgb24[out]",
    ].join(","),
  ].join(";")
}

/**
 * The full plan for a validated project. `assetPaths` maps each asset ID to
 * its stored file (from storage.assetPath, already containment-checked).
 */
export function buildRenderPlan({
  project,
  assetPaths,
  fonts,
  encoder,
  threads,
}: {
  project: VideoProject
  assetPaths: ReadonlyMap<string, string>
  fonts: Record<VideoFontWeight, FontMetrics>
  encoder: EncoderChoice
  threads: number
}): RenderPlan {
  const fps = VIDEO_FORMAT.fps

  const scenes: SceneCommand[] = project.scenes.map((scene, index) => {
    if (!scene.assetId) throw new Error(`${scene.id} has no image.`)
    const inputPath = assetPaths.get(scene.assetId)
    if (!inputPath) throw new Error(`${scene.id} refers to an unknown image.`)
    const { files, filters } = sceneOverlays(
      scene,
      index,
      project.product.disclosure,
      fonts,
    )
    const output = `scene-${index + 1}.png`
    return {
      sceneId: scene.id,
      inputPath,
      output,
      textFiles: files,
      args: [
        ...COMMON,
        "-protocol_whitelist",
        "file",
        "-i",
        `file:${inputPath}`,
        "-filter_complex",
        sceneFilterGraph(filters),
        "-map",
        "[out]",
        "-frames:v",
        "1",
        "-update",
        "1",
        "-y",
        `file:${output}`,
      ],
    }
  })

  const totalFrames = project.scenes.reduce(
    (sum, scene) => sum + scene.durationFrames,
    0,
  )
  const totalSeconds = totalFrames / fps
  // Each scene is ONE decoded still frame, repeated by the `loop` filter only
  // as the encoder asks for frames. (Looping inputs with `-loop 1` made FFmpeg
  // decode every scene ahead in parallel: ~1.7 GB for a 19 s video.) Exact
  // 1/30 s timestamps come from settb + setpts.
  const inputs = sceneInputs(scenes)
  const trims = project.scenes.map(
    (scene, i) =>
      `[${i}:v]loop=loop=${scene.durationFrames - 1}:size=1:start=0,settb=1/${fps},setpts=N,setsar=1,format=yuv420p[v${i}]`,
  )
  const fadeOut = Math.max(totalSeconds - 0.4, 0).toFixed(3)
  const graph = [
    ...trims,
    `${project.scenes.map((_, i) => `[v${i}]`).join("")}concat=n=${project.scenes.length}:v=1:a=0,fade=t=in:st=0:d=0.25,fade=t=out:st=${fadeOut}:d=0.4,format=yuv420p[out]`,
  ].join(";")
  const output = "render.mp4"

  return {
    scenes,
    fonts: (Object.keys(VIDEO_FONTS) as VideoFontWeight[]).map((weight) => ({
      weight,
      name: FONT_FILE[weight],
    })),
    totalFrames,
    encode: {
      output,
      args: [
        ...COMMON,
        "-nostats",
        "-progress",
        "pipe:1",
        ...inputs,
        "-filter_complex",
        graph,
        "-map",
        "[out]",
        "-an",
        "-c:v",
        encoder.name,
        ...encoder.options,
        "-threads",
        String(threads),
        "-pix_fmt",
        VIDEO_FORMAT.pixelFormat,
        "-r",
        String(fps),
        "-frames:v",
        String(totalFrames),
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        "-y",
        `file:${output}`,
      ],
    },
  }
}

function sceneInputs(scenes: readonly SceneCommand[]) {
  return scenes.flatMap((scene) => [
    "-protocol_whitelist",
    "file",
    "-i",
    `file:${scene.output}`,
  ])
}

/** Fixed, quality-oriented options per H.264 encoder. */
export function encoderOptions(name: string): readonly string[] {
  if (name === "libx264")
    return [
      "-preset",
      "medium",
      "-crf",
      "20",
      "-tune",
      "stillimage",
      // Shorter lookahead: ~100 MB less memory at 1080×1920, same quality
      // for still scenes.
      "-rc-lookahead",
      "20",
      "-profile:v",
      "high",
    ]
  if (name === "libopenh264") return ["-b:v", "6M"]
  // Hardware encoders: a conservative bitrate; verified by a test encode.
  return ["-b:v", "8M"]
}
