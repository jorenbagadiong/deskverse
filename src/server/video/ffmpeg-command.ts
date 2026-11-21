import "server-only"

import {
  CROSSFADE,
  GENTLE_ZOOM,
  sceneTimings,
  STATIC_EFFECTS,
} from "@/lib/video/effects"
import { VIDEO_FORMAT } from "@/lib/video/format"
import type { VideoProject, VideoScene, VisualEffects } from "@/lib/video/types"
import {
  ORIENTATION_FILTERS,
  orientedDimensions,
  type ExifOrientation,
} from "@/server/video/exif"
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

/**
 * Turns one uploaded photo upright (EXIF) and caps its size, once, into the
 * work directory. Every later step reads only this normalized copy, so the
 * orientation is applied exactly once and the original is never modified.
 */
export interface ImageCommand {
  assetId: string
  /** Absolute path of the stored upload (an argv element, never in a graph). */
  inputPath: string
  /** Generated PNG name in the work directory, e.g. "image-2.png". */
  output: string
  orientation: ExifOrientation
  /** Upright size after normalization. */
  width: number
  height: number
  args: string[]
}

export interface SceneCommand {
  sceneId: string
  /** The normalized image this scene uses (work-directory name). */
  input: string
  /** Backdrop + text; with gentle zoom the product is left out of it. */
  output: string
  /** Gentle zoom only: the product on a transparent canvas, animated at encode time. */
  productOutput: string | null
  args: string[]
  textFiles: TextFile[]
}

/** One scene's stretch of the final video, encoded on its own. */
export interface SegmentCommand {
  sceneId: string
  output: string
  /** Where it starts in the final video, and how many frames it has. */
  startFrame: number
  frames: number
  args: string[]
}

/** What the renderer knows about a stored photo (read from its bytes). */
export interface ImageSource {
  path: string
  orientation: ExifOrientation
  /** Size in the file's header, before orientation. */
  storedWidth: number
  storedHeight: number
}

export interface EncoderChoice {
  name: string
  /** Fixed options for that encoder (never from the client). */
  options: readonly string[]
}

export interface RenderPlan {
  images: ImageCommand[]
  scenes: SceneCommand[]
  /** Encoded one after another; each is one scene (plus its dissolve into the next). */
  segments: SegmentCommand[]
  /** Joins the segments with -c copy into `output`. */
  encode: { args: string[]; output: string; list: TextFile }
  /** Font files to copy into the work directory under these names. */
  fonts: { weight: VideoFontWeight; name: string }[]
  totalFrames: number
  /** What this plan renders (STATIC_EFFECTS for projects without effects). */
  effects: VisualEffects
}

const FONT_FILE: Record<VideoFontWeight, string> = {
  bold: "font-bold.ttf",
  medium: "font-medium.ttf",
}

const COMMON = ["-nostdin", "-hide_banner", "-loglevel", "error"] as const

/**
 * Scratch PNGs are read once and deleted: light compression is ~25 % faster
 * to write than the default and still lossless.
 */
const SCRATCH_PNG = ["-compression_level", "1"] as const

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
 * Normalized photos are capped at 2160 px on their longest side: plenty for
 * a 1080 × 1920 frame (the product is drawn at most 960 × 800, the backdrop
 * is blurred), and it bounds the memory and time of every later step however
 * large the upload was.
 */
export const NORMALIZED_MAX_SIDE = 2160

/** Upright size, scaled down (never up) to NORMALIZED_MAX_SIDE. */
export function normalizedSize(source: ImageSource) {
  const upright = orientedDimensions(
    { width: source.storedWidth, height: source.storedHeight },
    source.orientation,
  )
  const longest = Math.max(upright.width, upright.height)
  if (longest <= NORMALIZED_MAX_SIDE) return upright
  const scale = NORMALIZED_MAX_SIDE / longest
  return {
    width: Math.max(1, Math.round(upright.width * scale)),
    height: Math.max(1, Math.round(upright.height * scale)),
  }
}

/** The EXIF transform, then the downscale: one deterministic chain. */
export function imageNormalizeFilters(source: ImageSource) {
  const upright = orientedDimensions(
    { width: source.storedWidth, height: source.storedHeight },
    source.orientation,
  )
  const size = normalizedSize(source)
  const filters = [...ORIENTATION_FILTERS[source.orientation]]
  if (size.width !== upright.width || size.height !== upright.height)
    filters.push(`scale=${size.width}:${size.height}`)
  return filters.length > 0 ? filters.join(",") : "null"
}

