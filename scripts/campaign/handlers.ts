import type pg from "pg"

import {
  createPixelHandler,
  type PixelHandlerOptions,
} from "@/server/pixel/handler"
import {
  createQuillHandler,
  type QuillHandlerOptions,
} from "@/server/quill/handler"
import { readQuillConfig } from "@/server/quill/ollama"
import { readScoutConfig } from "@/server/scout/config"
import {
  createScoutHandler,
  type ScoutHandlerOptions,
} from "@/server/scout/handler"
import { testNetwork } from "@/server/scout/net/test-network"
import { createVeraHandler } from "@/server/vera/handler"
import { getFfmpegCapabilities } from "@/server/video/ffmpeg-capabilities"
import { fontDirectory, loadVideoFont } from "@/server/video/font-metrics"
import { RenderGate } from "@/server/video/render-gate"

export function fixtureCampaignHandlers(
  pool: pg.Pool,
  dataRoot: string,
  fixturePort: number,
  options: {
    log?: (line: string) => void
    auditFile?: string
    blocked?: Set<string>
    corrupt?: Map<string, string>
    scoutCrash?: ScoutHandlerOptions["crashBeforeCommit"]
    quillTest?: QuillHandlerOptions["test"]
    pixelTest?: PixelHandlerOptions["test"]
  } = {},
) {
  const commands = { ffmpeg: "ffmpeg", ffprobe: "ffprobe" }
  const scout = createScoutHandler({
    config: readScoutConfig({
      DESKVERSE_SCOUT_RETRIEVAL: "on",
      DESKVERSE_SCOUT_HOST_INTERVAL_MS: "0",
    }),
    network: testNetwork({ port: fixturePort }),
    crashBeforeCommit: options.scoutCrash,
  })
  const handlers = [
    {
      ...scout,
      run: ((context) => {
        const product = context.snapshot?.data.product as
          { id: string } | undefined
        if (product && options.blocked?.has(product.id))
          return Promise.resolve({
            status: "permanent",
            message: "Injected campaign fixture failure.",
          } as const)
        return scout.run(context)
      }) satisfies typeof scout.run,
    },
    createQuillHandler({
      pool,
      config: readQuillConfig({}),
      test: options.quillTest,
    }),
    createPixelHandler({
      pool,
      dataRoot,
      gate: new RenderGate(dataRoot, {
        log: options.log,
        auditFile: options.auditFile,
      }),
      commands,
      getCapabilities: () => getFfmpegCapabilities(),
      fonts: { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") },
      fontDir: fontDirectory(),
      threads: 2,
      test: options.pixelTest,
      log: options.log,
    }),
    createVeraHandler({ pool, dataRoot, commands }),
  ]
  return handlers.map((handler) => ({
    ...handler,
    run: (async (context) => {
      const outcome = await handler.run(context)
      const product = context.snapshot?.data.product as
        { id: string } | undefined
      if (
        !product ||
        options.corrupt?.get(product.id) !== handler.stage ||
        outcome.status !== "completed" ||
        !outcome.deliverable
      )
        return outcome
      const deliverable = outcome.deliverable
      return {
        ...outcome,
        deliverable: {
          ...deliverable,
          async persist(client, commit) {
            const actual = await deliverable.persist(client, commit)
            return handler.stage === "pixel.render"
              ? { ...actual, sha256: "0".repeat(64) }
              : { ...actual, checksum: "0".repeat(64) }
          },
        },
      }
    }) satisfies typeof handler.run,
  }))
}
