import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

import { makeImages } from "./fixtures"
import { DEFAULT_DISCLOSURE } from "@/lib/video/validation"
import { createRunner, spawnTool } from "@/server/process/run-executable"
import { getFfmpegCapabilities } from "@/server/video/ffmpeg-capabilities"
import { fontDirectory, loadVideoFont } from "@/server/video/font-metrics"
import { buildTrustedProject } from "@/server/video/project"
import { RenderGate } from "@/server/video/render-gate"
import { RenderQueue } from "@/server/video/render-queue"
import { renderVideo } from "@/server/video/render-service"
import { createVideoStorage } from "@/server/video/storage"

/**
 * TEST TOOL (DV-005C): one standalone Pixel Studio render in its own
 * process, exactly as Studio does it (RenderQueue + renderVideo + the
 * render gate), on a TEMPORARY data folder. Used by `yarn pixel:verify` to
 * render Studio videos while ticket workers render. Needs no PostgreSQL.
 */
const { values } = parseArgs({ options: { data: { type: "string" } } })

void (async () => {
  const dataRoot = values.data!
  const storage = createVideoStorage(dataRoot)
  const fonts = { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") }
  const job = await storage.createJob()
  const tmp = await fs.mkdtemp(
    path.join(os.tmpdir(), "deskverse-studio-images-"),
  )
  const ids: string[] = []
  for (const image of await makeImages(tmp, 3, process.pid % 50)) {
    const asset = await storage.addImageAsset(job.id, {
      bytes: new Uint8Array(await fs.readFile(image.file)),
      declaredType: image.type,
      fileName: path.basename(image.file),
    })
    ids.push(asset.id)
  }
  await fs.rm(tmp, { recursive: true, force: true })
  const built = buildTrustedProject(
    await storage.readJob(job.id),
    {
      product: {
        name: "Studio test product",
        headline: "A standalone Studio video",
        benefits: [
          "Rendered by Pixel Studio",
          "Through the shared render gate",
        ],
        callToAction: "See the details",
        disclosure: DEFAULT_DISCLOSURE,
      },
      assetIds: ids,
    },
    fonts,
  )
  if (!built.ok) throw new Error(built.issues[0].message)
  await storage.writeProject(job.id, built.value)
  const queue = new RenderQueue(
    storage,
    (id, onProgress, signal, lease) =>
      renderVideo(
        id,
        {
          storage,
          lease: lease!,
          spawn: spawnTool,
          run: createRunner({ timeoutMs: 30_000 }),
          getCapabilities: () => getFfmpegCapabilities(),
          commands: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
          fonts,
          fontDir: fontDirectory(),
          threads: 2,
          timeouts: { sceneMs: 60_000, encodeMs: 10 * 60_000 },
        },
        onProgress,
        signal,
      ),
    () => {},
    new RenderGate(dataRoot),
  )
  await queue.enqueue(job.id)
  await queue.whenIdle()
  const final = await storage.readJob(job.id)
  process.stdout.write(
    `${JSON.stringify({ jobId: job.id, state: final.state, output: final.output })}\n`,
  )
  process.exit(final.state === "completed" ? 0 : 1)
})().catch((error: unknown) => {
  process.stdout.write(
    `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
  )
  process.exit(1)
})