/** The product canvas for gentle zoom: the fit box grown by the zoom amount. */
export const PRODUCT_CANVAS = (() => {
  const grow = (v: number) => {
    const n = Math.round(v * (1 + GENTLE_ZOOM.amount))
    return n + (n % 2)
  }
  const width = grow(LAYOUT.image.maxWidth)
  const height = grow(LAYOUT.image.maxHeight)
  return {
    width,
    height,
    x: Math.round((LAYOUT.width - width) / 2),
    y: Math.round(LAYOUT.image.centerY - height / 2),
  }
})()

/**
 * Filter graph for one scene's still frame: the image as a blurred, darkened
 * full-bleed backdrop, the whole image fitted on top (proportions preserved),
 * then the text overlays. Transparent images sit on the brand background.
 *
 * With `separateProduct` (gentle zoom) the fitted product is left out of
 * `[out]` and written as `[product]` instead, centered on a transparent
 * PRODUCT_CANVAS, so the encode can zoom it while the backdrop, captions and
 * disclosure stay perfectly still.
 */
export function sceneFilterGraph(
  overlays: readonly string[],
  { separateProduct = false }: { separateProduct?: boolean } = {},
) {
  const { width: W, height: H, image } = LAYOUT
  const fit = `scale=${image.maxWidth}:${image.maxHeight}:force_original_aspect_ratio=decrease`
  const head = [
    `color=c=${LAYOUT.background}:s=${W}x${H}:d=1[base]`,
    "[0:v]split=2[a][b]",
    `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=36,colorchannelmixer=rr=0.5:gg=0.5:bb=0.5[bg]`,
  ]
  if (separateProduct) {
    const c = PRODUCT_CANVAS
    return [
      ...head,
      `[b]${fit},format=rgba,pad=${c.width}:${c.height}:(ow-iw)/2:(oh-ih)/2:color=black@0[product]`,
      ["[base][bg]overlay=0:0", ...overlays, "format=rgb24[out]"].join(","),
    ].join(";")
  }
  return [
    ...head,
    `[b]${fit}[fg]`,
    "[base][bg]overlay=0:0[x]",
    [
      `[x][fg]overlay=x=(main_w-overlay_w)/2:y=${image.centerY}-overlay_h/2`,
      ...overlays,
      "format=rgb24[out]",
    ].join(","),
  ].join(";")
}

/**
 * Gentle zoom for a clip of `frames` frames (rendered from clip frame
 * `start`, for a segment that begins part-way in): `perspective` resamples the
 * product canvas (sub-pixel, cubic) from the whole canvas on the first frame
 * to its central 1 / (1 + amount) on the last, so the product grows smoothly
 * and linearly by GENTLE_ZOOM.amount. The canvas has exactly that much
 * transparent margin, so the product is never cropped, and both axes use
 * the same factor, so it's never stretched. (zoompan was measured and
 * rejected: it rounds its window to whole pixels, so the motion stutters.)
 */
export function zoomFilter(frames: number, start = 0) {
  const last = Math.max(frames - 1, 1)
  const frame = start > 0 ? `(in+${start})` : "in"
  const z = `(1+${GENTLE_ZOOM.amount}*${frame}/${last})`
  const left = `W/2-W/2/${z}`
  const right = `W/2+W/2/${z}`
  const top = `H/2-H/2/${z}`
  const bottom = `H/2+H/2/${z}`
  return [
    `perspective=x0='${left}'`,
    `y0='${top}'`,
    `x1='${right}'`,
    `y1='${top}'`,
    `x2='${left}'`,
    `y2='${bottom}'`,
    `x3='${right}'`,
    `y3='${bottom}'`,
    "interpolation=cubic",
    "sense=source",
    "eval=frame",
  ].join(":")
}

/**
 * The full plan for a validated project. `imageSources` maps each asset ID
 * to its stored file (from storage.assetPath, already containment-checked)
 * with the orientation and size read from its bytes.
 */
