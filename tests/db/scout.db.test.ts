import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"

import type pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  FIXTURE_PRODUCTS,
  startFixtureSites,
  type FixtureSites,
} from "../../scripts/scout/fixture-sites"
import { validateNewTicket } from "@/lib/tickets/validation"
import { journal } from "@/server/db/journal"
import { migrationsFolder, runMigrations } from "@/server/db/migrations"
import { createDatabase, createPool } from "@/server/db/pool"
import {
  CAMPAIGN_UNAVAILABLE,
  cancelRun,
  claimTask,
  completeTask,
  failTask,
  getRun,
  OrchestratorError,
  planRun,
  recoverExpiredLeases,
  RESEARCH_UNAVAILABLE,
  workerLastSeen,
  type Claim,
} from "@/server/orchestrator/store"
import {
  createRegistry,
  RESEARCH_WORKFLOW,
  type HandlerOutcome,
} from "@/server/orchestrator/workflows"
import { Worker } from "@/server/orchestrator/worker"
import { readScoutConfig } from "@/server/scout/config"
import { createScoutHandler } from "@/server/scout/handler"
import { testNetwork } from "@/server/scout/net/test-network"
import { getResearchReport, listResearch } from "@/server/scout/store"
import {
  addProduct,
  changeStatus,
  createTicket,
  updateProduct,
} from "@/server/tickets/repository"

import { createScratchDatabase, type ScratchDatabase } from "./helpers"

/**
 * DV-005A on real PostgreSQL (scratch databases only): the research-only
 * workflow, Scout's reports written atomically under the lease and fence,
 * immutability, stale-worker fencing, crash rollback, needs-input and
 * product isolation, report versions, ownership and cancellation. Sources
 * are local fixture sites behind the injected test network.
 */

let scratch: ScratchDatabase
let pool: pg.Pool
let sites: FixtureSites
const STAGES = ["scout.research"]

beforeAll(async () => {
  scratch = await createScratchDatabase("scout")
  pool = createPool(scratch.config, { max: 10 })
  await runMigrations(pool, journal, migrationsFolder())
  sites = await startFixtureSites({
    delays: { "slow.example": 4_000 },
    hang: ["hang.example"],
  })
})
afterAll(async () => {
  await pool?.end()
  await sites?.close()
  await scratch?.drop()
})

const scoutConfig = () =>
  readScoutConfig({
    DESKVERSE_SCOUT_RETRIEVAL: "on",
    DESKVERSE_SCOUT_HOST_INTERVAL_MS: "0",
    DESKVERSE_SCOUT_REQUEST_TIMEOUT_MS: "3000",
  })
const handler = () =>
  createScoutHandler({
    config: scoutConfig(),
    network: testNetwork({ port: sites.port }),
  })

type Product = {
  name: string
  affiliateUrl: string
  specifications?: string
  description?: string
  references: readonly { kind: string; url: string; label: string }[]
}

async function readyTicket(products: Product[]) {
  const db = createDatabase(pool)
  const input = validateNewTicket({
    title: `Research ${randomUUID().slice(0, 6)}`,
    requestId: randomUUID(),
  })
  if (!input.ok) throw new Error("bad ticket")
  const ticket = (await createTicket(db, input.value)).ticket
  const ids: string[] = []
  for (const p of products) {
    const { productId } = await addProduct(db, ticket.id, randomUUID(), {
      name: p.name,
      affiliateUrl: p.affiliateUrl,
      specifications: p.specifications ?? "",
      description: p.description ?? "",
      references: p.references.map((r) => ({
        kind: r.kind as "listing",
        url: r.url,
        label: r.label,
      })),
    })
    ids.push(productId)
  }
  const version = (
    await pool.query("SELECT version FROM affiliate_tickets WHERE id = $1", [
      ticket.id,
    ])
  ).rows[0].version
  const ready = await changeStatus(db, ticket.id, version, "ready")
  return { ticketId: ticket.id, version: ready.version, productIds: ids, db }
}

