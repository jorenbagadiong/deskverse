import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type pg from "pg"
import {
  startFixtureSites,
  type FixtureSites,
} from "../../scripts/scout/fixture-sites"
import {
  planVera,
  seedVideos,
  settle,
  worker,
  ticketVersion,
} from "../../scripts/vera/fixtures"
import { createScratchDatabase, type ScratchDatabase } from "./helpers"
import { journal } from "@/server/db/journal"
import { migrationsFolder, runMigrations } from "@/server/db/migrations"
import { createDatabase, createPool } from "@/server/db/pool"
import {
  campaignWorkerAvailable,
  cancelRun,
  claimTask,
  completeTask,
  recoverExpiredLeases,
  planRun,
} from "@/server/orchestrator/store"
import {
  CAMPAIGN_READY,
  HandlerAborted,
  createRegistry,
  productionAvailable,
  PRODUCTION_WORKFLOW,
  workflowAvailable,
  type HandlerContext,
} from "@/server/orchestrator/workflows"
import { createVeraHandler } from "@/server/vera/handler"
import { getReview, veraOverview, persistReview } from "@/server/vera/store"
import { reviewVideo } from "@/server/vera/engine"
import { ticketRenderStorage } from "@/server/pixel/store"
import { changeStatus, updateProduct } from "@/server/tickets/repository"

let scratch: ScratchDatabase,
  pool: pg.Pool,
  sites: FixtureSites,
  root = "",
  seed: Awaited<ReturnType<typeof seedVideos>>,
  firstReview: string
let sourceBefore: Record<string, string> = {}
async function sourceHashes() {
  const hashes: Record<string, string> = {}
  for (const table of [
    "scout_reports",
    "scout_sources",
    "scout_evidence",
    "scout_claims",
    "scout_claim_evidence",
    "quill_scripts",
    "quill_scenes",
    "quill_scene_claims",
    "pixel_render_jobs",
    "pixel_deliverables",
  ]) {
    const rows = (
      await pool.query(
        `SELECT row_to_json(x)::text AS v FROM ${table} x ORDER BY row_to_json(x)::text`,
      )
    ).rows.map((r) => r.v)
    hashes[table] = JSON.stringify(rows)
  }
  return hashes
}

const handler = () =>
  createVeraHandler({
    pool,
    dataRoot: root,
    commands: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
  })
