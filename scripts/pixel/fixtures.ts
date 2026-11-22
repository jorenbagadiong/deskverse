import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import type pg from "pg"

import { FIXTURE_PRODUCTS } from "../scout/fixture-sites"
import { validateNewTicket } from "@/lib/tickets/validation"
import { createDatabase } from "@/server/db/pool"
import { planRun } from "@/server/orchestrator/store"
import {
  createRegistry,
  QUILL_WORKFLOW,
  RESEARCH_WORKFLOW,
  type TaskHandler,
} from "@/server/orchestrator/workflows"
import { Worker } from "@/server/orchestrator/worker"
import { createRunner } from "@/server/process/run-executable"
import { createQuillHandler } from "@/server/quill/handler"
import { readQuillConfig } from "@/server/quill/ollama"
import { readScoutConfig } from "@/server/scout/config"
import { createScoutHandler } from "@/server/scout/handler"
import { testNetwork } from "@/server/scout/net/test-network"
import { DEFAULT_MEDIA_LIMITS, storeUpload } from "@/server/tickets/media"
import {
  addProduct,
  changeStatus,
  createTicket,
} from "@/server/tickets/repository"

/**
 * TEST FIXTURES (DV-005C): real images, real ticket uploads, real Scout
 * research (local fixture sites) and real Quill scripts, on a scratch
 * database and a temporary data folder, so Pixel tests render genuine
 * videos from genuine inputs. Never touches real Deskverse data.
 */

const run = promisify(execFile)

/** N distinct real images (PNG/JPEG/WebP rotated), 900×900, via FFmpeg. */
export async function makeImages(dir: string, n: number, seed = 0) {
  await fs.mkdir(dir, { recursive: true })
  const kinds = [
    { ext: "png", type: "image/png" },
    { ext: "jpg", type: "image/jpeg" },
    { ext: "webp", type: "image/webp" },
  ] as const
  const out: { file: string; type: string }[] = []
  for (let i = 0; i < n; i++) {
    const k = kinds[(i + seed) % kinds.length]
    const file = path.join(dir, `img-${seed}-${i}.${k.ext}`)
    const hue = ((i + seed) * 47) % 360
    await run("ffmpeg", [
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=900x900:rate=1,hue=h=${hue}`,
      "-frames:v",
      "1",
      "-y",
      file,
    ])
    out.push({ file, type: k.type })
  }
  return out
}

function streamOf(bytes: Uint8Array) {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close()
      controller.enqueue(bytes.subarray(offset, offset + 64 * 1024))
      offset += 64 * 1024
    },
  })
}

export interface SeedProduct {
  name: string
  base: typeof FIXTURE_PRODUCTS.kettle | typeof FIXTURE_PRODUCTS.buds
  images: number
  mediaRights?: "owned" | "unspecified"
}

export interface SeededTicket {
  ticketId: string
  products: {
    productId: string
    name: string
    assetIds: string[]
    scriptId: string | null
  }[]
}

async function settle(pool: pg.Pool, runId: string, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const s = (
      await pool.query("SELECT status FROM campaign_runs WHERE id = $1", [
        runId,
      ])
    ).rows[0].status
    if (
      ["completed", "completed_with_errors", "failed", "cancelled"].includes(s)
    )
      return s as string
    if (Date.now() > end) throw new Error(`run still ${s}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function runOnce(pool: pg.Pool, handlers: TaskHandler[], runId: string) {
  const worker = new Worker({
    pool,
    registry: createRegistry({ verification: false, production: handlers }),
    pollMs: 50,
    log: () => {},
  }).start()
  try {
    return await settle(pool, runId)
  } finally {
    await worker.stop()
  }
}

/**
 * A Ready ticket whose products have real uploaded images, a completed
 * Scout report and a completed Quill script (template mode).
 */
export async function seedTicket(opts: {
  pool: pg.Pool
  dataRoot: string
  fixturePort: number
  products: SeedProduct[]
  title?: string
}): Promise<SeededTicket> {
  const { pool, dataRoot } = opts
  const db = createDatabase(pool)
  const tools = {
    run: createRunner({ timeoutMs: 60_000 }),
    ffmpeg: "ffmpeg",
    ffprobe: "ffprobe",
  }
  const input = validateNewTicket({
    title: opts.title ?? `Pixel ${randomUUID().slice(0, 6)}`,
    requestId: randomUUID(),
  })
  if (!input.ok) throw new Error("bad ticket")
  const ticket = (await createTicket(db, input.value)).ticket
  const tmp = await fs.mkdtemp(
    path.join(os.tmpdir(), "deskverse-pixel-images-"),
  )
  const products: SeededTicket["products"] = []
  try {
    for (const [index, p] of opts.products.entries()) {
      const { productId } = await addProduct(db, ticket.id, randomUUID(), {
        name: p.name,
        affiliateUrl: p.base.affiliateUrl,
        specifications: p.base.specifications,
        description: p.base.description,
        mediaRights: p.mediaRights ?? "owned",
        references: p.base.references.map((r) => ({
          kind: r.kind as "listing",
          url: r.url,
          label: r.label,
        })),
      })
      const assetIds: string[] = []
      for (const image of await makeImages(tmp, p.images, index * 7)) {
        const bytes = new Uint8Array(await fs.readFile(image.file))
        const asset = await storeUpload({
          db,
          dataRoot,
          ticketId: ticket.id,
          productId,
          body: streamOf(bytes),
          declaredLength: bytes.length,
          declaredType: image.type,
          fileName: path.basename(image.file),
          limits: DEFAULT_MEDIA_LIMITS,
          tools,
        })
        assetIds.push(asset.id)
      }
      products.push({ productId, name: p.name, assetIds, scriptId: null })
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
  const version = async () =>
    (
      await pool.query("SELECT version FROM affiliate_tickets WHERE id = $1", [
        ticket.id,
      ])
    ).rows[0].version
  await changeStatus(db, ticket.id, await version(), "ready")
  const research = await planRun(pool, {
    ticketId: ticket.id,
    ticketVersion: await version(),
    requestId: randomUUID(),
    mode: "production",
    workflow: RESEARCH_WORKFLOW.id,
    productionAvailable: false,
    verificationAllowed: false,
    availableWorkflows: [RESEARCH_WORKFLOW.id],
  })
  await runOnce(
    pool,
    [
      createScoutHandler({
        config: readScoutConfig({
          DESKVERSE_SCOUT_RETRIEVAL: "on",
          DESKVERSE_SCOUT_HOST_INTERVAL_MS: "0",
        }),
        network: testNetwork({ port: opts.fixturePort }),
      }),
    ],
    research.runId,
  )
  const reports = (
    await pool.query(
      "SELECT id, product_id FROM scout_reports WHERE run_id = $1",
      [research.runId],
    )
  ).rows
  const writing = await planRun(pool, {
    ticketId: ticket.id,
    ticketVersion: await version(),
    requestId: randomUUID(),
    mode: "production",
    workflow: QUILL_WORKFLOW.id,
    productionAvailable: false,
    verificationAllowed: false,
    availableWorkflows: [QUILL_WORKFLOW.id],
    scripts: reports.map((r) => ({ productId: r.product_id, reportId: r.id })),
  })
  await runOnce(
    pool,
    [createQuillHandler({ pool, config: readQuillConfig({}) })],
    writing.runId,
  )
  for (const row of (
    await pool.query(
      "SELECT id, product_id FROM quill_scripts WHERE run_id = $1",
      [writing.runId],
    )
  ).rows) {
    const p = products.find((x) => x.productId === row.product_id)
    if (p) p.scriptId = row.id
  }
  return { ticketId: ticket.id, products }
}
