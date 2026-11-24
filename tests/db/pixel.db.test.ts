import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  makeImages,
  seedTicket,
  type SeededTicket,
} from "../../scripts/pixel/fixtures"
import {
  FIXTURE_PRODUCTS,
  startFixtureSites,
  type FixtureSites,
} from "../../scripts/scout/fixture-sites"
import { journal } from "@/server/db/journal"
import { migrationsFolder, runMigrations } from "@/server/db/migrations"
import { createDatabase, createPool } from "@/server/db/pool"
import {
  CAMPAIGN_UNAVAILABLE,
  cancelRun,
  claimTask,
  completeTask,
  planRun,
  recoverExpiredLeases,
  type Claim,
} from "@/server/orchestrator/store"
import {
  createRegistry,
  PIXEL_WORKFLOW,
  type HandlerOutcome,
  type TaskHandler,
} from "@/server/orchestrator/workflows"
import { Worker } from "@/server/orchestrator/worker"
import { createPixelHandler } from "@/server/pixel/handler"
import { pixelPlanHooks, type RenderSelection } from "@/server/pixel/plan"
import {
  getDeliverable,
  pixelOverview,
  ticketRenderStorage,
} from "@/server/pixel/store"
import { DEFAULT_MEDIA_LIMITS, storeUpload } from "@/server/tickets/media"
import { changeStatus, updateProduct } from "@/server/tickets/repository"
import { createRunner } from "@/server/process/run-executable"
import { getFfmpegCapabilities } from "@/server/video/ffmpeg-capabilities"
import { fontDirectory, loadVideoFont } from "@/server/video/font-metrics"
import { RenderGate } from "@/server/video/render-gate"

import { createScratchDatabase, type ScratchDatabase } from "./helpers"

/**
 * DV-005C on real PostgreSQL and real FFmpeg (scratch database, temporary
 * data folder): Pixel runs plan from a verified Quill script and pinned
 * images, render through the render gate, verify the output (format,
 * disclosure in real frames, checksum) and commit one immutable
 * deliverable per task.
 */

let scratch: ScratchDatabase
let pool: pg.Pool
let sites: FixtureSites
let dataRoot = ""

beforeAll(async () => {
  scratch = await createScratchDatabase("pixel")
  pool = createPool(scratch.config, { max: 10 })
  await runMigrations(pool, journal, migrationsFolder())
  sites = await startFixtureSites()
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-pixel-db-"))
}, 120_000)
afterAll(async () => {
  await pool?.end()
  await sites?.close()
  await scratch?.drop()
  if (dataRoot) await fs.rm(dataRoot, { recursive: true, force: true })
})

const pixel = (test: Parameters<typeof createPixelHandler>[0]["test"] = null) =>
  createPixelHandler({
    pool,
    dataRoot,
    gate: new RenderGate(dataRoot),
    commands: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
    getCapabilities: () => getFfmpegCapabilities(),
    fonts: { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") },
    fontDir: fontDirectory(),
    threads: 2,
    test,
  })

function worker(handlers: TaskHandler[], leaseMs = 10_000) {
  return new Worker({
    pool,
    registry: createRegistry({ verification: false, production: handlers }),
    leaseMs,
    pollMs: 50,
    log: () => {},
  }).start()
}

async function settle(runId: string, timeoutMs = 180_000) {
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
    await sleep(100)
  }
}

const version = async (ticketId: string) =>
  (
    await pool.query("SELECT version FROM affiliate_tickets WHERE id = $1", [
      ticketId,
    ])
  ).rows[0].version as number

const planPixel = async (
  ticketId: string,
  renders: RenderSelection[],
  extra: Record<string, unknown> = {},
) =>
  planRun(pool, {
    ticketId,
    ticketVersion: await version(ticketId),
    requestId: randomUUID(),
    mode: "production",
    workflow: PIXEL_WORKFLOW.id,
    productionAvailable: false,
    verificationAllowed: false,
    availableWorkflows: [PIXEL_WORKFLOW.id],
    ...pixelPlanHooks(ticketId, renders),
    ...extra,
  })