export function buildRenderPlan({
  project,
  imageSources,
  fonts,
  encoder,
  threads,
}: {
  project: VideoProject
  imageSources: ReadonlyMap<string, ImageSource>
  fonts: Record<VideoFontWeight, FontMetrics>
  encoder: EncoderChoice
  threads: number
}): RenderPlan {
  const fps = VIDEO_FORMAT.fps
  // Projects saved before DV-003D2 have no effects: static with cuts.
  const effects = project.effects ?? STATIC_EFFECTS
  const zoom = effects.motion === "gentle-zoom"

  // 1. One normalized copy per photo the scenes use.
  const images: ImageCommand[] = []
  const imageFor = new Map<string, ImageCommand>()
  for (const scene of project.scenes) {
    if (!scene.assetId) throw new Error(`${scene.id} has no image.`)
    if (imageFor.has(scene.assetId)) continue
    const source = imageSources.get(scene.assetId)
    if (!source) throw new Error(`${scene.id} refers to an unknown image.`)
    const output = `image-${images.length + 1}.png`
    const command: ImageCommand = {
      assetId: scene.assetId,
      inputPath: source.path,
      output,
      orientation: source.orientation,
      ...normalizedSize(source),
      args: [
        ...COMMON,
        // Raw stored pixels: the EXIF transform is applied by the filters, once.
        "-noautorotate",
        "-protocol_whitelist",
        "file",
        "-i",
        `file:${source.path}`,
        "-vf",
        imageNormalizeFilters(source),
        ...SCRATCH_PNG,
        "-frames:v",
        "1",
        "-update",
        "1",
        "-y",
        `file:${fileRef(output)}`,
      ],
    }
    images.push(command)
    imageFor.set(scene.assetId, command)
  }

  // 2. One still per scene (with gentle zoom, plus its product layer).
  const scenes: SceneCommand[] = project.scenes.map((scene, index) => {
    const image = imageFor.get(scene.assetId!)!
    const { files, filters } = sceneOverlays(
      scene,
      index,
      project.product.disclosure,
      fonts,
    )
    const output = `scene-${index + 1}.png`
    const productOutput = zoom ? `scene-${index + 1}-product.png` : null
    const still = (label: string, name: string) => [
      "-map",
      label,
      ...SCRATCH_PNG,
      "-frames:v",
      "1",
      "-update",
      "1",
      "-y",
      `file:${fileRef(name)}`,
    ]
    return {
      sceneId: scene.id,
      input: image.output,
      output,
      productOutput,
      textFiles: files,
      args: [
        ...COMMON,
        "-protocol_whitelist",
        "file",
        "-i",
        `file:${fileRef(image.output)}`,
        "-filter_complex",
        sceneFilterGraph(filters, { separateProduct: zoom }),
        ...still("[out]", output),
        ...(productOutput ? still("[product]", productOutput) : []),
      ],
    }
  })

  // 3. The encode: one segment per scene, encoded one after another, then
  // joined without re-encoding.
  const totalFrames = project.scenes.reduce(
    (sum, scene) => sum + scene.durationFrames,
    0,
  )
  const timings = sceneTimings(
    project.scenes.map((scene) => scene.durationFrames),
    effects.transition,
  )
  const crossfade = effects.transition === "crossfade"
  const segments: SegmentCommand[] = []
  let startFrame = 0
  scenes.forEach((scene, i) => {
    const timing = timings[i]
    const next = i + 1 < scenes.length ? scenes[i + 1] : null
    // A segment starts where the previous one's dissolve ended: it skips the
    // lead-in frames that were already shown inside that dissolve.
    const skip = crossfade && i > 0 ? CROSSFADE.frames : 0
    const frames = timing.clipFrames - skip
    const output = `segment-${i + 1}.mp4`
    const inputs: string[] = []
    let inputCount = 0
    const addInput = (name: string) => {
      inputs.push(
        "-framerate",
        String(fps),
        "-protocol_whitelist",
        "file",
        "-i",
        `file:${fileRef(name)}`,
      )
      return inputCount++
    }
    const graph: string[] = []
    const own = sceneClip(scene, addInput, {
      frames,
      zoomStart: skip,
      zoomFrames: timing.clipFrames,
      label: "a",
      graph,
    })
    let last = own
    if (crossfade && next) {
      // The dissolve into the next scene: its first CROSSFADE.frames frames
      // (zoom included) over this scene's last ones.
      const incoming = sceneClip(next, addInput, {
        frames: CROSSFADE.frames,
        zoomStart: 0,
        zoomFrames: timings[i + 1].clipFrames,
        label: "b",
        graph,
      })
      graph.push(
        `${own}${incoming}xfade=transition=fade:duration=${seconds(CROSSFADE.frames)}:offset=${seconds(frames - CROSSFADE.frames)}[x]`,
      )
      last = "[x]"
    }
    // The video's own fade from and to black, inside the first and last segments.
    const fades: string[] = []
    if (i === 0) fades.push("fade=t=in:st=0:d=0.25")
    if (i === scenes.length - 1)
      fades.push(
        `fade=t=out:st=${Math.max(frames / fps - 0.4, 0).toFixed(3)}:d=0.4`,
      )
    graph.push(`${last}${[...fades, "format=yuv420p"].join(",")}[out]`)

    segments.push({
      sceneId: scene.sceneId,
      output,
      startFrame,
      frames,
      args: [
        ...COMMON,
        "-nostats",
        "-progress",
        "pipe:1",
        ...inputs,
        "-filter_complex",
        graph.join(";"),
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
        String(frames),
        "-f",
        "mp4",
        "-y",
        `file:${fileRef(output)}`,
      ],
    })
    startFrame += frames
  })
  if (startFrame !== totalFrames)
    throw new Error(
      `Segments cover ${startFrame} frames, not the storyboard's ${totalFrames}.`,
    )

  // Same encoder and settings for every segment, so the H.264 streams join
  // with -c copy: no second encode, and frame-exact.
  const list: TextFile = {
    name: "segments.txt",
    content: segments.map((s) => `file '${fileRef(s.output)}'`).join("\n"),
  }
  const output = "render.mp4"

  return {
    images,
    scenes,
    effects,
    fonts: (Object.keys(VIDEO_FONTS) as VideoFontWeight[]).map((weight) => ({
      weight,
      name: FONT_FILE[weight],
    })),
    totalFrames,
    segments,
    encode: {
      list,
      output,
      args: [
        ...COMMON,
        "-protocol_whitelist",
        "file",
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        `file:${fileRef(list.name)}`,
        "-map",
        "0:v:0",
        "-c",
        "copy",
        "-an",
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

/**
 * One scene's picture inside a segment graph: its still held for `frames`
 * frames (exact 1/30 s timestamps from settb + setpts), and with gentle zoom
 * its product layer zoomed from clip frame `zoomStart` of `zoomFrames`.
 *
 * Each still is ONE decoded frame, repeated by the `loop` filter only as the
 * encoder asks for frames. (Looping inputs with `-loop 1` made FFmpeg decode
 * every scene ahead in parallel: ~1.7 GB for a 19 s video.)
 */
function sceneClip(
  scene: SceneCommand,
  addInput: (name: string) => number,
  {
    frames,
    zoomStart,
    zoomFrames,
    label,
    graph,
  }: {
    frames: number
    zoomStart: number
    zoomFrames: number
    label: string
    graph: string[]
  },
) {
  const fps = VIDEO_FORMAT.fps
  const hold = (input: number) =>
    `[${input}:v]loop=loop=${frames - 1}:size=1:start=0,settb=1/${fps},setpts=N`
  const base = addInput(scene.output)
  if (!scene.productOutput) {
    graph.push(`${hold(base)},setsar=1,format=yuv420p[${label}]`)
    return `[${label}]`
  }
  const product = addInput(scene.productOutput)
  const c = PRODUCT_CANVAS
  graph.push(
    `${hold(base)},setsar=1,format=yuv420p[${label}base]`,
    `${hold(product)},format=yuva420p,${zoomFilter(zoomFrames, zoomStart)}[${label}product]`,
    `[${label}base][${label}product]overlay=x=${c.x}:y=${c.y}:format=yuv420,setsar=1,format=yuv420p[${label}]`,
  )
  return `[${label}]`
}

/**
 * A whole number of frames as seconds for FFmpeg. Six decimals round back
 * to the same frame at 30 fps (FFmpeg rounds to the nearest timestamp).
 */
function seconds(frames: number) {
  return (frames / VIDEO_FORMAT.fps).toFixed(6)
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
