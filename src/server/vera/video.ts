import { createHash } from "node:crypto"
import { createReadStream, promises as fs } from "node:fs"
import path from "node:path"

import type { ReviewPin, VeraFinding } from "@/lib/vera/types"
import { VIDEO_FORMAT } from "@/lib/video/format"
import type { VideoProject } from "@/lib/video/types"
import {
  createRunner,
  spawnTool,
  type Runner,
  type Spawner,
} from "@/server/process/run-executable"
import {
  sceneOverlays,
  LAYOUT,
  wrapBalanced,
  wrapText,
} from "@/server/video/ffmpeg-command"
import {
  loadVideoFont,
  fontDirectory,
  VIDEO_FONTS,
  measureText,
} from "@/server/video/font-metrics"
import { outputProbeArgs, verifyOutputProbe } from "@/server/video/ffprobe"
import { HandlerAborted } from "@/server/orchestrator/workflows"
import { finding } from "./rules"

export async function fileDigest(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest("hex")
}
export function sampleTimes(project: VideoProject) {
  let start = 0
  return project.scenes.map((s) => {
    const end = start + s.durationFrames / VIDEO_FORMAT.fps
    // Stay clear of Pixel's 0.25 s fade-in, 0.4 s fade-out and 0.4 s crossfades.
    const times = [start + 0.5, (start + end) / 2, end - 0.5]
    const out = { sceneId: s.id, start, end, times }
    start = end
    return out
  })
}
export function timestampCheck(stdout: string, expectedFrames: number) {
  let data: { frames?: { best_effort_timestamp_time?: string }[] }
  try {
    data = JSON.parse(stdout)
  } catch {
    return { ok: false, count: 0, gaps: -1 }
  }
  const times = (data?.frames ?? []).map((f) =>
    Number(f.best_effort_timestamp_time),
  )
  const gaps = times.filter(
    (t, i) => !Number.isFinite(t) || Math.abs(t - i / 30) > 0.002,
  ).length
  return {
    ok: times.length === expectedFrames && gaps === 0,
    count: times.length,
    gaps,
  }
}
function toolError(r: { ok: true } | { ok: false; reason: string }) {
  if (r.ok) return
  if (r.reason === "cancelled") throw new HandlerAborted("aborted")
  if (
    ["not-found", "not-executable", "timed-out", "output-too-large"].includes(
      r.reason,
    )
  )
    throw new Error(
      "Local QA tool unavailable; retry with FFmpeg and FFprobe installed.",
    )
}
export interface VideoEvidenceOptions {
  video: string
  project: VideoProject
  pin: ReviewPin
  work: string
  commands: { ffmpeg: string; ffprobe: string }
  signal?: AbortSignal
  run?: Runner
  spawn?: Spawner
}
export async function videoChecks(
  o: VideoEvidenceOptions,
): Promise<VeraFinding[]> {
  const { pin, project, video, commands, signal, work } = o
  const run =
    o.run ??
    createRunner({ timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024 })
  const spawn = o.spawn ?? spawnTool
  const out: VeraFinding[] = []
  const frames = project.scenes.reduce((n, s) => n + s.durationFrames, 0)
  const probe = await run(commands.ffprobe, outputProbeArgs(video), { signal })
  toolError(probe)
  if (!probe.ok)
    return [
      finding(
        pin,
        "video.probe",
        "video_technical",
        "failed",
        "fatal",
        "MP4 is readable by FFprobe.",
        { readable: false },
        "Restore the original MP4 or create a new Pixel version.",
      ),
    ]
  const metadata = verifyOutputProbe(probe.stdout, frames, {
    expectAudio: false,
  })
  const parsed = JSON.parse(probe.stdout)
  out.push(
    finding(
      pin,
      "video.format",
      "video_technical",
      metadata.ok ? "passed" : "failed",
      metadata.ok ? "info" : "revision",
      "MP4, H.264, yuv420p, 1080×1920, 30 fps; duration within 100 ms and exact reported frame count.",
      { probe: parsed, problems: metadata.ok ? [] : metadata.problems },
      "Create a new Pixel version using the trusted renderer.",
    ),
  )
  const silent =
    Array.isArray(parsed.streams) &&
    parsed.streams.filter(
      (s: { codec_type: string }) => s.codec_type === "audio",
    ).length === 0
  out.push(
    finding(
      pin,
      "audio.silent",
      "audio",
      silent ? "passed" : "failed",
      silent ? "info" : "revision",
      "This captioned video has no audio stream.",
      {
        silent,
        narrationSynchronization: "not evaluated: no narration expected",
      },
      silent
        ? null
        : "Render a new silent Pixel version; narration QA is outside this ruleset.",
    ),
  )
  const decoded = await run(
    commands.ffmpeg,
    [
      "-nostdin",
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-xerror",
      "-i",
      `file:${video}`,
      "-map",
      "0:v:0",
      "-f",
      "null",
      "-",
    ],
    { signal },
  )
  toolError(decoded)
  out.push(
    finding(
      pin,
      "video.full-decode",
      "video_technical",
      decoded.ok && !decoded.stderr.trim() ? "passed" : "failed",
      decoded.ok && !decoded.stderr.trim() ? "info" : "fatal",
      "Every video frame decodes without errors.",
      {
        decoded: decoded.ok,
        diagnostics: decoded.ok ? Boolean(decoded.stderr.trim()) : true,
      },
      "Restore the original MP4 or rerender a new version.",
    ),
  )
  if (!decoded.ok || decoded.stderr.trim()) return out
  const timing = await run(
    commands.ffprobe,
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-select_streams",
      "v:0",
      "-show_frames",
      "-show_entries",
      "frame=best_effort_timestamp_time",
      "-of",
      "json",
      `file:${video}`,
    ],
    { signal },
  )
  toolError(timing)
  const continuity = timing.ok
    ? timestampCheck(timing.stdout, frames)
    : { ok: false, count: 0, gaps: -1 }
  out.push(
    finding(
      pin,
      "video.continuity",
      "video_technical",
      continuity.ok ? "passed" : "failed",
      continuity.ok ? "info" : "revision",
      "All decoded presentation timestamps are ordered at 1/30 s (2 ms tolerance), starting at zero.",
      continuity,
      "Rerender with fixed 30 fps; inspect the scene timing.",
    ),
  )
  const black = await run(
    commands.ffmpeg,
    [
      "-nostdin",
      "-hide_banner",
      "-v",
      "info",
      "-protocol_whitelist",
      "file",
      "-i",
      `file:${video}`,
      "-vf",
      "blackdetect=d=0.1:pix_th=0.02:pic_th=0.98",
      "-an",
      "-f",
      "null",
      "-",
    ],
    { signal },
  )
  toolError(black)
  const spans = black.ok
    ? [
        ...black.stderr.matchAll(
          /black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g,
        ),
      ].map((m) => ({
        start: Number(m[1]),
        end: Number(m[2]),
        duration: Number(m[3]),
      }))
    : []
  const unexpected = spans.filter(
    (s) =>
      !(s.start < 0.01 && s.end <= 0.27) &&
      !(s.start >= frames / 30 - 0.42 && s.end >= frames / 30 - 0.04),
  )
  out.push(
    finding(
      pin,
      "visual.black-sections",
      "visual_composition",
      !black.ok ? "not_evaluated" : unexpected.length ? "failed" : "passed",
      !black.ok ? "owner" : unexpected.length ? "revision" : "info",
      "No ≥100 ms severe black section outside the trusted fades.",
      { spans, unexpected, threshold: "98% pixels below 2% luminance" },
      "Inspect the affected scene and replace blank imagery or create a corrected Pixel version.",
    ),
  )
  if (
    !metadata.ok &&
    (parsed.streams?.[0]?.width !== 1080 ||
      parsed.streams?.[0]?.height !== 1920)
  )
    return out
  const fonts = { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") }
  for (const w of ["bold", "medium"] as const)
    await fs.copyFile(
      path.join(fontDirectory(), VIDEO_FONTS[w]),
      path.join(work, `font-${w}.ttf`),
    )
  async function extract(args: string[]) {
    const r = await spawn(
      commands.ffmpeg,
      ["-nostdin", "-hide_banner", "-loglevel", "error", ...args],
      { cwd: work, timeoutMs: 60_000, signal },
    )
    toolError(r)
    return r.ok
  }
  for (const [i, sample] of sampleTimes(project).entries()) {
    const scene = project.scenes[i]
    const overlays = sceneOverlays(scene, i, project.product.disclosure, fonts)
    for (const f of overlays.files)
      await fs.writeFile(path.join(work, f.name), f.content, { mode: 0o600 })
    const disclosureLines = wrapBalanced(
      fonts.medium,
      project.product.disclosure,
      32,
      LAYOUT.textWidth,
    )
    const subtextLines = scene.caption.subtext
      ? wrapText(fonts.medium, scene.caption.subtext, 42, LAYOUT.textWidth)
      : []
    const fits =
      disclosureLines.length <= 3 &&
      subtextLines.length <= 1 &&
      overlays.caption.lines.join("").replace(/\s/g, "") ===
        scene.caption.text.replace(/\s/g, "") &&
      overlays.caption.lines.every(
        (t) => measureText(fonts.bold, t, overlays.caption.fontSize) <= 820,
      ) &&
      1240 +
        overlays.caption.lines.length * overlays.caption.lineHeight +
        (scene.caption.subtext ? 72 : 0) <
        1920
    out.push(
      finding(
        pin,
        "layout.text-bounds",
        "visual_composition",
        fits ? "passed" : "failed",
        fits ? "info" : "revision",
        "Known text fits the fixed template without truncation or frame clipping.",
        {
          captionFontSize: overlays.caption.fontSize,
          disclosureFontSize: 32,
          captionLines: overlays.caption.lines,
          disclosureLines,
          subtextLines,
        },
        "Shorten owner text and regenerate Quill/Pixel, or correct the layout in a new renderer version.",
        scene.id,
      ),
    )
    for (const group of ["disclosure", "caption", "subtext"] as const) {
      const indices = overlays.files
        .map((f, n) => (f.name.includes(`-${group}-`) ? n : -1))
        .filter((n) => n >= 0)
      if (!indices.length) continue
      const top = group === "disclosure" ? 192 : 1210
      const height = group === "disclosure" ? 176 : 440
      const crop = `crop=1080:${height}:0:${top},format=rgb24`
      const referenceName = `reference-${i}-${group}.raw`
      const ok = await extract([
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=1080x1920:d=1",
        "-vf",
        `${indices.map((n) => overlays.filters[n]).join(",")},${crop}`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-y",
        referenceName,
      ])
      if (!ok) throw new Error("QA reference drawing failed.")
      const reference = await fs.readFile(path.join(work, referenceName))
      const dark = group === "caption" && scene.kind === "call-to-action"
      const mask = (b: Uint8Array, n: number) =>
        dark
          ? Math.hypot(b[n] - 43, b[n + 1] - 21, b[n + 2]) < 28
          : b[n] > 160 && b[n + 1] > 160 && b[n + 2] > 160
      // CTA's dark glyphs are compared only within its reference pill bounds.
      let minX = 1080,
        maxX = 0,
        minY = height,
        maxY = 0
      for (let n = 0; n < reference.length; n += 3)
        if (
          reference[n] > 80 ||
          reference[n + 1] > 80 ||
          reference[n + 2] > 80
        ) {
          const p = n / 3,
            x = p % 1080,
            y = Math.floor(p / 1080)
          minX = Math.min(minX, x)
          maxX = Math.max(maxX, x)
          minY = Math.min(minY, y)
          maxY = Math.max(maxY, y)
        }
      const samples = []
      for (const [j, at] of sample.times.entries()) {
        const name = `sample-${i}-${group}-${j}.raw`
        const extracted = await extract([
          "-ss",
          at.toFixed(6),
          "-protocol_whitelist",
          "file",
          "-i",
          `file:${video}`,
          "-vf",
          crop,
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "-y",
          name,
        ])
        const bytes = extracted
          ? await fs.readFile(path.join(work, name))
          : Buffer.alloc(0)
        let inter = 0,
          union = 0
        if (bytes.length === reference.length)
          for (let n = 0; n < reference.length; n += 3) {
            const p = n / 3,
              x = p % 1080,
              y = Math.floor(p / 1080)
            if (dark && (x < minX || x > maxX || y < minY || y > maxY)) continue
            const a = mask(reference, n),
              b = mask(bytes, n)
            if (a && b) inter++
            if (a || b) union++
          }
        samples.push({
          atSeconds: at,
          iou: union ? Math.round((inter / union) * 1000) / 1000 : 0,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        })
      }
      const verified = samples.every((s) => s.iou >= 0.6)
      out.push(
        finding(
          pin,
          `${group}.decoded-masks`,
          group === "disclosure" ? "disclosure" : "captions",
          verified ? "passed" : "failed",
          verified ? "info" : "revision",
          "Exact trusted text mask IoU ≥0.60 at start/middle/end scene proxies (outside fades).",
          {
            samples,
            referenceSha256: createHash("sha256")
              .update(reference)
              .digest("hex"),
            timingProxy:
              "Known scene schedule sampled 500 ms inside each edge; exact visual boundary not measured",
            readability: "Pixel matching; human readability not established",
          },
          verified
            ? null
            : `Create a corrected Pixel version with the pinned ${group} visible for the whole scene.`,
          scene.id,
        ),
      )
    }
  }
  return out
}