const pick = (
  p: SeededTicket["products"][number],
  n = 3,
  extra: Partial<RenderSelection> = {},
): RenderSelection => ({
  productId: p.productId,
  scriptId: p.scriptId!,
  assetIds: p.assetIds.slice(0, n),
  ...extra,
})

async function refusal(promise: Promise<unknown>) {
  try {
    await promise
  } catch (e) {
    return e as { code: string; message: string }
  }
  throw new Error("expected a refusal")
}

const sha256 = async (file: string) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex")

describe("rendering a ticket video", () => {
  let t: SeededTicket
  beforeAll(async () => {
    t = await seedTicket({
      pool,
      dataRoot,
      fixturePort: sites.port,
      products: [
        {
          name: FIXTURE_PRODUCTS.kettle.name,
          base: FIXTURE_PRODUCTS.kettle,
          images: 4,
        },
      ],
    })
  }, 180_000)

  it(
    "renders a real, verified MP4 from the pinned script and images",
    { timeout: 240_000 },
    async () => {
      const p = t.products[0]
      expect(p.scriptId).toBeTruthy()
      const { runId } = await planPixel(t.ticketId, [pick(p, 3)])
      const w = worker([pixel()])
      expect(await settle(runId)).toBe("completed")
      await w.stop()
      const overview = await pixelOverview(pool, t.ticketId)
      const render = overview.latestRun!.renders[0]
      expect(render).toMatchObject({
        state: "completed",
        taskStatus: "completed",
      })
      const found = (await getDeliverable(
        pool,
        t.ticketId,
        render.deliverableId!,
      ))!
      const d = found.deliverable
      expect(d).toMatchObject({
        width: 1080,
        height: 1920,
        fps: 30,
        videoCodec: "h264",
        pixelFormat: "yuv420p",
        audio: false,
        disclosureVerified: true,
        status: "technically_verified_awaiting_qa",
        version: 1,
      })
      expect(d.durationMs).toBeGreaterThanOrEqual(15_000)
      expect(d.durationMs).toBeLessThanOrEqual(30_000)
      const frames = d.checks.disclosureFrames as { iou: number }[]
      expect(frames.length).toBeGreaterThanOrEqual(3)
      for (const f of frames) expect(f.iou).toBeGreaterThanOrEqual(0.6)
      const output = await ticketRenderStorage(dataRoot).resolveCompletedOutput(
        found.pixelJobId,
      )
      expect(output).not.toBeNull()
      expect(await sha256(output!.path)).toBe(d.sha256)
      expect(output!.sizeBytes).toBe(d.byteSize)
      const result = (
        await pool.query(
          "SELECT kind, payload FROM task_results WHERE task_id = $1",
          [render.taskId],
        )
      ).rows[0]
      expect(result).toMatchObject({
        kind: "pixel_video",
        payload: { deliverableId: d.id, sha256: d.sha256 },
      })
    },
  )
})

async function runHandler(
  handler: TaskHandler,
  claim: Claim,
  signal = new AbortController().signal,
): Promise<HandlerOutcome> {
  return handler.run({
    taskId: claim.taskId,
    runId: claim.runId,
    ticketId: claim.ticketId,
    fence: claim.fence,
    stage: claim.stage,
    attempt: claim.attempt,
    maxAttempts: claim.maxAttempts,
    idempotencyKey: claim.idempotencyKey,
    snapshot: claim.snapshot,
    params: claim.params,
    signal,
  })
}