const pick = (d: Record<string, unknown>) => ({
  productId: d.product_id as string,
  deliverableId: d.id as string,
})
async function claim() {
  const c = await claimTask(pool, {
    workerId: "vera-test",
    stages: ["vera.review"],
    leaseMs: 120000,
  })
  if (!c) throw Error("No claim")
  return c
}
const context = (c: Awaited<ReturnType<typeof claim>>): HandlerContext => ({
  ...c,
  signal: new AbortController().signal,
})
beforeAll(async () => {
  scratch = await createScratchDatabase("vera")
  pool = createPool(scratch.config, { max: 8 })
  await runMigrations(pool, journal, migrationsFolder())
  sites = await startFixtureSites()
  root = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-vera-db-"))
  seed = await seedVideos({
    pool,
    dataRoot: root,
    fixturePort: sites.port,
    count: 2,
    unspecified: true,
  })
  sourceBefore = await sourceHashes()
}, 400000)
afterAll(async () => {
  await pool?.end()
  await sites?.close()
  await scratch?.drop()
  if (root) await fs.rm(root, { recursive: true, force: true })
})
describe("Vera durable workflow", () => {
  it(
    "runs real independent reviews, persists pass/owner-input separately from completed tasks",
    { timeout: 180000 },
    async () => {
      const requestId = randomUUID()
      const reviews = seed.deliverables.map(pick)
      const planned = await planVera(
        pool,
        root,
        seed.ticketId,
        reviews,
        requestId,
      )
      expect(
        await planVera(pool, root, seed.ticketId, reviews, requestId),
      ).toEqual({ ...planned, created: false })
      const w = worker(pool, [handler()])
      try {
        expect(await settle(pool, planned.runId)).toBe("completed")
      } finally {
        await w.stop()
      }
      const rows = (
        await pool.query("SELECT * FROM vera_reviews ORDER BY completed_at")
      ).rows
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => r.verdict).sort()).toEqual([
        "needs_owner_input",
        "pass",
      ])
      // Current QA belongs to each exact video, independent of the history page.
      const page = await veraOverview(pool, seed.ticketId, 0, 1)
      for (const d of page.deliverables) {
        const expected = rows.find((r) => r.deliverable_id === d.id)!
        expect(d.latestReview).toEqual({
          id: expected.id,
          version: 1,
          verdict: expected.verdict,
        })
      }
      firstReview = rows.find(
        (r) => r.product_id === seed.products[0].productId,
      )!.id
      for (const r of rows)
        expect((await getReview(pool, seed.ticketId, r.id))?.integrity).toBe(
          "verified",
        )
    },
  )
  it("keeps the exact task pin immutable across retry and state changes", async () => {
    await expect(
      pool.query(
        "UPDATE worker_tasks SET params=jsonb_set(params,'{veraPin,sha256}',to_jsonb(repeat('0',64))) WHERE stage='vera.review'",
      ),
    ).rejects.toThrow(/pin is immutable/)
  })
  it("refuses immutable review/finding edits and late finding inserts", async () => {
    for (const table of ["vera_reviews", "vera_findings"]) {
      await expect(pool.query(`UPDATE ${table} SET id=id`)).rejects.toThrow(
        /immutable/,
      )
      await expect(pool.query(`DELETE FROM ${table}`)).rejects.toThrow(
        /immutable/,
      )
    }
    await expect(
      pool.query(
        "INSERT INTO vera_findings (review_id,position,rule_id,category,severity,outcome,evidence) SELECT review_id,255,rule_id,category,severity,outcome,evidence FROM vera_findings LIMIT 1",
      ),
    ).rejects.toThrow(/completed|evidence/)
  })
  it("isolates ticket/product choices and requires a campaign worker beyond registered handlers", async () => {
    await expect(
      planVera(pool, root, seed.ticketId, [
        {
          ...pick(seed.deliverables[0]),
          productId: seed.products[1].productId,
        },
      ]),
    ).rejects.toThrow(/another product/)
    expect(await getReview(pool, randomUUID(), firstReview)).toBeNull()
    const all = PRODUCTION_WORKFLOW.stages.map((s) => ({
      ...handler(),
      stage: s.stage,
    }))
    const registry = createRegistry({ verification: false, production: all })
    expect(workflowAvailable(registry, PRODUCTION_WORKFLOW)).toBe(
      CAMPAIGN_READY,
    )
    expect(productionAvailable(registry)).toBe(CAMPAIGN_READY)
    expect(await campaignWorkerAvailable(pool)).toBe(false)
    await expect(
      planRun(pool, {
        ticketId: seed.ticketId,
        ticketVersion: await ticketVersion(pool, seed.ticketId),
        requestId: randomUUID(),
        mode: "production",
        productionAvailable: true,
        verificationAllowed: false,
      }),
    ).rejects.toThrow(/result handoffs/)
  })
  it(
    "fences lost leases, refuses duplicate completion and records historical review versions",
    { timeout: 180000 },
    async () => {
      const { runId } = await planVera(pool, root, seed.ticketId, [
        pick(seed.deliverables[0]),
      ])
      const old = await claim()
      const outcome = await handler().run(context(old))
      if (outcome.status !== "completed") throw Error("Not completed")
      await pool.query(
        "UPDATE worker_tasks SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
        [old.taskId],
      )
      await recoverExpiredLeases(pool, {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 10,
      })
      await pool.query(
        "UPDATE worker_tasks SET eligible_at=now() WHERE id=$1",
        [old.taskId],
      )
      const next = await claim()
      expect(
        await completeTask(pool, old, outcome.result, outcome.deliverable),
      ).toBe("stale")
      const again = await handler().run(context(next))
      if (again.status !== "completed") throw Error("Not completed")
      expect(
        (
          await Promise.all([
            completeTask(pool, next, again.result, again.deliverable),
            completeTask(pool, next, again.result, again.deliverable),
          ])
        ).sort(),
      ).toEqual(["committed", "stale"])
      expect(await settle(pool, runId)).toBe("completed")
      const rows = (
        await pool.query(
          "SELECT review_version FROM vera_reviews WHERE deliverable_id=$1 ORDER BY review_version",
          [seed.deliverables[0].id],
        )
      ).rows
      expect(rows.map((r) => r.review_version)).toEqual([1, 2])
    },
  )
  it(
    "rolls back report and findings on crash before commit",
    { timeout: 120000 },
    async () => {
      await planVera(pool, root, seed.ticketId, [pick(seed.deliverables[0])])
      const c = await claim()
      const doc = await reviewVideo(pool, context(c), {
        dataRoot: root,
        commands: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
      })
      await expect(
        completeTask(
          pool,
          c,
          {},
          {
            kind: "vera_review",
            persist: (client, commit) =>
              persistReview(client, commit, doc, () => {
                throw Error("crash before commit")
              }),
          },
        ),
      ).rejects.toThrow(/crash/)
      expect(
        (
          await pool.query("SELECT 1 FROM vera_reviews WHERE task_id=$1", [
            c.taskId,
          ])
        ).rowCount,
      ).toBe(0)
      await cancelRun(pool, seed.ticketId, c.runId, randomUUID())
      expect(
        await completeTask(
          pool,
          c,
          {},
          {
            kind: "vera_review",
            persist: (client, commit) => persistReview(client, commit, doc),
          },
        ),
      ).toBe("cancelled")
    },
  )
  it(
    "records missing/altered MP4 as failed QA while the task completes",
    { timeout: 120000 },
    async () => {
      const d = seed.deliverables[0]
      const { runId } = await planVera(pool, root, seed.ticketId, [pick(d)])
      const c = await claim()
      const file = (await ticketRenderStorage(root).resolveCompletedOutput(
        d.pixel_job_id,
      ))!
      const bytes = await fs.readFile(file.path)
      await fs.chmod(file.path, 0o600)
      await fs.writeFile(file.path, Buffer.from("damaged"))
      try {
        const outcome = await handler().run(context(c))
        expect(outcome.status).toBe("completed")
        if (outcome.status !== "completed") throw Error("Not completed")
        expect(
          await completeTask(pool, c, outcome.result, outcome.deliverable),
        ).toBe("committed")
        expect(
          (
            await pool.query(
              "SELECT verdict FROM vera_reviews WHERE task_id=$1",
              [c.taskId],
            )
          ).rows[0].verdict,
        ).toBe("failed")
        expect(await settle(pool, runId)).toBe("completed")
      } finally {
        await fs.writeFile(file.path, bytes)
        await fs.chmod(file.path, 0o400)
      }
    },
  )
  it(
    "preserves original lineage after owner edits and marks old reviews historical",
    { timeout: 120000 },
    async () => {
      const db = createDatabase(pool)
      await changeStatus(
        db,
        seed.ticketId,
        await ticketVersion(pool, seed.ticketId),
        "draft",
      )
      await updateProduct(db, seed.ticketId, seed.products[0].productId, {
        description: "Changed after video",
      })
      await changeStatus(
        db,
        seed.ticketId,
        await ticketVersion(pool, seed.ticketId),
        "ready",
      )
      expect((await getReview(pool, seed.ticketId, firstReview))?.current).toBe(
        false,
      )
      const overview = await veraOverview(pool, seed.ticketId)
      expect(
        overview.deliverables.find((d) => d.id === seed.deliverables[0].id)
          ?.current,
      ).toBe(false)
      await planVera(pool, root, seed.ticketId, [pick(seed.deliverables[0])])
      const c = await claim()
      const outcome = await handler().run(context(c))
      if (outcome.status !== "completed") throw Error("Not completed")
      expect(
        await completeTask(pool, c, outcome.result, outcome.deliverable),
      ).toBe("committed")
    },
  )
  it("aborts QA promptly without a report on cancellation signal", async () => {
    const { runId } = await planVera(pool, root, seed.ticketId, [
      pick(seed.deliverables[0]),
    ])
    const c = await claim()
    const controller = new AbortController()
    controller.abort()
    await expect(
      handler().run({ ...context(c), signal: controller.signal }),
    ).rejects.toBeInstanceOf(HandlerAborted)
    expect(
      (
        await pool.query("SELECT 1 FROM vera_reviews WHERE task_id=$1", [
          c.taskId,
        ])
      ).rowCount,
    ).toBe(0)
    await cancelRun(pool, seed.ticketId, runId, randomUUID())
    await completeTask(pool, c, {})
  })
  it("leaves all persisted Scout, Quill and Pixel source records unchanged", async () => {
    expect(await sourceHashes()).toEqual(sourceBefore)
  })
})
