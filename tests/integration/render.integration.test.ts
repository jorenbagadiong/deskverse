/**
 * Real FFmpeg integration test (DV-003B). Not part of `yarn test`: run it
 * with `yarn test:integration` on a machine with FFmpeg and FFprobe installed.
 *
 * Nothing is mocked: real capability detection (including test encodes),
 * real uploads through the byte-sniffing + FFprobe verifier, a server-built
 * project, the render queue, FFmpeg composing and encoding, and FFprobe
 * verification. It fails (rather than skips) when FFmpeg is missing.
 */
import { execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { FfmpegCapabilityReport } from "@/lib/video/capabilities"
import { createRunner, spawnTool } from "@/server/process/run-executable"
import { detectFfmpegCapabilities } from "@/server/video/ffmpeg-capabilities"
import { fontDirectory, loadVideoFont } from "@/server/video/font-metrics"
import { buildTrustedProject } from "@/server/video/project"
import { RenderQueue } from "@/server/video/render-queue"
import { renderVideo } from "@/server/video/render-service"
import { createVideoStorage, StorageError } from "@/server/video/storage"
import { createUploadVerifier } from "@/server/video/upload-verify"
import { testLease } from "../support/test-lease"

/** A real render-gate lease (DV-005C): renderVideo requires one. */
const lease = await testLease()

const commands = { ffmpeg: "ffmpeg", ffprobe: "ffprobe" }
const fonts = { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") }

let base: string
let capabilities: FfmpegCapabilityReport

/** Generates a real image file with FFmpeg's test sources. */
function makeImage(file: string, source: string, size: string) {
  execFileSync(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `${source}=s=${size}`,
      "-frames:v",
      "1",
      "-y",
      file,
    ],
    { stdio: "ignore" },
  )
  return fs.readFile(file)
}

beforeAll(async () => {
  capabilities = await detectFfmpegCapabilities({
    run: createRunner({ timeoutMs: 30_000 }),
  })
  if (capabilities.status !== "ready")
    throw new Error(
      `FFmpeg isn't ready (${capabilities.status}): ${capabilities.issues.map((i) => i.message).join(" ")}`,
    )
  base = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-integration-"))
})

afterAll(async () => {
  if (base) await fs.rm(base, { recursive: true, force: true })
})

describe("real FFmpeg rendering", () => {
  it("detects a working H.264 encoder by actually encoding", () => {
    expect(capabilities.selectedH264Encoder).not.toBeNull()
    const selected = capabilities.h264Encoders.find(
      (e) => e.name === capabilities.selectedH264Encoder,
    )
    expect(selected?.works).toBe(true)
  })

  it("rejects a damaged image that still has a valid header", async () => {
    const storage = createVideoStorage(path.join(base, "corrupt"))
    const job = await storage.createJob()
    const good = await makeImage(
      path.join(base, "whole.jpg"),
      "testsrc2",
      "1200x1600",
    )
    // Keep the header (so sniffing and dimensions pass) but cut the image data.
    const damaged = good.subarray(0, Math.floor(good.length / 3))
    await expect(
      storage.addImageAsset(
        job.id,
        { bytes: damaged, declaredType: "image/jpeg", fileName: "damaged.jpg" },
        {
          verify: createUploadVerifier(
            createRunner({ timeoutMs: 15_000 }),
            commands,
          ),
        },
      ),
    ).rejects.toBeInstanceOf(StorageError)
    expect((await storage.readJob(job.id)).assets).toEqual([])
  })

  it(
    "uploads real images, renders, verifies and publishes a 1080×1920 H.264 MP4",
    async () => {
      const storage = createVideoStorage(path.join(base, "render"))
      const job = await storage.createJob()
      const verify = createUploadVerifier(
        createRunner({ timeoutMs: 15_000 }),
        commands,
      )
      const uploads = [
        {
          name: "hero.jpg",
          type: "image/jpeg",
          source: "testsrc2",
          size: "1200x1600",
        },
        {
          name: "side.png",
          type: "image/png",
          source: "mandelbrot",
          size: "1600x1200",
        },
        {
          name: "detail.webp",
          type: "image/webp",
          source: "smptehdbars",
          size: "1080x1080",
        },
      ]
      const assetIds = []
      for (const upload of uploads) {
        const bytes = await makeImage(
          path.join(base, upload.name),
          upload.source,
          upload.size,
        )
        const asset = await storage.addImageAsset(
          job.id,
          { bytes, declaredType: upload.type, fileName: upload.name },
          { verify },
        )
        assetIds.push(asset.id)
      }

      const project = buildTrustedProject(
        await storage.readJob(job.id),
        {
          product: {
            name: "Trailblazer travel mug",
            headline: "Hot coffee for 12 hours, wherever you go",
            benefits: ["Leak-proof lid for your bag", "Fits every cup holder"],
            callToAction: "Tap the link to shop",
            disclosure:
              "#ad · I may earn a commission if you buy through my link.",
          },
          assetIds,
        },
        fonts,
      )
      if (!project.ok) throw new Error(JSON.stringify(project.issues))
      await storage.writeProject(job.id, project.value)

      const phases = new Set<string>()
      const encodeFractions: number[] = []
      const queue = new RenderQueue(storage, (jobId, onProgress) =>
        renderVideo(
          jobId,
          {
            storage,
            spawn: spawnTool,
            run: createRunner({ timeoutMs: 30_000 }),
            lease,
            getCapabilities: async () => capabilities,
            commands,
            fonts,
            fontDir: fontDirectory(),
            threads: 4,
            timeouts: { sceneMs: 60_000, encodeMs: 5 * 60_000 },
            log: (message) => console.error(message),
          },
          (progress) => {
            phases.add(progress.phase)
            if (progress.phase === "encoding")
              encodeFractions.push(progress.fraction)
            onProgress(progress)
          },
        ),
      )
      const started = Date.now()
      await queue.enqueue(job.id)
      await queue.whenIdle()
      const elapsed = (Date.now() - started) / 1000

      const done = await storage.readJob(job.id)
      expect(done.error).toBeNull()
      expect(done.state).toBe("completed")
      expect(done.output).toMatchObject({
        width: 1080,
        height: 1920,
        fps: 30,
        videoCodec: "h264",
        pixelFormat: "yuv420p",
        encoder: capabilities.selectedH264Encoder,
      })
      expect(done.output!.durationSeconds).toBeGreaterThanOrEqual(15)
      expect(done.output!.durationSeconds).toBeLessThanOrEqual(30)
      expect(phases).toEqual(
        new Set(["preparing", "composing", "encoding", "verifying"]),
      )
      // Real progress from FFmpeg: rises and reaches the end.
      expect(encodeFractions.at(-1)).toBeGreaterThan(0.95)

      // Independent check of the published file.
      const output = await storage.resolveCompletedOutput(job.id)
      expect(output).not.toBeNull()
      const probe = JSON.parse(
        execFileSync("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "format=format_name,duration:stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,nb_frames",
          "-of",
          "json",
          output!.path,
        ]).toString(),
      )
      expect(probe.streams).toHaveLength(1)
      expect(probe.streams[0]).toMatchObject({
        codec_type: "video",
        codec_name: "h264",
        width: 1080,
        height: 1920,
        pix_fmt: "yuv420p",
        avg_frame_rate: "30/1",
      })
      expect(Number(probe.streams[0].nb_frames)).toBe(
        project.value.scenes.reduce((n, s) => n + s.durationFrames, 0),
      )
      // The work directory is emptied after rendering.
      expect(await fs.readdir(await storage.workDir(job.id))).toEqual([])

      // Keep a frame for visual inspection when DESKVERSE_INSPECT_DIR is set.
      const inspectDir = process.env.DESKVERSE_INSPECT_DIR
      if (inspectDir) {
        await fs.copyFile(
          output!.path,
          path.join(inspectDir, "integration.mp4"),
        )
        let start = 0
        for (const scene of project.value.scenes) {
          const middle = (start + scene.durationFrames / 2) / 30
          start += scene.durationFrames
          execFileSync("ffmpeg", [
            "-nostdin",
            "-v",
            "error",
            "-ss",
            middle.toFixed(2),
            "-i",
            output!.path,
            "-frames:v",
            "1",
            "-y",
            path.join(inspectDir, `frame-${scene.id}-${scene.kind}.png`),
          ])
        }
      }
      console.info(
        `[integration] ${capabilities.selectedH264Encoder}: ${done.output!.durationSeconds}s video, ${(done.output!.sizeBytes / 1024 / 1024).toFixed(2)} MB, rendered in ${elapsed.toFixed(1)}s`,
      )
    },
    5 * 60_000,
  )
})