describe("planning a video run", () => {
  let t: SeededTicket
  beforeAll(async () => {
    t = await seedTicket({
      pool,
      dataRoot,
      fixturePort: sites.port,
      products: [
        {
          name: FIXTURE_PRODUCTS.kettle.name,
          base: FIXTURE_PRODUCTS.kettle,
          images: 7,
        },
        {
          name: FIXTURE_PRODUCTS.buds.name,
          base: FIXTURE_PRODUCTS.buds,
          images: 3,
          mediaRights: "unspecified",
        },
      ],
    })
  }, 180_000)

  it("pins an immutable manifest: script, research, snapshot and image checksums", async () => {
    const [kettle] = t.products
    const { runId } = await planPixel(t.ticketId, [pick(kettle, 6)])
    const job = (
      await pool.query("SELECT * FROM pixel_render_jobs WHERE run_id = $1", [
        runId,
      ])
    ).rows[0]
    const script = (
      await pool.query(
        "SELECT script_version, checksum, report_id, report_version, report_checksum, snapshot_checksum FROM quill_scripts WHERE id = $1",
        [kettle.scriptId],
      )
    ).rows[0]
    expect(job).toMatchObject({
      script_id: kettle.scriptId,
      script_version: script.script_version,
      script_checksum: script.checksum,
      report_id: script.report_id,
      report_checksum: script.report_checksum,
      snapshot_checksum: script.snapshot_checksum,
      asset_ids: kettle.assetIds.slice(0, 6),
      render_config: "pixel-ticket-render/1",
      state: "planned",
    })
    expect(job.asset_sha256).toHaveLength(6)
    await expect(
      pool.query(
        "UPDATE pixel_render_jobs SET asset_ids = asset_ids[1:3] WHERE id = $1",
        [job.id],
      ),
    ).rejects.toThrow(/manifest is immutable/)
    await expect(
      pool.query("DELETE FROM pixel_render_jobs WHERE id = $1", [job.id]),
    ).rejects.toThrow(/never deleted/)
    await cancelRun(pool, t.ticketId, runId, randomUUID())
  })

  it("refuses bad selections, unacknowledged rights and the full campaign", async () => {
    const [kettle, buds] = t.products
    expect(
      await refusal(planPixel(t.ticketId, [pick(kettle, 2)])),
    ).toMatchObject({ code: "invalid" })
    expect(
      await refusal(planPixel(t.ticketId, [pick(kettle, 7)])),
    ).toMatchObject({ code: "invalid" })
    expect(
      await refusal(
        planPixel(t.ticketId, [
          {
            ...pick(kettle),
            assetIds: [
              kettle.assetIds[0],
              kettle.assetIds[0],
              kettle.assetIds[1],
            ],
          },
        ]),
      ),
    ).toMatchObject({ code: "invalid" })
    expect(
      await refusal(
        planPixel(t.ticketId, [{ ...pick(kettle), scriptId: buds.scriptId! }]),
      ),
    ).toMatchObject({ code: "not-found" })
    expect(
      await refusal(
        planPixel(t.ticketId, [{ ...pick(kettle), assetIds: buds.assetIds }]),
      ),
    ).toMatchObject({ code: "invalid" })
    const rights = await refusal(planPixel(t.ticketId, [pick(buds)]))
    expect(rights.message).toMatch(/media rights are unspecified/)
    const ok = await planPixel(t.ticketId, [
      pick(buds, 3, { rightsAcknowledged: true }),
    ])
    expect(
      (
        await pool.query(
          "SELECT rights_acknowledged FROM pixel_render_jobs WHERE run_id = $1",
          [ok.runId],
        )
      ).rows[0].rights_acknowledged,
    ).toBe(true)
    await cancelRun(pool, t.ticketId, ok.runId, randomUUID())
    const campaign = await refusal(
      planRun(pool, {
        ticketId: t.ticketId,
        ticketVersion: await version(t.ticketId),
        requestId: randomUUID(),
        mode: "production",
        workflow: "campaign-v1",
        productionAvailable: false,
        verificationAllowed: false,
      }),
    )
    expect(campaign).toMatchObject({
      code: "unavailable",
      message: CAMPAIGN_UNAVAILABLE,
    })
    expect(campaign.message).toMatch(/result handoffs/)
    expect(campaign.message).not.toMatch(/Pixel \(DV-005C\)/)
  })

  it("refuses a script whose checksum no longer verifies", async () => {
    const [kettle] = t.products
    await pool.query(
      "ALTER TABLE quill_scenes DISABLE TRIGGER quill_scenes_immutable",
    )
    await pool.query(
      "UPDATE quill_scenes SET visual = visual || ' ' WHERE script_id = $1 AND position = 0",
      [kettle.scriptId],
    )
    await pool.query(
      "ALTER TABLE quill_scenes ENABLE TRIGGER quill_scenes_immutable",
    )
    const corrupt = await refusal(planPixel(t.ticketId, [pick(kettle)]))
    expect(corrupt.message).toMatch(/fails its checksum/)
  })

  it("refuses a script written before images were added, and says what to do", async () => {
    const [, buds] = t.products
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-new-image-"))
    const [image] = await makeImages(tmp, 1, 99)
    const bytes = new Uint8Array(await fs.readFile(image.file))
    const db = createDatabase(pool)
    // A Ready ticket must go back to Draft for edits; uploading is an edit.
    await changeStatus(db, t.ticketId, await version(t.ticketId), "draft")
    await storeUpload({
      db,
      dataRoot,
      ticketId: t.ticketId,
      productId: buds.productId,
      body: new Blob([bytes]).stream(),
      declaredLength: bytes.length,
      declaredType: image.type,
      fileName: "new.png",
      limits: DEFAULT_MEDIA_LIMITS,
      tools: {
        run: createRunner({ timeoutMs: 60_000 }),
        ffmpeg: "ffmpeg",
        ffprobe: "ffprobe",
      },
    })
    await fs.rm(tmp, { recursive: true, force: true })
    await changeStatus(db, t.ticketId, await version(t.ticketId), "ready")
    const stale = await refusal(
      planPixel(t.ticketId, [pick(buds, 3, { rightsAcknowledged: true })]),
    )
    expect(stale).toMatchObject({ code: "stale-research" })
    expect(stale.message).toMatch(
      /mark the updated ticket Ready, run Scout again, write a new Quill script/,
    )
    const overview = await pixelOverview(pool, t.ticketId)
    const b = overview.products.find((p) => p.productId === buds.productId)!
    expect(b.scripts[0]).toMatchObject({ current: false })
    expect(b.images.filter((i) => !i.inScriptInput)).toHaveLength(1)
  })
})