const plan = (
  ticketId: string,
  version: number,
  extra: Record<string, unknown> = {},
) =>
  planRun(pool, {
    ticketId,
    ticketVersion: version,
    requestId: randomUUID(),
    mode: "production",
    workflow: RESEARCH_WORKFLOW.id,
    productionAvailable: false,
    verificationAllowed: false,
    availableWorkflows: [RESEARCH_WORKFLOW.id],
    ...extra,
  })

async function settle(runId: string, timeoutMs = 60_000) {
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
    await sleep(50)
  }
}

function startWorker() {
  return new Worker({
    pool,
    registry: createRegistry({ verification: false, production: [handler()] }),
    leaseMs: 3_000,
    pollMs: 50,
    log: () => {},
  }).start()
}

/** Runs the Scout handler for a claim exactly like the worker does, returning its outcome. */
async function runHandler(claim: Claim): Promise<HandlerOutcome> {
  return handler().run({
    taskId: claim.taskId,
    runId: claim.runId,
    stage: claim.stage,
    attempt: claim.attempt,
    maxAttempts: claim.maxAttempts,
    idempotencyKey: claim.idempotencyKey,
    snapshot: claim.snapshot,
    params: claim.params,
    signal: new AbortController().signal,
  })
}

const count = async (table: string) =>
  Number(
    (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
  )

describe("research-only workflow", () => {
  it("plans one Scout task per product and nothing else", async () => {
    const t = await readyTicket([FIXTURE_PRODUCTS.kettle, FIXTURE_PRODUCTS.fan])
    const { runId } = await plan(t.ticketId, t.version)
    const tasks = (
      await pool.query(
        "SELECT stage, status, params, resource_class, recovery_policy FROM worker_tasks WHERE run_id = $1",
        [runId],
      )
    ).rows
    expect(tasks).toHaveLength(2)
    expect(
      tasks.every((x) => x.stage === "scout.research" && x.status === "queued"),
    ).toBe(true)
    expect(tasks[0]).toMatchObject({
      params: {},
      resource_class: "general",
      recovery_policy: "retry",
    })
    const run = (
      await pool.query(
        "SELECT mode, workflow FROM campaign_runs WHERE id = $1",
        [runId],
      )
    ).rows[0]
    expect(run).toEqual({ mode: "production", workflow: "scout-research-v1" })
    await cancelRun(pool, t.ticketId, runId, randomUUID())
  })

  it("keeps the full campaign disabled and validates the workflow choice", async () => {
    const t = await readyTicket([FIXTURE_PRODUCTS.kettle])
    const refuse = async (extra: Record<string, unknown>) => {
      try {
        await plan(t.ticketId, t.version, extra)
      } catch (e) {
        return e as OrchestratorError
      }
      throw new Error("expected a refusal")
    }
    // Full campaign: still unavailable, even with Scout available.
    const campaign = await refuse({ workflow: "campaign-v1" })
    expect(campaign).toMatchObject({
      code: "unavailable",
      message: CAMPAIGN_UNAVAILABLE,
    })
    expect(campaign.message).toMatch(
      /Quill \(DV-005B\), Pixel \(DV-005C\), and Vera \(DV-006A\)/,
    )
    expect((await refuse({ workflow: undefined })).message).toBe(
      CAMPAIGN_UNAVAILABLE,
    )
    // Research only when it's switched on here.
    expect(await refuse({ availableWorkflows: [] })).toMatchObject({
      code: "unavailable",
      message: RESEARCH_UNAVAILABLE,
    })
    // Unknown workflow, or a mode that doesn't match it.
    expect(await refuse({ workflow: "nope-v1" })).toMatchObject({
      code: "invalid",
    })
    expect(
      await refuse({ mode: "verification", verificationAllowed: true }),
    ).toMatchObject({ code: "invalid" })
    // Verification still needs the test environment.
    expect(
      await refuse({ mode: "verification", workflow: "verification-v1" }),
    ).toMatchObject({ code: "unavailable" })
    expect(
      await count("campaign_runs WHERE ticket_id = '" + t.ticketId + "'"),
    ).toBe(0)
  })

  it("refuses research when no product has a usable reference", async () => {
    const t = await readyTicket([
      FIXTURE_PRODUCTS.fan,
      {
        ...FIXTURE_PRODUCTS.kettle,
        references: [
          {
            kind: "listing",
            url: FIXTURE_PRODUCTS.kettle.affiliateUrl,
            label: "",
          },
        ],
      },
    ])
    await expect(plan(t.ticketId, t.version)).rejects.toMatchObject({
      code: "not-ready",
    })
  })

  it("keeps request idempotency, version checks and one active run per ticket", async () => {
    const t = await readyTicket([FIXTURE_PRODUCTS.kettle])
    const requestId = randomUUID()
    const a = await plan(t.ticketId, t.version, { requestId })
    const b = await plan(t.ticketId, t.version, { requestId })
    expect(b).toEqual({ runId: a.runId, created: false })
    await expect(plan(t.ticketId, t.version)).rejects.toMatchObject({
      code: "active-run",
    })
    await expect(plan(t.ticketId, t.version + 1)).rejects.toMatchObject({
      code: "stale-version",
    })
    await cancelRun(pool, t.ticketId, a.runId, randomUUID())
  })
})

describe("Scout reports", () => {
  it("researches a batch: reports for usable products, needs input for the rest", async () => {
    const t = await readyTicket([
      FIXTURE_PRODUCTS.kettle,
      FIXTURE_PRODUCTS.buds,
      FIXTURE_PRODUCTS.lamp,
      FIXTURE_PRODUCTS.fan,
    ])
    const { runId } = await plan(t.ticketId, t.version)
    const worker = startWorker()
    expect(await settle(runId)).toBe("completed_with_errors")
    await worker.stop()
    const detail = (await getRun(pool, t.ticketId, runId))!
    expect(detail.products.map((p) => p.tasks[0].status)).toEqual([
      "completed",
      "completed",
      "needs_input",
      "needs_input",
    ])
    expect(detail.products[0].tasks[0].hasResult).toBe(true)

    const overview = await listResearch(pool, t.ticketId)
    expect(overview.reports).toHaveLength(2)
    const lamp = overview.latestRun!.tasks[2]
    expect(lamp.sourceProblems.map((p) => p.outcome).sort()).toEqual(
      [
        "captcha",
        "forbidden",
        "javascript_required",
        "login_required",
        "robots_disallowed",
      ].sort(),
    )
    expect(overview.latestRun!.tasks[3].failureMessage).toMatch(
      /No research references/,
    )

    const kettle = (await getResearchReport(
      pool,
      t.ticketId,
      runId,
      detail.products[0].snapshotId,
    ))!
    expect(kettle.integrity).toBe("verified")
    expect(kettle).toMatchObject({
      reportVersion: 1,
      schemaVersion: 1,
      status: "complete",
      productName: FIXTURE_PRODUCTS.kettle.name,
    })
    expect(
      kettle.claims.find((c) => c.statement === "Capacity: 1.7 L")?.status,
    ).toBe("supported")
    expect(kettle.sources.map((s) => [s.key, s.outcome, s.trust])).toEqual([
      ["S1", "ok", "manufacturer"],
      ["S2", "ok", "seller_listing"],
    ])
    expect(kettle.sources[0].contentSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(kettle.snapshotChecksum).toBe(detail.products[0].checksum)
    const buds = (await getResearchReport(
      pool,
      t.ticketId,
      runId,
      detail.products[1].snapshotId,
    ))!
    expect(buds.brief.conflicts.length).toBeGreaterThan(0)

    // task_results holds a compact typed reference, not the report.
    const result = (
      await pool.query(
        "SELECT kind, payload FROM task_results WHERE task_id = $1",
        [detail.products[0].tasks[0].id],
      )
    ).rows[0]
    expect(result.kind).toBe("scout_research")
    expect(result.payload).toMatchObject({
      kind: "scout_research",
      reportId: kettle.id,
      reportVersion: 1,
      checksum: kettle.checksum,
    })
    expect(JSON.stringify(result.payload).length).toBeLessThan(1_000)

    // Evidence pages are bounded and consistent.
    const page = (await getResearchReport(
      pool,
      t.ticketId,
      runId,
      detail.products[0].snapshotId,
      { offset: 1, limit: 2 },
    ))!
    expect(page.evidence.items.map((e) => e.key)).toEqual(
      kettle.evidence.items.slice(1, 3).map((e) => e.key),
    )
    expect(page.evidence.total).toBe(kettle.evidence.total)

    // Owner-input tables untouched by Scout: the snapshot still matches.
    const product = (
      await pool.query(
        "SELECT specifications FROM ticket_products WHERE id = $1",
        [t.productIds[0]],
      )
    ).rows[0]
    expect(product.specifications).toBe(FIXTURE_PRODUCTS.kettle.specifications)
  })

  it("makes research rows immutable and refuses rows from anyone but the lease holder", async () => {
    for (const [table, column] of [
      ["scout_reports", "status"],
      ["scout_sources", "detail"],
      ["scout_evidence", "passage"],
      ["scout_claims", "status"],
      ["scout_claim_evidence", "relationship"],
    ]) {
      await expect(
        pool.query(`UPDATE ${table} SET ${column} = ${column}`),
      ).rejects.toThrow(/immutable/)
      await expect(pool.query(`DELETE FROM ${table}`)).rejects.toThrow(
        /immutable/,
      )
    }
    const r = (await pool.query("SELECT * FROM scout_reports LIMIT 1")).rows[0]
    // A second report for a completed task, or one with a forged fence: refused.
    await expect(
      pool.query(
        `INSERT INTO scout_reports (run_id, ticket_id, task_id, snapshot_id, product_id, report_version, schema_version, status, extraction_mode, fence, snapshot_checksum, checksum, brief)
         VALUES ($1, $2, $3, $4, $5, 99, 1, 'complete', 'deterministic', $6, $7, $8, '{}')`,
        [
          r.run_id,
          r.ticket_id,
          r.task_id,
          r.snapshot_id,
          r.product_id,
          r.fence,
          r.snapshot_checksum,
          "0".repeat(64),
        ],
      ),
    ).rejects.toThrow(
      /scout_reports_task_id_unique|not the current lease holder/,
    )
    // Appending evidence to a finished report: refused.
    const source = (
      await pool.query(
        "SELECT id FROM scout_sources WHERE report_id = $1 LIMIT 1",
        [r.id],
      )
    ).rows[0]
    await expect(
      pool.query(
        "INSERT INTO scout_evidence (report_id, source_id, key, method, location, passage, statement) VALUES ($1, $2, 'E999', 'html-text', 'x', 'forged', 'forged')",
        [r.id, source.id],
      ),
    ).rejects.toThrow(/already complete/)
  })

  it("can't link a claim to another report's evidence", async () => {
    const reports = (
      await pool.query(
        "SELECT id FROM scout_reports ORDER BY created_at LIMIT 2",
      )
    ).rows
    const claim = (
      await pool.query(
        "SELECT id FROM scout_claims WHERE report_id = $1 LIMIT 1",
        [reports[0].id],
      )
    ).rows[0]
    const foreign = (
      await pool.query(
        "SELECT id FROM scout_evidence WHERE report_id = $1 LIMIT 1",
        [reports[1].id],
      )
    ).rows[0]
    await expect(
      pool.query(
        "INSERT INTO scout_claim_evidence (report_id, claim_id, evidence_id, relationship) VALUES ($1, $2, $3, 'supports')",
        [reports[0].id, claim.id, foreign.id],
      ),
    ).rejects.toThrow()
  })

  it("only returns a report through its own ticket, run and snapshot", async () => {
    const r = (
      await pool.query(
        "SELECT ticket_id, run_id, snapshot_id FROM scout_reports LIMIT 1",
      )
    ).rows[0]
    const other = (
      await pool.query(
        "SELECT id FROM affiliate_tickets WHERE id <> $1 LIMIT 1",
        [r.ticket_id],
      )
    ).rows[0]
    expect(
      await getResearchReport(pool, r.ticket_id, r.run_id, r.snapshot_id),
    ).not.toBeNull()
    expect(
      await getResearchReport(pool, other.id, r.run_id, r.snapshot_id),
    ).toBeNull()
    expect(
      await getResearchReport(pool, r.ticket_id, randomUUID(), r.snapshot_id),
    ).toBeNull()
    expect(
      await getResearchReport(pool, r.ticket_id, r.run_id, randomUUID()),
    ).toBeNull()
  })
})

describe("fencing, crashes and retries", () => {
  it("a worker that lost its lease can't publish; the new holder publishes exactly once", async () => {
    const t = await readyTicket([FIXTURE_PRODUCTS.kettle])
    const { runId } = await plan(t.ticketId, t.version)
    const stale = (await claimTask(pool, {
      workerId: "worker-stale",
      stages: STAGES,
      leaseMs: 60_000,
    }))!
    const staleOutcome = await runHandler(stale)
    expect(staleOutcome.status).toBe("completed")
    // The lease runs out (e.g. the worker hung) and is recovered; someone else claims.
    await pool.query(
      "UPDATE worker_tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [stale.taskId],
    )
    expect(
      await recoverExpiredLeases(pool, {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
      }),
    ).toBe(1)
    await pool.query(
      "UPDATE worker_tasks SET eligible_at = now() WHERE id = $1",
      [stale.taskId],
    )
    const fresh = (await claimTask(pool, {
      workerId: "worker-fresh",
      stages: STAGES,
      leaseMs: 60_000,
    }))!
    expect(fresh.fence).toBe(stale.fence + 1)
    const freshOutcome = await runHandler(fresh)
    if (
      staleOutcome.status !== "completed" ||
      freshOutcome.status !== "completed"
    )
      throw new Error("expected completions")
    // The stale worker tries to commit its (complete, valid) report: refused, nothing written.
    expect(
      await completeTask(
        pool,
        stale,
        staleOutcome.result,
        staleOutcome.deliverable,
      ),
    ).toBe("stale")
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM scout_reports WHERE task_id = $1",
            [stale.taskId],
          )
        ).rows[0].count,
      ),
    ).toBe(0)
    // Two concurrent commits by the real holder: one wins, the other is refused.
    const results = await Promise.all([
      completeTask(pool, fresh, freshOutcome.result, freshOutcome.deliverable),
      completeTask(pool, fresh, freshOutcome.result, freshOutcome.deliverable),
    ])
    expect(results.sort()).toEqual(["committed", "stale"])
    const reports = (
      await pool.query(
        "SELECT fence::int AS fence FROM scout_reports WHERE task_id = $1",
        [fresh.taskId],
      )
    ).rows
    expect(reports).toEqual([{ fence: fresh.fence }])
    expect(await settle(runId)).toBe("completed")
    // A completed research task is never claimed again.
    expect(
      await claimTask(pool, { workerId: "w", stages: STAGES, leaseMs: 1_000 }),
    ).toBeNull()
  })

  it("a failure while writing the report rolls everything back", async () => {
    const t = await readyTicket([FIXTURE_PRODUCTS.kettle])
    const { runId } = await plan(t.ticketId, t.version)
    const claim = (await claimTask(pool, {
      workerId: "worker-crash",
      stages: STAGES,
      leaseMs: 60_000,
    }))!
    const outcome = await runHandler(claim)
    if (outcome.status !== "completed" || !outcome.deliverable)
      throw new Error("expected a deliverable")
    const before = await count("scout_evidence")
    const crashing = {
      kind: outcome.deliverable.kind,
      persist: async (
        c: pg.PoolClient,
        commit: Parameters<typeof outcome.deliverable.persist>[1],
      ) => {
        await outcome.deliverable!.persist(c, commit)
        throw new Error(
          "power cut between writing the report and completing the task",
        )
      },
    }
    await expect(
      completeTask(pool, claim, outcome.result, crashing),
    ).rejects.toThrow(/power cut/)
    expect(await count("scout_evidence")).toBe(before)
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM scout_reports WHERE task_id = $1",
            [claim.taskId],
          )
        ).rows[0].count,
      ),
    ).toBe(0)
    expect(
      (
        await pool.query("SELECT status FROM worker_tasks WHERE id = $1", [
          claim.taskId,
        ])
      ).rows[0].status,
    ).toBe("running")
    // The same holder can then commit normally, once.
    expect(
      await completeTask(pool, claim, outcome.result, outcome.deliverable),
    ).toBe("committed")
    expect(await settle(runId)).toBe("completed")
  })

  it("a database refusal of the deliverable becomes a permanent failure, not an endless retry", async () => {
    const t = await readyTicket([FIXTURE_PRODUCTS.kettle])
    const { runId } = await plan(t.ticketId, t.version)
    const refusing = {
      stage: "scout.research",
      kind: "production" as const,
      run: async (): Promise<HandlerOutcome> => ({
        status: "completed",
        result: {},
        deliverable: {
          kind: "scout_research",
          persist: async (c: pg.PoolClient) => {
            await c.query("SELECT 1/0")
            return {}
          },
        },
      }),
    }
    const worker = new Worker({
      pool,
      registry: createRegistry({ verification: false, production: [refusing] }),
      leaseMs: 2_000,
      pollMs: 50,
      log: () => {},
    }).start()
    expect(await settle(runId, 20_000)).toBe("failed")
    await worker.stop()
    const task = (
      await pool.query(
        "SELECT status, failure_kind, failure_message FROM worker_tasks WHERE run_id = $1",
        [runId],
      )
    ).rows[0]
    expect(task).toMatchObject({ status: "failed", failure_kind: "permanent" })
    expect(task.failure_message).toMatch(/refused by a database check/)
  })

  it("honours a source's Retry-After when scheduling the retry", async () => {
    const t = await readyTicket([
      {
        ...FIXTURE_PRODUCTS.kettle,
        references: [
          { kind: "listing", url: "https://ratelimit.example/page", label: "" },
        ],
      },
    ])
    const { runId } = await plan(t.ticketId, t.version)
    const claim = (await claimTask(pool, {
      workerId: "w-retry",
      stages: STAGES,
      leaseMs: 60_000,
    }))!
    const outcome = await runHandler(claim)
    expect(outcome).toMatchObject({
      status: "transient",
      retryAfterMs: 120_000,
    })
    if (outcome.status !== "transient") return
    await failTask(pool, claim, {
      kind: "transient",
      message: outcome.message,
      retryAfterMs: outcome.retryAfterMs,
      details: outcome.details,
    })
    const task = (
      await pool.query(
        "SELECT status, extract(epoch FROM eligible_at - now()) AS wait FROM worker_tasks WHERE id = $1",
        [claim.taskId],
      )
    ).rows[0]
    expect(task.status).toBe("retry_wait")
    expect(Number(task.wait)).toBeGreaterThan(110)
    const event = (
      await pool.query(
        "SELECT details FROM run_events WHERE task_id = $1 AND type = 'task_retry_scheduled'",
        [claim.taskId],
      )
    ).rows[0]
    expect(event.details.sources).toEqual([
      { host: "ratelimit.example", outcome: "rate_limited" },
    ])
    await cancelRun(pool, t.ticketId, runId, randomUUID())
  })

  it("cancels research in progress without writing a report", async () => {
    const t = await readyTicket([
      {
        ...FIXTURE_PRODUCTS.kettle,
        references: [
          { kind: "listing", url: "https://hang.example/kettle", label: "" },
        ],
      },
    ])
    const { runId } = await plan(t.ticketId, t.version)
    const worker = startWorker()
    for (let i = 0; i < 200; i++) {
      if (
        (
          await pool.query(
            "SELECT 1 FROM worker_tasks WHERE run_id = $1 AND status = 'running'",
            [runId],
          )
        ).rowCount
      )
        break
      await sleep(25)
    }
    await cancelRun(pool, t.ticketId, runId, randomUUID())
    expect(await settle(runId, 20_000)).toBe("cancelled")
    await worker.stop()
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM scout_reports WHERE run_id = $1",
            [runId],
          )
        ).rows[0].count,
      ),
    ).toBe(0)
    const attempt = (
      await pool.query(
        "SELECT a.outcome FROM task_attempts a JOIN worker_tasks t ON t.id = a.task_id WHERE t.run_id = $1",
        [runId],
      )
    ).rows
    expect(attempt.map((a) => a.outcome)).toEqual(["cancelled"])
  })
})

