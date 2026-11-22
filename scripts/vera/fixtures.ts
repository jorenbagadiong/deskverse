import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import type pg from "pg"
import { seedTicket } from "../pixel/fixtures"
import { FIXTURE_PRODUCTS } from "../scout/fixture-sites"
import { planRun } from "@/server/orchestrator/store"
import {
  createRegistry,
  VERA_WORKFLOW,
  PIXEL_WORKFLOW,
  type TaskHandler,
} from "@/server/orchestrator/workflows"
import { Worker } from "@/server/orchestrator/worker"
import { createPixelHandler } from "@/server/pixel/handler"
import { pixelPlanHooks } from "@/server/pixel/plan"
import { getFfmpegCapabilities } from "@/server/video/ffmpeg-capabilities"
import { fontDirectory, loadVideoFont } from "@/server/video/font-metrics"
import { RenderGate } from "@/server/video/render-gate"
import { veraPlanHooks, type ReviewSelection } from "@/server/vera/plan"

export async function ticketVersion(pool: pg.Pool, ticketId: string) {
  return (
    await pool.query("SELECT version FROM affiliate_tickets WHERE id=$1", [
      ticketId,
    ])
  ).rows[0].version as number
}
export async function settle(pool: pg.Pool, runId: string, timeout = 600000) {
  const end = Date.now() + timeout
  for (;;) {
    const row = (
      await pool.query("SELECT status FROM campaign_runs WHERE id=$1", [runId])
    ).rows[0]
    if (
      ["completed", "completed_with_errors", "failed", "cancelled"].includes(
        row.status,
      )
    )
      return row.status as string
    if (Date.now() > end) throw Error(`Run timeout: ${row.status}`)
    await sleep(100)
  }
}
export function worker(pool: pg.Pool, handlers: TaskHandler[]) {
  return new Worker({
    pool,
    registry: createRegistry({ verification: false, production: handlers }),
    pollMs: 50,
    leaseMs: 30000,
    log: () => {},
  }).start()
}
export async function seedVideos(options: {
  pool: pg.Pool
  dataRoot: string
  fixturePort: number
  count: number
  unspecified?: boolean
}) {
  const t = await seedTicket({
    ...options,
    products: Array.from({ length: options.count }, (_, i) => ({
      name: FIXTURE_PRODUCTS.kettle.name,
      base: FIXTURE_PRODUCTS.kettle,
      images: 3,
      mediaRights:
        options.unspecified && i === options.count - 1
          ? "unspecified"
          : "owned",
    })),
  })
  const run = await planRun(options.pool, {
    ticketId: t.ticketId,
    ticketVersion: await ticketVersion(options.pool, t.ticketId),
    requestId: randomUUID(),
    mode: "production",
    workflow: PIXEL_WORKFLOW.id,
    productionAvailable: false,
    verificationAllowed: false,
    availableWorkflows: [PIXEL_WORKFLOW.id],
    ...pixelPlanHooks(
      t.ticketId,
      t.products.map((p) => ({
        productId: p.productId,
        scriptId: p.scriptId!,
        assetIds: p.assetIds,
        rightsAcknowledged: true,
      })),
    ),
  })
  const w = worker(options.pool, [
    createPixelHandler({
      pool: options.pool,
      dataRoot: options.dataRoot,
      gate: new RenderGate(options.dataRoot),
      commands: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
      getCapabilities: () => getFfmpegCapabilities(),
      fonts: { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") },
      fontDir: fontDirectory(),
      threads: 2,
    }),
  ])
  try {
    if ((await settle(options.pool, run.runId)) !== "completed")
      throw Error("Real Pixel fixture render failed")
  } finally {
    await w.stop()
  }
  const deliverables = (
    await options.pool.query(
      "SELECT * FROM pixel_deliverables WHERE ticket_id=$1 ORDER BY created_at",
      [t.ticketId],
    )
  ).rows
  return { ...t, deliverables }
}
export async function planVera(
  pool: pg.Pool,
  dataRoot: string,
  ticketId: string,
  reviews: ReviewSelection[],
  requestId = randomUUID(),
) {
  return planRun(pool, {
    ticketId,
    ticketVersion: await ticketVersion(pool, ticketId),
    requestId,
    mode: "production",
    workflow: VERA_WORKFLOW.id,
    productionAvailable: false,
    verificationAllowed: false,
    availableWorkflows: [VERA_WORKFLOW.id],
    ...veraPlanHooks(ticketId, reviews, dataRoot),
  })
}
