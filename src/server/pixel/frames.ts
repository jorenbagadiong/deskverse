import { promises as fs } from "node:fs"
import path from "node:path"

import { VIDEO_FORMAT } from "@/lib/video/format"
import type { VideoProject } from "@/lib/video/types"
import type { Spawner } from "@/server/process/run-executable"
import { LAYOUT, sceneOverlays } from "@/server/video/ffmpeg-command"
import {
  VIDEO_FONTS,
  type FontMetrics,
  type VideoFontWeight,
} from "@/server/video/font-metrics"
import { resolveInside } from "@/server/video/storage"

/**
 * Checks the affiliate disclosure in ACTUAL rendered frames (DV-005C).
 *
 * FFprobe proves format, not content. Without OCR, this compares glyphs:
 * - a reference band is drawn by FFmpeg from the script's disclosure text
 *   (Pixel's font, size and position) on black;
 * - from the finished MP4, one frame in the middle of every scene is
 *   extracted and the same band cropped;
 * - both are reduced to "bright pixel" masks (the disclosure is white on a
 *   62 % black box, so the picture behind it stays far below the
 *   threshold) and compared by intersection over union.
 * A missing, moved or different disclosure scores low. Runs inside the
 * render gate (it starts FFmpeg) and in the job's private work folder.
 */

export const DISCLOSURE_MIN_IOU = 0.6
const THRESHOLD = 160

export interface DisclosureCheck {
  verified: boolean
  scenes: { sceneId: string; atSeconds: number; iou: number }[]
}

function iou(a: Uint8Array, b: Uint8Array) {
  let inter = 0
  let union = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] > THRESHOLD
    const y = b[i] > THRESHOLD
    if (x && y) inter++
    if (x || y) union++
  }
  return union === 0 ? 0 : inter / union
}

export async function verifyDisclosureFrames(opts: {
  video: string
  project: VideoProject
  disclosure: string
  fonts: Record<VideoFontWeight, FontMetrics>
  fontDir: string
  work: string
  ffmpeg: string
  spawn: Spawner
  signal?: AbortSignal
}): Promise<DisclosureCheck> {
  const { project, work } = opts
  const d = LAYOUT.disclosure
  const overlays = sceneOverlays(
    project.scenes[0],
    0,
    opts.disclosure,
    opts.fonts,
  )
  const files = overlays.files.filter((f) => f.name.includes("disclosure"))
  const filters = overlays.filters.slice(0, files.length)
  const top = Math.max(0, d.top - d.border - 6)
  const height = files.length * d.lineHeight + 2 * d.border + 12
  await fs.copyFile(
    path.join(opts.fontDir, VIDEO_FONTS.medium),
    resolveInside(work, "font-medium.ttf"),
  )
  for (const f of files)
    await fs.writeFile(resolveInside(work, f.name), f.content, { mode: 0o600 })
  const run = async (args: string[], label: string) => {
    const r = await opts.spawn(
      opts.ffmpeg,
      ["-nostdin", "-hide_banner", "-loglevel", "error", ...args],
      {
        cwd: work,
        timeoutMs: 60_000,
        signal: opts.signal,
      },
    )
    if (!r.ok) throw new Error(`${label} failed (${r.reason})`)
  }
  const crop = `crop=${VIDEO_FORMAT.width}:${height}:0:${top},format=gray`
  await run(
    [
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=${VIDEO_FORMAT.width}x${VIDEO_FORMAT.height}:d=1`,
      "-frames:v",
      "1",
      "-vf",
      `${filters.join(",")},${crop}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-y",
      "disclosure-reference.raw",
    ],
    "drawing the reference disclosure",
  )
  const reference = new Uint8Array(
    await fs.readFile(resolveInside(work, "disclosure-reference.raw")),
  )
  const scenes: DisclosureCheck["scenes"] = []
  let start = 0
  for (const [i, scene] of project.scenes.entries()) {
    const at = (start + scene.durationFrames / 2) / VIDEO_FORMAT.fps
    start += scene.durationFrames
    const name = `disclosure-scene-${i + 1}.raw`
    await run(
      [
        "-ss",
        at.toFixed(3),
        "-i",
        opts.video,
        "-frames:v",
        "1",
        "-vf",
        crop,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-y",
        name,
      ],
      `extracting scene ${i + 1}`,
    )
    const frame = new Uint8Array(await fs.readFile(resolveInside(work, name)))
    scenes.push({
      sceneId: scene.id,
      atSeconds: Math.round(at * 1000) / 1000,
      iou:
        frame.length === reference.length
          ? Math.round(iou(reference, frame) * 1000) / 1000
          : 0,
    })
  }
  return {
    verified:
      scenes.length > 0 && scenes.every((s) => s.iou >= DISCLOSURE_MIN_IOU),
    scenes,
  }
}
