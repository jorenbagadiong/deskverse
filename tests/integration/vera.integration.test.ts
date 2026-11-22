import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { ReviewPin } from "@/lib/vera/types"
import { createAssetId } from "@/lib/video/ids"
import { buildStoryboard } from "@/lib/video/storyboard"
import type { VideoProject } from "@/lib/video/types"
import {
  DEFAULT_DISCLOSURE,
  DEFAULT_VIDEO_SETTINGS,
} from "@/lib/video/validation"
import { createRunner, spawnTool } from "@/server/process/run-executable"
import { sceneOverlays } from "@/server/video/ffmpeg-command"
import {
  fontDirectory,
  loadVideoFont,
  VIDEO_FONTS,
} from "@/server/video/font-metrics"
import { aggregateVerdict } from "@/server/vera/rules"
import { videoChecks } from "@/server/vera/video"

let root = "",
  video = ""
const fonts = { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") }
const product = {
  name: "Kettle",
  headline: "Meet the Kettle",
  benefits: ["Capacity: 1.7 L", "Material: Steel"],
  callToAction: "Check the product details",
  disclosure: DEFAULT_DISCLOSURE,
}
const project: VideoProject = {
  product,
  assets: [],
  scenes: buildStoryboard(product, [
    createAssetId(),
    createAssetId(),
    createAssetId(),
  ]),
  settings: DEFAULT_VIDEO_SETTINGS,
}
const pin = {
  deliverableId: "fixture",
  manifest: { assets: [] },
} as unknown as ReviewPin
const run = createRunner({ timeoutMs: 120_000 })
async function command(args: string[]) {
  const r = await spawnTool("ffmpeg", ["-nostdin", "-v", "error", ...args], {
    cwd: root,
    timeoutMs: 120_000,
  })
  if (!r.ok) throw Error(`fixture FFmpeg ${r.reason}`)
}
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vera-real-video-"))
  for (const w of ["bold", "medium"] as const)
    await fs.copyFile(
      path.join(fontDirectory(), VIDEO_FONTS[w]),
      path.join(root, `font-${w}.ttf`),
    )
  const list = []
  for (const [i, s] of project.scenes.entries()) {
    const overlays = sceneOverlays(s, i, product.disclosure, fonts)
    for (const f of overlays.files)
      await fs.writeFile(path.join(root, f.name), f.content)
    await command([
      "-f",
      "lavfi",
      "-i",
      "color=c=0x243454:s=1080x1920:r=30",
      "-vf",
      overlays.filters.join(","),
      "-frames:v",
      String(s.durationFrames),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "18",
      "-threads",
      "2",
      "-pix_fmt",
      "yuv420p",
      "-y",
      `scene-${i}.mp4`,
    ])
    list.push(`file 'scene-${i}.mp4'`)
  }
  await fs.writeFile(path.join(root, "list.txt"), list.join("\n"))
  video = path.join(root, "valid.mp4")
  await command([
    "-f",
    "concat",
    "-safe",
    "1",
    "-i",
    "list.txt",
    "-c",
    "copy",
    "-y",
    video,
  ])
}, 120_000)
afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true })
})
async function check(file: string, override = project) {
  const work = await fs.mkdtemp(path.join(root, "check-"))
  try {
    return await videoChecks({
      video: file,
      project: override,
      pin,
      work,
      commands: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
      run,
    })
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}
async function variant(name: string, filter: string, extra: string[] = []) {
  const file = path.join(root, `${name}.mp4`)
  await command([
    "-i",
    video,
    "-vf",
    filter,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "18",
    "-threads",
    "2",
    "-pix_fmt",
    "yuv420p",
    ...extra,
    "-y",
    file,
  ])
  return file
}
describe("Vera actual MP4 evidence", () => {
  it("decodes all frames, checks timestamps and matches every scene's real disclosure/caption samples", async () => {
    const f = await check(video)
    expect(f.filter((x) => x.outcome !== "passed")).toEqual([])
    expect(aggregateVerdict(f)).toBe("pass")
    expect(
      f.filter((x) => x.ruleId === "disclosure.decoded-masks"),
    ).toHaveLength(project.scenes.length)
  })
  it.each([
    [
      "missing-disclosure",
      "drawbox=x=0:y=190:w=1080:h=180:color=black:t=fill",
      "disclosure.decoded-masks",
    ],
    [
      "clipped-disclosure",
      "drawbox=x=540:y=190:w=540:h=180:color=black:t=fill",
      "disclosure.decoded-masks",
    ],
    [
      "missing-caption",
      "drawbox=x=0:y=1200:w=1080:h=460:color=black:t=fill",
      "caption.decoded-masks",
    ],
    [
      "blank-scene",
      "drawbox=x=0:y=0:w=1080:h=1920:color=black:t=fill:enable='between(t,6,7)'",
      "visual.black-sections",
    ],
  ])("detects %s from decoded pixels", async (name, filter, rule) => {
    const f = await check(await variant(name, filter))
    expect(f.some((x) => x.ruleId === rule && x.outcome === "failed")).toBe(
      true,
    )
  })
  it("detects a changed caption only near the start of one scene", async () => {
    const file = await variant(
      "caption-timing",
      "drawbox=x=0:y=1200:w=1080:h=460:color=black:t=fill:enable='between(t,0.3,0.8)'",
    )
    const f = await check(file)
    const first = f.find((x) => x.ruleId === "caption.decoded-masks")!
    expect(first.outcome).toBe("failed")
    expect(
      (first.observed.samples as { iou: number }[]).map((x) => x.iou >= 0.6),
    ).toEqual([false, true, true])
  })
  it("rejects wrong dimensions", async () => {
    const f = await check(await variant("dimensions", "scale=540:960"))
    expect(f.find((x) => x.ruleId === "video.format")?.outcome).toBe("failed")
  })
  it("rejects an invalid codec", async () => {
    const file = path.join(root, "mpeg4.mp4")
    await command([
      "-i",
      video,
      "-c:v",
      "mpeg4",
      "-q:v",
      "4",
      "-threads",
      "2",
      "-y",
      file,
    ])
    expect(
      (await check(file)).find((x) => x.ruleId === "video.format")?.outcome,
    ).toBe("failed")
  })
  it("rejects incorrect actual duration", async () => {
    const f = await check(await variant("duration", "null", ["-t", "14"]))
    expect(f.find((x) => x.ruleId === "video.format")?.outcome).toBe("failed")
    expect(f.find((x) => x.ruleId === "video.continuity")?.outcome).toBe(
      "failed",
    )
  })
  it("detects unexpected real audio", async () => {
    const file = path.join(root, "audio.mp4")
    await command([
      "-i",
      video,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-shortest",
      "-y",
      file,
    ])
    expect(
      (await check(file)).find((x) => x.ruleId === "audio.silent")?.outcome,
    ).toBe("failed")
  })
  it("fails closed for corrupted MP4 bytes", async () => {
    const file = path.join(root, "corrupt.mp4")
    await fs.writeFile(file, Buffer.from("not an MP4"))
    expect(aggregateVerdict(await check(file))).toBe("failed")
  })
  it("rejects unavailable tools as execution errors, never successful QA", async () => {
    await expect(
      videoChecks({
        video,
        project,
        pin,
        work: root,
        commands: { ffmpeg: "/missing/ffmpeg", ffprobe: "/missing/ffprobe" },
      }),
    ).rejects.toThrow(/unavailable/)
  })
})