describe("crashes, cancellation, isolation and versions", () => {
  let t: SeededTicket
  beforeAll(async () => {
    t = await seedTicket({
      pool,
      dataRoot,
      fixturePort: sites.port,
      products: [
        {
          name: FIXTURE_PRODUCTS.kettle.name,
          base: FIXTURE_PRODUCTS.kettle,
          images: 3,
        },
        {
          name: `${FIXTURE_PRODUCTS.kettle.name} (second batch)`,
          base: FIXTURE_PRODUCTS.kettle,
          images: 3,
        },
      ],
    })
  }, 180_000)

  it(
    "reuses a verified output after a crash between rendering and committing; one deliverable",
    { timeout: 300_000 },
    async () => {
      const [p] = t.products
      const { runId } = await planPixel(t.ticketId, [pick(p)])
      const handler = pixel()
      const first = (await claimTask(pool, {
        workerId: "w-first",
        stages: ["pixel.render"],
        leaseMs: 120_000,
      }))!
      const firstOutcome = await runHandler(handler, first)
      expect(firstOutcome.status).toBe("completed")
      const renderedJob = (
        await pool.query(
          "SELECT pixel_job_id FROM pixel_render_jobs WHERE task_id = $1",
          [first.taskId],
        )
      ).rows[0].pixel_job_id
      // The worker "dies" before committing; its lease runs out.
      await pool.query(
        "UPDATE worker_tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [first.taskId],
      )
      await recoverExpiredLeases(pool, {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
      })
      await pool.query(
        "UPDATE worker_tasks SET eligible_at = now() WHERE id = $1",
        [first.taskId],
      )
      const second = (await claimTask(pool, {
        workerId: "w-second",
        stages: ["pixel.render"],
        leaseMs: 120_000,
      }))!
      const secondOutcome = await runHandler(handler, second)
      if (
        firstOutcome.status !== "completed" ||
        secondOutcome.status !== "completed"
      )
        throw new Error("expected completions")
      // The stale worker can't publish; the new one publishes once, reusing the output.
      expect(
        await completeTask(
          pool,
          first,
          firstOutcome.result,
          firstOutcome.deliverable,
        ),
      ).toBe("stale")
      const results = await Promise.all([
        completeTask(
          pool,
          second,
          secondOutcome.result,
          secondOutcome.deliverable,
        ),
        completeTask(
          pool,
          second,
          secondOutcome.result,
          secondOutcome.deliverable,
        ),
      ])
      expect(results.sort()).toEqual(["committed", "stale"])
      const rows = (
        await pool.query(
          "SELECT pixel_job_id, checks FROM pixel_deliverables WHERE task_id = $1",
          [second.taskId],
        )
      ).rows
      expect(rows).toHaveLength(1)
      expect(rows[0].pixel_job_id).toBe(renderedJob)
      expect(rows[0].checks.reusedEarlierAttempt).toBe(true)
      expect(await settle(runId)).toBe("completed")
      await expect(
        pool.query("UPDATE pixel_deliverables SET status = status"),
      ).rejects.toThrow(/immutable/)
      await expect(
        pool.query("DELETE FROM pixel_deliverables"),
      ).rejects.toThrow(/immutable/)
    },
  )

  it(
    "cancels an active encode: FFmpeg stops, the gate is released, nothing is published",
    { timeout: 300_000 },
    async () => {
      const [p] = t.products
      const { runId } = await planPixel(t.ticketId, [pick(p)])
      const w = worker([pixel()])
      for (let i = 0; i < 600; i++) {
        const s = (
          await pool.query(
            "SELECT state FROM pixel_render_jobs WHERE run_id = $1",
            [runId],
          )
        ).rows[0].state
        if (s === "rendering") break
        await sleep(50)
      }
      await sleep(1_500)
      await cancelRun(pool, t.ticketId, runId, randomUUID())
      expect(await settle(runId, 60_000)).toBe("cancelled")
      await w.stop()
      expect(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM pixel_deliverables WHERE run_id = $1",
              [runId],
            )
          ).rows[0].count,
        ),
      ).toBe(0)
      const gate = new RenderGate(dataRoot)
      expect((await gate.status()).held).toBe(false)
      const job = (
        await pool.query(
          "SELECT pixel_job_id FROM pixel_render_jobs WHERE run_id = $1",
          [runId],
        )
      ).rows[0].pixel_job_id
      expect((await ticketRenderStorage(dataRoot).readJob(job)).state).toBe(
        "cancelled",
      )
    },
  )

  it(
    "a broken image fails only its own product; the other renders; versions count per product",
    { timeout: 300_000 },
    async () => {
      const [p, q] = t.products
      // Corrupt one pinned image of the second product on disk (simulated disk damage).
      const row = (
        await pool.query(
          "SELECT ticket_id, id, extension FROM ticket_assets WHERE id = $1",
          [q.assetIds[1]],
        )
      ).rows[0]
      const file = path.join(
        dataRoot,
        "tickets",
        row.ticket_id,
        "assets",
        `${row.id}.${row.extension}`,
      )
      const original = await fs.readFile(file)
      const damaged = Buffer.from(original)
      damaged[damaged.length - 10] ^= 0xff
      await fs.writeFile(file, damaged)
      try {
        const { runId } = await planPixel(t.ticketId, [pick(p), pick(q)])
        const w = worker([pixel()])
        expect(await settle(runId)).toBe("completed_with_errors")
        await w.stop()
        const renders = (await pixelOverview(pool, t.ticketId)).latestRun!
          .renders
        expect(renders.find((r) => r.productId === p.productId)).toMatchObject({
          taskStatus: "completed",
        })
        const broken = renders.find((r) => r.productId === q.productId)!
        expect(broken.taskStatus).toBe("needs_input")
        expect(broken.failureMessage).toMatch(/no longer match their checksum/)
        const versions = (
          await pool.query(
            "SELECT deliverable_version FROM pixel_deliverables WHERE product_id = $1 ORDER BY deliverable_version",
            [p.productId],
          )
        ).rows.map((r) => r.deliverable_version)
        expect(versions).toEqual([1, 2])
      } finally {
        await fs.writeFile(file, original)
      }
    },
  )

  it("keeps a pinned image from being removed while its render is unfinished", async () => {
    const [p] = t.products
    const { runId } = await planPixel(t.ticketId, [pick(p)])
    const db = createDatabase(pool)
    const { removeAssetRecord } = await import("@/server/tickets/repository")
    await changeStatus(db, t.ticketId, await version(t.ticketId), "draft")
    await expect(
      removeAssetRecord(db, t.ticketId, p.productId, p.assetIds[0]),
    ).rejects.toMatchObject({ code: "in-use" })
    await cancelRun(pool, t.ticketId, runId, randomUUID())
    await changeStatus(db, t.ticketId, await version(t.ticketId), "ready")
    void updateProduct
  })

  it(
    "the frame check rejects a video whose disclosure differs (negative control)",
    { timeout: 120_000 },
    async () => {
      const d = (
        await pool.query(
          "SELECT pixel_job_id FROM pixel_deliverables ORDER BY created_at LIMIT 1",
        )
      ).rows[0]
      const storage = ticketRenderStorage(dataRoot)
      const output = (await storage.resolveCompletedOutput(d.pixel_job_id))!
      const project = await storage.readProject(d.pixel_job_id)
      const { verifyDisclosureFrames } = await import("@/server/pixel/frames")
      const lease = await new RenderGate(dataRoot).acquire({
        kind: "test",
        jobId: d.pixel_job_id,
        storageRoot: storage.root,
      })
      const work = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-frames-"))
      try {
        const { spawnTool } = await import("@/server/process/run-executable")
        const check = (text: string) =>
          verifyDisclosureFrames({
            video: output.path,
            project,
            disclosure: text,
            fonts: {
              bold: loadVideoFont("bold"),
              medium: loadVideoFont("medium"),
            },
            fontDir: fontDirectory(),
            work,
            ffmpeg: "ffmpeg",
            spawn: lease.wrap(spawnTool),
          })
        expect((await check(project.product.disclosure)).verified).toBe(true)
        const other = await check(
          "Sponsored content: we were paid to show this product.",
        )
        expect(other.verified).toBe(false)
        expect(Math.max(...other.scenes.map((s) => s.iou))).toBeLessThan(0.6)
      } finally {
        await lease.release()
        await fs.rm(work, { recursive: true, force: true })
      }
    },
  )
})