describe("versions and new snapshots", () => {
  it("an owner edit needs a new run with a new snapshot; old reports and snapshots stay as they were", async () => {
    const t = await readyTicket([FIXTURE_PRODUCTS.buds])
    const first = await plan(t.ticketId, t.version)
    const worker = startWorker()
    expect(await settle(first.runId)).toBe("completed")
    const firstDetail = (await getRun(pool, t.ticketId, first.runId))!
    const v1 = (await getResearchReport(
      pool,
      t.ticketId,
      first.runId,
      firstDetail.products[0].snapshotId,
    ))!

    // The owner fixes the battery claim (the ticket returns to Draft), then marks it Ready again.
    await updateProduct(t.db, t.ticketId, t.productIds[0], {
      specifications: "Battery life: 24 hours",
    })
    const draft = (
      await pool.query(
        "SELECT status, version FROM affiliate_tickets WHERE id = $1",
        [t.ticketId],
      )
    ).rows[0]
    expect(draft.status).toBe("draft")
    const ready = await changeStatus(t.db, t.ticketId, draft.version, "ready")
    const second = await plan(t.ticketId, ready.version)
    expect(await settle(second.runId)).toBe("completed")
    await worker.stop()

    const secondDetail = (await getRun(pool, t.ticketId, second.runId))!
    expect(secondDetail.products[0].snapshotId).not.toBe(
      firstDetail.products[0].snapshotId,
    )
    const v2 = (await getResearchReport(
      pool,
      t.ticketId,
      second.runId,
      secondDetail.products[0].snapshotId,
    ))!
    expect([v1.reportVersion, v2.reportVersion]).toEqual([1, 2])
    // The old report is unchanged (still verified) and still says what the old snapshot said.
    const again = (await getResearchReport(
      pool,
      t.ticketId,
      first.runId,
      firstDetail.products[0].snapshotId,
    ))!
    expect(again.integrity).toBe("verified")
    expect(again.checksum).toBe(v1.checksum)
    expect(again.claims.find((c) => c.origin === "owner")?.statement).toBe(
      "Battery life: 30 hours",
    )
    expect(v2.claims.find((c) => c.origin === "owner")?.statement).toBe(
      "Battery life: 24 hours",
    )
    const snap = (
      await pool.query(
        "SELECT data->'product'->>'specifications' AS s FROM run_product_snapshots WHERE id = $1",
        [firstDetail.products[0].snapshotId],
      )
    ).rows[0]
    expect(snap.s).toBe("Battery life: 30 hours")
    const list = await listResearch(pool, t.ticketId)
    expect(list.reports.map((r) => r.reportVersion)).toEqual([2, 1])
  })

  it("records worker check-ins and removes them on a clean stop", async () => {
    const worker = startWorker()
    for (
      let i = 0;
      i < 100 && (await workerLastSeen(pool, "scout.research")) === null;
      i++
    )
      await sleep(20)
    expect(await workerLastSeen(pool, "scout.research")).not.toBeNull()
    await worker.stop()
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM orchestrator_workers WHERE worker_id = $1",
            [worker.id],
          )
        ).rows[0].count,
      ),
    ).toBe(0)
  })
})
