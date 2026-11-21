/**
 * Opt-in benchmark for visual effects (DV-003D2). Skipped unless
 * DESKVERSE_BENCH=1:
 *
 *   DESKVERSE_BENCH=1 yarn test:integration effects-bench
 *
 * Renders the same project with every effect combination through the real
 * render service and reports wall time and peak *aggregate* memory (the sum
 * of VmRSS over every FFmpeg/FFprobe process this test spawns, sampled every
 * 25 ms from /proc). Optional:
 *
 * - DESKVERSE_BENCH_PHOTOS: six or more real JPEG paths separated by ":"
 *   (otherwise 4032 × 3024 photo-like JPEGs are generated);
 * - DESKVERSE_BENCH_OUT: a file to append one JSON result per render to;
 * - DESKVERSE_BENCH_KEEP: a folder to copy each finished MP4 into;
 * - DESKVERSE_BENCH_CAPTURE: a folder to copy the work files and segment
 *   arguments into (the last segment's win), to re-run an encode by hand.
 */
import { execFileSync } from "node:child_process"
import { promises as fs, readdirSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { FfmpegCapabilityReport } from "@/lib/video/capabilities"
import type { VisualEffects } from "@/lib/video/types"
import { createRunner, spawnTool } from "@/server/process/run-executable"
import { detectFfmpegCapabilities } from "@/server/video/ffmpeg-capabilities"
import { fontDirectory, loadVideoFont } from "@/server/video/font-metrics"
import { buildTrustedProject } from "@/server/video/project"
import { renderVideo } from "@/server/video/render-service"
import { createVideoStorage } from "@/server/video/storage"
import { createAudioInspector } from "@/server/video/upload-verify"

const enabled = process.env.DESKVERSE_BENCH === "1"
const commands = { ffmpeg: "ffmpeg", ffprobe: "ffprobe" }
const fonts = { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") }

let base: string
let capabilities: FfmpegCapabilityReport
let photos: string[] = []

/** Sum of VmRSS (KiB) over this process's direct children. */
function childrenRss() {
  let total = 0
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const status = readFileSync(`/proc/${entry}/status`, "utf8")
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1])
      if (ppid !== process.pid) continue
      total += Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0)
    } catch {
      // The process ended while we looked.
    }
  }
  return total
}

function makePhoto(file: string, seed: number) {
  // Photo-like detail: a gradient with film grain, so x264 works as hard as
  // it does on real photos (flat test patterns compress unrealistically).
  execFileSync("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `gradients=s=4032x3024:seed=${seed}:n=4`,
    "-vf",
    "noise=alls=10:allf=t",
    "-frames:v",
    "1",
    "-q:v",
    "5",
    "-y",
    file,
  ])
  return file
}

function makeTone(file: string, seconds: number, freq: number) {
  execFileSync("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=f=${freq}:d=${seconds}:sample_rate=44100`,
    "-af",
    "volume=0.5",
    "-ac",
    "2",
    "-y",
    file,
  ])
  return file
}

beforeAll(async () => {
  if (!enabled) return
  capabilities = await detectFfmpegCapabilities({
    run: createRunner({ timeoutMs: 30_000 }),
  })
  base = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-bench-"))
  const given = (process.env.DESKVERSE_BENCH_PHOTOS ?? "")
    .split(":")
    .filter(Boolean)
  photos =
    given.length >= 6
      ? given
      : Array.from({ length: 6 }, (_, i) =>
          makePhoto(path.join(base, `photo-${i + 1}.jpg`), i + 1),
        )
})

afterAll(async () => {
  if (base) await fs.rm(base, { recursive: true, force: true })
})