describe("backup and restore with ticket videos", () => {
  it(
    "restores videos byte for byte, with research, scripts, versions and Studio jobs",
    { timeout: 400_000 },
    async () => {
      const { createBackup, restoreBackup } =
        await import("@/server/backup/backup")
      const { createVideoStorage } = await import("@/server/video/storage")
      const { getScript } = await import("@/server/quill/store")
      const { verifyScoutReport } = await import("@/server/scout/store")
      const source = await createScratchDatabase("bkpxsrc")
      const target = await createScratchDatabase("bkpxdst")
      const temp = await fs.mkdtemp(
        path.join(os.tmpdir(), "deskverse-backup-pixel-"),
      )
      const srcData = path.join(temp, "data")
      const original = { pool, dataRoot }
      try {
        pool = createPool(source.config, { max: 8 })
        dataRoot = srcData
        await fs.mkdir(srcData, { recursive: true })
        await runMigrations(pool, journal, migrationsFolder())
        const t = await seedTicket({
          pool,
          dataRoot,
          fixturePort: sites.port,
          products: [
            {
              name: FIXTURE_PRODUCTS.kettle.name,
              base: FIXTURE_PRODUCTS.kettle,
              images: 3,
            },
          ],
        })
        const { runId } = await planPixel(t.ticketId, [pick(t.products[0])])
        const w = worker([pixel()])
        expect(await settle(runId)).toBe("completed")
        await w.stop()
        // A standalone Pixel Studio job alongside (its own storage root).
        const studio = createVideoStorage(srcData)
        const studioJob = await studio.createJob()
        const before = (
          await pool.query(
            "SELECT id, pixel_job_id, sha256, deliverable_version FROM pixel_deliverables",
          )
        ).rows[0]
        const script = (
          await pool.query("SELECT id, run_id, checksum FROM quill_scripts")
        ).rows[0]
        const report = (
          await pool.query("SELECT id, checksum FROM scout_reports")
        ).rows[0]
        const mp4 = path.join(
          srcData,
          "ticket-renders",
          "video",
          "jobs",
          before.pixel_job_id,
          "output",
          "video.mp4",
        )
        const bytesBefore = await fs.readFile(mp4)
        await pool.end()
        const { dir, manifest } = await createBackup({
          db: source.config,
          journal,
          dataRoot: srcData,
          backupsRoot: path.join(temp, "backups"),
          projectRoot: process.cwd(),
          deskverseVersion: "test",
          checkProcesses: false,
        })
        expect(manifest.formatVersion).toBe(3)
        expect(manifest.database.migrations.current).toBe(
          "0008_automatic_campaign_handoffs",
        )
        expect(manifest.ticketVideos?.deliverables).toBe(1)
        expect(
          manifest.ticketVideos?.files.some(
            (f) =>
              f.path.endsWith(`${before.pixel_job_id}/output/video.mp4`) &&
              f.sha256 === before.sha256,
          ),
        ).toBe(true)
        expect(
          manifest.media.files.some((f) =>
            f.path.startsWith(`video/jobs/${studioJob.id}/`),
          ),
        ).toBe(true)
        const restoredData = path.join(temp, "restored")
        await restoreBackup({
          dir,
          target: target.config,
          dataRoot: restoredData,
          journal,
        })
        pool = createPool(target.config, { max: 4 })
        dataRoot = restoredData
        const bytesAfter = await fs.readFile(
          path.join(
            restoredData,
            "ticket-renders",
            "video",
            "jobs",
            before.pixel_job_id,
            "output",
            "video.mp4",
          ),
        )
        expect(Buffer.compare(bytesBefore, bytesAfter)).toBe(0)
        const found = (await getDeliverable(pool, t.ticketId, before.id))!
        expect(found.deliverable).toMatchObject({
          sha256: before.sha256,
          version: before.deliverable_version,
        })
        expect(
          (
            await ticketRenderStorage(restoredData).resolveCompletedOutput(
              before.pixel_job_id,
            )
          )?.sizeBytes,
        ).toBe(bytesAfter.length)
        expect(
          (await getScript(pool, t.ticketId, script.run_id, script.id))
            ?.integrity,
        ).toBe("verified")
        expect((await verifyScoutReport(pool, report.id))?.intact).toBe(true)
        expect(
          (await createVideoStorage(restoredData).readJob(studioJob.id)).id,
        ).toBe(studioJob.id)
        await expect(
          pool.query("DELETE FROM pixel_deliverables"),
        ).rejects.toThrow(/immutable/)
      } finally {
        await pool.end().catch(() => undefined)
        pool = original.pool
        dataRoot = original.dataRoot
        await source.drop()
        await target.drop()
        await fs.rm(temp, { recursive: true, force: true })
      }
    },
  )
})