async function bench(
  label: string,
  {
    photoCount,
    benefits,
    effects,
    audio,
  }: {
    photoCount: number
    benefits: number
    effects: VisualEffects | null
    audio: boolean
  },
) {
  const storage = createVideoStorage(path.join(base, label))
  const job = await storage.createJob()
  const ids = []
  for (const [i, file] of photos.slice(0, photoCount).entries()) {
    const asset = await storage.addImageAsset(job.id, {
      bytes: new Uint8Array(await fs.readFile(file)),
      declaredType: "image/jpeg",
      fileName: `photo-${i + 1}.jpg`,
    })
    ids.push(asset.id)
  }
  let audioConfig = undefined
  if (audio) {
    const inspect = createAudioInspector(
      createRunner({ timeoutMs: 30_000 }),
      commands,
    )
    const add = async (role: "voiceover" | "music", file: string) =>
      (
        await storage.addAudioAsset(
          job.id,
          {
            bytes: new Uint8Array(await fs.readFile(file)),
            declaredType: "audio/wav",
            fileName: path.basename(file),
            role,
          },
          { inspect },
        )
      ).id
    audioConfig = {
      mode: "voiceover-and-music",
      voiceoverAssetId: await add(
        "voiceover",
        makeTone(path.join(base, `${label}-voice.wav`), 12, 220),
      ),
      musicAssetId: await add(
        "music",
        makeTone(path.join(base, `${label}-music.wav`), 9, 440),
      ),
      musicLevel: "low",
    }
  }
  const project = buildTrustedProject(
    await storage.readJob(job.id),
    {
      product: {
        name: "Aurora desk lamp",
        headline: "Light that follows your mood, day and night",
        benefits: [
          "Warm to daylight in one tap",
          "Charges your phone while you work",
          "Folds flat for travel",
          "Lasts all week on one charge",
        ].slice(0, benefits),
        callToAction: "Tap the link to shop",
        disclosure: "#ad · I may earn a commission if you buy through my link.",
      },
      assetIds: ids,
      ...(audioConfig ? { audio: audioConfig } : {}),
      ...(effects ? { effects } : {}),
    },
    fonts,
  )
  if (!project.ok) throw new Error(JSON.stringify(project.issues))
  await storage.writeProject(job.id, project.value)
  await storage.transitionJob(job.id, "queued")
  await storage.transitionJob(job.id, "rendering")

  let peak = 0
  const timer = setInterval(() => {
    peak = Math.max(peak, childrenRss())
  }, 25)
  const started = performance.now()
  try {
    const output = await renderVideo(
      job.id,
      {
        storage,
        spawn: async (command, args, options) => {
          const capture = process.env.DESKVERSE_BENCH_CAPTURE
          if (capture && args.includes("pipe:1") && !args.includes("-c:a")) {
            const dir = path.join(capture, label)
            await fs.cp(options.cwd!, dir, { recursive: true })
            await fs.writeFile(
              path.join(dir, "args.json"),
              JSON.stringify(args),
            )
          }
          return spawnTool(command, args, options)
        },
        run: createRunner({ timeoutMs: 60_000 }),
        getCapabilities: async () => capabilities,
        commands,
        fonts,
        fontDir: fontDirectory(),
        threads: Math.min(os.cpus().length, 4),
        timeouts: { sceneMs: 120_000, encodeMs: 600_000 },
        log: (message) => console.log(message.slice(0, 1500)),
      },
      () => undefined,
    )
    const seconds = (performance.now() - started) / 1000
    if (process.env.DESKVERSE_BENCH_KEEP) {
      await storage.transitionJob(job.id, "completed", { output })
      const done = await storage.resolveCompletedOutput(job.id)
      if (done)
        await fs.copyFile(
          done.path,
          path.join(process.env.DESKVERSE_BENCH_KEEP, `${label}.mp4`),
        )
    }
    const result = {
      label,
      seconds: Number(seconds.toFixed(1)),
      peakMiB: Math.round(peak / 1024),
      duration: output.durationSeconds,
      audio: output.audio !== null,
    }
    console.log(`[bench] ${JSON.stringify(result)}`)
    if (process.env.DESKVERSE_BENCH_OUT)
      await fs.appendFile(
        process.env.DESKVERSE_BENCH_OUT,
        `${JSON.stringify(result)}\n`,
      )
    return result
  } finally {
    clearInterval(timer)
  }
}

describe.skipIf(!enabled)("visual effects benchmark", () => {
  const combos: [string, VisualEffects | null][] = [
    ["legacy-static", null],
    ["motion-only", { motion: "gentle-zoom", transition: "cut" }],
    ["crossfade-only", { motion: "none", transition: "crossfade" }],
    ["motion-crossfade", { motion: "gentle-zoom", transition: "crossfade" }],
  ]
  for (const [label, effects] of combos)
    it(`four photos, five scenes: ${label}`, async () => {
      const r = await bench(`four-${label}`, {
        photoCount: 4,
        benefits: 3,
        effects,
        audio: false,
      })
      expect(r.peakMiB).toBeLessThan(750)
    })

  it("four photos with voiceover + music: static vs motion-crossfade", async () => {
    const a = await bench("audio-static", {
      photoCount: 4,
      benefits: 3,
      effects: null,
      audio: true,
    })
    const b = await bench("audio-effects", {
      photoCount: 4,
      benefits: 3,
      effects: { motion: "gentle-zoom", transition: "crossfade" },
      audio: true,
    })
    expect(a.audio && b.audio).toBe(true)
    expect(b.peakMiB).toBeLessThan(750)
  })

  for (const [label, effects] of [combos[0], combos[3]])
    it(`six photos, six scenes (stress): ${label}`, async () => {
      const r = await bench(`six-${label}`, {
        photoCount: 6,
        benefits: 4,
        effects,
        audio: false,
      })
      expect(r.peakMiB).toBeLessThan(750)
    })
})
