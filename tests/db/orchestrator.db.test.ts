import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { validateNewTicket } from "@/lib/tickets/validation"
import { journal } from "@/server/db/journal"
import { migrationsFolder, runMigrations } from "@/server/db/migrations"
import {
  createDatabase,
  createPool,
  type DeskverseDatabase,
} from "@/server/db/pool"
import {
  acknowledgeCancel,
  canonicalJson,
  cancelRun,
  claimTask,
  completeTask,
  getRun,
  OrchestratorError,
  pauseRun,
  planRun,
  recoverExpiredLeases,
  renewLease,
  resumeRun,
  retryTask,
  type Claim,
  type PlanInput,
} from "@/server/orchestrator/store"
import {
  createRegistry,
  VERIFICATION_WORKFLOW,
} from "@/server/orchestrator/workflows"
import { Worker } from "@/server/orchestrator/worker"
import {
  addProduct,
  changeStatus,
  createTicket,
  recordAsset,
  removeAssetRecord,
  removeProduct,
  TicketError,
  updateProduct,
  updateTicket,
} from "@/server/tickets/repository"

import { createScratchDatabase, type ScratchDatabase } from "./helpers"

/** DV-004C: the orchestrator on a guarded scratch database (in-process workers). */

let scratch: ScratchDatabase
let pool: ReturnType<typeof createPool>
let db: DeskverseDatabase
const STAGES = VERIFICATION_WORKFLOW.stages.map((s) => s.stage)
const FAST = { maxAttempts: 3, baseDelayMs: 20, maxDelayMs: 100 }

beforeAll(async () => {
  scratch = await createScratchDatabase("orch")
  pool = createPool(scratch.config, { max: 20 })
  await runMigrations(pool, journal, migrationsFolder())
  db = createDatabase(pool)
})
afterAll(async () => {
  await pool?.end()
  await scratch?.drop()
})

/** A Ready ticket with `n` complete products (each with one image record). */
async function readyTicket(n: number, title = "Orchestrated ticket") {
  const input = validateNewTicket({ title, requestId: randomUUID() })
  if (!input.ok) throw new Error("bad")
  let ticket = (await createTicket(db, input.value)).ticket
  for (let i = 0; i < n; i++) {
    const added = await addProduct(db, ticket.id, randomUUID(), {
      name: `Product ${i + 1}`,
      affiliateUrl: `https://shop.example.com/p${i + 1}`,
      references: [
        {
          kind: "review",
          url: `https://reviews.example.org/p${i + 1}`,
          label: "",
        },
      ],
    })
    await recordAsset(
      db,
      ticket.id,
      added.productId,
      {
        id: randomUUID(),
        kind: "image",
        mimeType: "image/png",
        extension: "png",
        byteSize: 100,
        sha256: "a".repeat(64),
        width: 800,
        height: 800,
        durationMs: null,
        originalName: "x.png",
      },
      { imagesPerProduct: 20, videosPerProduct: 5, maxTicketBytes: 1e9 },
    )
  }
  const current = (
    await pool.query("SELECT version FROM affiliate_tickets WHERE id = $1", [
      ticket.id,
    ])
  ).rows[0].version
  ticket = await changeStatus(db, ticket.id, current, "ready")
  return ticket
}

function plan(
  ticket: { id: string; version: number },
  extra: Partial<PlanInput> = {},
) {
  return planRun(pool, {
    ticketId: ticket.id,
    ticketVersion: ticket.version,
    requestId: randomUUID(),
    mode: "verification",
    productionAvailable: false,
    verificationAllowed: true,
    verification: { durationMs: 20 },
    retry: FAST,
    ...extra,
  })
}

const claim = (
  workerId = "w-test",
  leaseMs = 30_000,
  stages: readonly string[] = STAGES,
) => claimTask(pool, { workerId, stages, leaseMs })

async function code(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  return (error as OrchestratorError | TicketError | null)?.code ?? null
}

async function runStatus(runId: string) {
  return (
    await pool.query("SELECT status FROM campaign_runs WHERE id = $1", [runId])
  ).rows[0].status
}

async function untilSettled(runId: string, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const status = await runStatus(runId)
    if (
      [
        "completed",
        "completed_with_errors",
        "failed",
        "cancelled",
        "paused",
      ].includes(status)
    )
      return status
    if (Date.now() > end) throw new Error(`run still ${status}`)
    await sleep(50)
  }
}

function workers(n: number, leaseMs = 2_000, shutdownGraceMs = 5_000) {
  return Array.from({ length: n }, () =>
    new Worker({
      pool,
      registry: createRegistry({ verification: true }),
      slots: 3,
      leaseMs,
      pollMs: 25,
      shutdownGraceMs,
      retry: FAST,
      log: () => {},
    }).start(),
  )
}

describe("planning runs", () => {
  it("creates run, frozen snapshots and the task graph atomically", async () => {
    const ticket = await readyTicket(10)
    const { runId, created } = await plan(ticket)
    expect(created).toBe(true)
    const detail = (await getRun(pool, ticket.id, runId))!
    expect(detail.run).toMatchObject({
      status: "queued",
      mode: "verification",
      ticketVersion: ticket.version,
    })
    expect(detail.products).toHaveLength(10)
    const tasks = detail.products.flatMap((p) => p.tasks)
    expect(tasks).toHaveLength(40)
    expect(
      tasks.filter((t) => t.status === "queued").map((t) => t.stage),
    ).toEqual(Array(10).fill("verify.collect"))
    const deps = await pool.query(
      "SELECT count(*)::int AS n FROM task_dependencies WHERE run_id = $1",
      [runId],
    )
    expect(deps.rows[0].n).toBe(30)
    const snap = (
      await pool.query(
        "SELECT data, checksum FROM run_product_snapshots WHERE run_id = $1 ORDER BY position LIMIT 1",
        [runId],
      )
    ).rows[0]
    expect(snap.data.product).toMatchObject({
      name: "Product 1",
      affiliateUrl: "https://shop.example.com/p1",
    })
    expect(snap.data.product.assets[0]).toMatchObject({
      sha256: "a".repeat(64),
      byteSize: 100,
    })
    expect(snap.checksum).toBe(
      (await import("node:crypto"))
        .createHash("sha256")
        .update(canonicalJson(snap.data))
        .digest("hex"),
    )
    await cancelRun(pool, ticket.id, runId, randomUUID())
  })

  it("is idempotent, and allows only one unfinished run per ticket under concurrency", async () => {
    const ticket = await readyTicket(2)
    const requestId = randomUUID()
    const first = await plan(ticket, { requestId })
    expect(await plan(ticket, { requestId })).toEqual({
      runId: first.runId,
      created: false,
    })
    const second = await readyTicket(2, "Race ticket")
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => plan(second)),
    )
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    for (const r of results.filter((r) => r.status === "rejected"))
      expect(["active-run"]).toContain(
        ((r as PromiseRejectedResult).reason as OrchestratorError).code ??
          "unique",
      )
    const runs = await pool.query(
      "SELECT count(*)::int AS n FROM campaign_runs WHERE ticket_id = $1",
      [second.id],
    )
    expect(runs.rows[0].n).toBe(1)
    for (const t of [ticket, second]) {
      const id = (
        await pool.query("SELECT id FROM campaign_runs WHERE ticket_id = $1", [
          t.id,
        ])
      ).rows[0].id
      await cancelRun(pool, t.id, id, randomUUID())
    }
  })

  it("refuses stale versions, non-Ready tickets, production mode and unguarded verification", async () => {
    const ticket = await readyTicket(1)
    expect(
      await code(plan({ id: ticket.id, version: ticket.version - 1 })),
    ).toBe("stale-version")
    expect(await code(plan(ticket, { mode: "production" }))).toBe("unavailable")
    expect(await code(plan(ticket, { verificationAllowed: false }))).toBe(
      "unavailable",
    )
    const draft = await changeStatus(db, ticket.id, ticket.version, "draft")
    expect(await code(plan(draft))).toBe("not-ready")
    expect(
      await pool
        .query("SELECT 1 FROM campaign_runs WHERE ticket_id = $1", [ticket.id])
        .then((r) => r.rowCount),
    ).toBe(0)
  })

  it("leaves nothing behind when planning fails midway", async () => {
    const ticket = await readyTicket(3)
    // Make the very last task insert of this plan fail, after the run,
    // snapshots and most tasks were already inserted in the transaction.
    await pool.query(`CREATE FUNCTION test_fail_plan() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.stage = 'verify.confirm' AND (SELECT count(*) FROM worker_tasks WHERE run_id = NEW.run_id) = 11
      THEN RAISE EXCEPTION 'simulated failure while planning'; END IF; RETURN NEW; END $$`)
    await pool.query(
      "CREATE TRIGGER test_fail_plan BEFORE INSERT ON worker_tasks FOR EACH ROW EXECUTE FUNCTION test_fail_plan()",
    )
    try {
      await expect(plan(ticket)).rejects.toThrow(
        "simulated failure while planning",
      )
    } finally {
      await pool.query("DROP TRIGGER test_fail_plan ON worker_tasks")
      await pool.query("DROP FUNCTION test_fail_plan()")
    }
    for (const table of [
      "campaign_runs",
      "run_product_snapshots",
      "worker_tasks",
    ])
      expect(
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM ${table} WHERE ticket_id = $1`,
            [ticket.id],
          )
        ).rows[0].n,
      ).toBe(0)
    // And the same ticket can be planned afterwards.
    const { runId } = await plan(ticket)
    await cancelRun(pool, ticket.id, runId, randomUUID())
  })
})

describe("frozen inputs and media retention", () => {
  it("keeps snapshots immutable while owner data changes, and protects active inputs", async () => {
    const ticket = await readyTicket(2)
    const { runId } = await plan(ticket)
    const before = (
      await pool.query(
        "SELECT data, checksum FROM run_product_snapshots WHERE run_id = $1 ORDER BY position",
        [runId],
      )
    ).rows
    const products = (
      await pool.query(
        "SELECT id FROM ticket_products WHERE ticket_id = $1 ORDER BY position",
        [ticket.id],
      )
    ).rows
    const asset = (
      await pool.query("SELECT id FROM ticket_assets WHERE product_id = $1", [
        products[0].id,
      ])
    ).rows[0]

    // Editing the ticket is allowed (it returns to Draft); the snapshot doesn't change.
    await updateProduct(db, ticket.id, products[0].id, {
      name: "Renamed after the run started",
    })
    const v = (
      await pool.query("SELECT version FROM affiliate_tickets WHERE id = $1", [
        ticket.id,
      ])
    ).rows[0].version
    await updateTicket(db, ticket.id, v, {
      title: "Retitled after the run started",
    })
    const after = (
      await pool.query(
        "SELECT data, checksum FROM run_product_snapshots WHERE run_id = $1 ORDER BY position",
        [runId],
      )
    ).rows
    expect(after).toEqual(before)
    expect(before[0].data.product.name).toBe("Product 1")

    // The database refuses to change or delete a snapshot.
    expect(
      (
        await pool
          .query(
            "UPDATE run_product_snapshots SET checksum = $1 WHERE run_id = $2",
            ["b".repeat(64), runId],
          )
          .catch((e) => e)
      ).code,
    ).toBe("23000")
    expect(
      (
        await pool
          .query("DELETE FROM run_product_snapshots WHERE run_id = $1", [runId])
          .catch((e) => e)
      ).code,
    ).toBe("23000")

    // Inputs of an unfinished run can't be removed, nor the ticket archived.
    expect(
      await code(removeAssetRecord(db, ticket.id, products[0].id, asset.id)),
    ).toBe("in-use")
    expect(await code(removeProduct(db, ticket.id, products[1].id))).toBe(
      "in-use",
    )
    const v2 = (
      await pool.query("SELECT version FROM affiliate_tickets WHERE id = $1", [
        ticket.id,
      ])
    ).rows[0].version
    expect(await code(changeStatus(db, ticket.id, v2, "archived"))).toBe(
      "in-use",
    )
    // A product added after the run started isn't part of it, so it stays removable.
    const later = await addProduct(db, ticket.id, randomUUID(), {
      name: "Added later",
    })
    await removeProduct(db, ticket.id, later.productId)

    // Once the run is finished (here: cancelled), the references are released.
    await cancelRun(pool, ticket.id, runId, randomUUID())
    await removeAssetRecord(db, ticket.id, products[0].id, asset.id)
    await removeProduct(db, ticket.id, products[1].id)
    // The finished run still has its frozen metadata.
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM run_product_snapshots WHERE run_id = $1",
          [runId],
        )
      ).rows[0].n,
    ).toBe(2)
  })
})

describe("claims, leases and fencing", () => {
  it("never hands the same task to two competing claimers, and respects capacity", async () => {
    const ticket = await readyTicket(10)
    const { runId } = await plan(ticket)
    const claims = (
      await Promise.all(Array.from({ length: 20 }, (_, i) => claim(`w${i}`)))
    ).filter(Boolean) as Claim[]
    expect(claims).toHaveLength(3) // general capacity
    expect(new Set(claims.map((c) => c.taskId)).size).toBe(3)
    expect(new Set(claims.map((c) => c.snapshot!.checksum)).size).toBe(3) // three different products
    await cancelRun(pool, ticket.id, runId, randomUUID())
    // As a worker does on its next heartbeat: acknowledge the cancellation.
    for (const c of claims)
      expect(await acknowledgeCancel(pool, c)).toBe("cancelled")
    expect(await runStatus(runId)).toBe("cancelled")
  })

  it("commits a result exactly once; a stale worker can't overwrite a newer attempt", async () => {
    const ticket = await readyTicket(1)
    const { runId } = await plan(ticket)
    const a = (await claim("worker-a", 600))!
    await sleep(700) // A's lease expires (A is "hung")
    expect(await renewLease(pool, a)).toBeNull()
    expect(await recoverExpiredLeases(pool, FAST)).toBeGreaterThanOrEqual(1)
    await sleep(60) // backoff
    const b = (await claim("worker-b"))!
    expect(b.taskId).toBe(a.taskId)
    expect(b.fence).toBe(a.fence + 1)
    expect(await completeTask(pool, a, { late: true })).toBe("stale")
    expect(await completeTask(pool, b, { ok: true })).toBe("committed")
    expect(await completeTask(pool, b, { again: true })).toBe("stale")
    const results = await pool.query(
      "SELECT payload, fence FROM task_results WHERE task_id = $1",
      [a.taskId],
    )
    expect(results.rows.map((r) => ({ ...r, fence: Number(r.fence) }))).toEqual(
      [{ payload: { ok: true }, fence: b.fence }],
    )
    const attempts = (
      await pool.query(
        "SELECT outcome FROM task_attempts WHERE task_id = $1 ORDER BY attempt_number",
        [a.taskId],
      )
    ).rows.map((r) => r.outcome)
    expect(attempts).toEqual(["lease_expired", "succeeded"])
    expect(
      (
        await pool
          .query("UPDATE task_results SET fence = 0 WHERE task_id = $1", [
            a.taskId,
          ])
          .catch((e) => e)
      ).code,
    ).toBe("23000")
    await cancelRun(pool, ticket.id, runId, randomUUID())
  })

  it("refuses dependency cycles and cross-run edges in the database", async () => {
    const ticket = await readyTicket(1)
    const { runId } = await plan(ticket)
    const tasks = (
      await pool.query(
        "SELECT id, stage FROM worker_tasks WHERE run_id = $1 ORDER BY created_at",
        [runId],
      )
    ).rows
    const cycle = await pool
      .query(
        "INSERT INTO task_dependencies (run_id, task_id, depends_on_task_id) VALUES ($1, $2, $3)",
        [runId, tasks[0].id, tasks[3].id],
      )
      .catch((e) => e)
    expect(cycle.message).toMatch(/cycle/)
    const other = await readyTicket(1, "Other run")
    const otherRun = await plan(other)
    const otherTask = (
      await pool.query(
        "SELECT id FROM worker_tasks WHERE run_id = $1 LIMIT 1",
        [otherRun.runId],
      )
    ).rows[0]
    const cross = await pool
      .query(
        "INSERT INTO task_dependencies (run_id, task_id, depends_on_task_id) VALUES ($1, $2, $3)",
        [runId, tasks[1].id, otherTask.id],
      )
      .catch((e) => e)
    expect(cross.code).toBe("23503")
    await cancelRun(pool, ticket.id, runId, randomUUID())
    await cancelRun(pool, other.id, otherRun.runId, randomUUID())
  })
})

describe("execution with in-process workers", () => {
  it("runs ten products to completion with dependencies, limits and no duplicates", async () => {
    const ticket = await readyTicket(10)
    const { runId } = await plan(ticket, { verification: { durationMs: 40 } })
    const ws = workers(3)
    try {
      expect(await untilSettled(runId)).toBe("completed")
    } finally {
      await Promise.all(ws.map((w) => w.stop()))
    }
    const results = await pool.query(
      "SELECT count(*)::int AS n, count(DISTINCT payload->>'digest')::int AS d FROM task_results WHERE run_id = $1",
      [runId],
    )
    expect(results.rows[0]).toEqual({ n: 40, d: 40 })
    expect(results.rows[0].n).toBe(40)
    // Each prerequisite succeeded before its dependent started.
    const order = await pool.query(
      `SELECT count(*)::int AS n FROM task_dependencies d
         JOIN task_attempts dep ON dep.task_id = d.depends_on_task_id AND dep.outcome = 'succeeded'
         JOIN task_attempts t ON t.task_id = d.task_id
        WHERE d.run_id = $1 AND t.started_at < dep.finished_at`,
      [runId],
    )
    expect(order.rows[0].n).toBe(0)
    // Concurrency per class never exceeded its limit; render never overlapped.
    const max = await maxOverlap(runId)
    expect(max.render).toBe(1)
    expect(max.general).toBeLessThanOrEqual(3)
    expect(max.cpu).toBeLessThanOrEqual(2)
    // Several workers took part.
    const ids = await pool.query(
      "SELECT count(DISTINCT a.worker_id)::int AS n FROM task_attempts a JOIN worker_tasks t ON t.id = a.task_id WHERE t.run_id = $1",
      [runId],
    )
    expect(ids.rows[0].n).toBeGreaterThan(1)
  })

  it("blocks only the failing product's later steps, retries transient faults finitely", async () => {
    const ticket = await readyTicket(4)
    const { runId } = await plan(ticket, {
      verification: {
        durationMs: 10,
        faults: [
          { product: 0, stage: "verify.compute", kind: "permanent" },
          { product: 1, stage: "verify.collect", kind: "transient", times: 2 },
          { product: 2, stage: "verify.collect", kind: "transient", times: 9 },
          { product: 3, stage: "verify.exclusive", kind: "needs_input" },
        ],
      },
    })
    const ws = workers(2)
    try {
      expect(await untilSettled(runId)).toBe("completed_with_errors")
    } finally {
      await Promise.all(ws.map((w) => w.stop()))
    }
    const detail = (await getRun(pool, ticket.id, runId))!
    const states = detail.products.map((p) => p.tasks.map((t) => t.status))
    expect(states).toEqual([
      ["completed", "failed", "blocked", "blocked"],
      ["completed", "completed", "completed", "completed"],
      ["failed", "blocked", "blocked", "blocked"],
      ["completed", "completed", "needs_input", "blocked"],
    ])
    expect(detail.products[1].tasks[0].attempts).toBe(3)
    expect(detail.products[2].tasks[0]).toMatchObject({
      failureKind: "exhausted",
      attempts: 3,
    })
    expect(detail.products[2].tasks[0].failureMessage).toMatch(
      /^Gave up after 3 attempts/,
    )
    expect(detail.run.error).toBe("9 of 16 tasks didn't complete.")

    // Manual retry of the needs-input step unblocks its descendant; the fault persists, so it needs input again.
    await retryTask(
      pool,
      ticket.id,
      runId,
      detail.products[3].tasks[2].id,
      randomUUID(),
    )
    expect(await runStatus(runId)).toBe("running")
    const after = (await getRun(pool, ticket.id, runId))!.products[3].tasks.map(
      (t) => t.status,
    )
    expect(after).toEqual([
      "completed",
      "completed",
      "queued",
      "waiting_dependencies",
    ])
    expect(
      await code(
        retryTask(
          pool,
          ticket.id,
          runId,
          detail.products[1].tasks[0].id,
          randomUUID(),
        ),
      ),
    ).toBe("invalid-transition")
    await cancelRun(pool, ticket.id, runId, randomUUID())
  })

  it("pauses (letting running work settle) and resumes; cancels without late commits", async () => {
    const ticket = await readyTicket(3)
    const { runId } = await plan(ticket)
    const running = (await claim("w-pause"))!
    await pauseRun(pool, ticket.id, runId, randomUUID())
    expect(await runStatus(runId)).toBe("pausing")
    expect(await claim("w-other")).toBeNull()
    expect(await completeTask(pool, running, { ok: 1 })).toBe("committed") // settles
    expect(await runStatus(runId)).toBe("paused")
    expect(await claim("w-other")).toBeNull()
    const repeat = randomUUID()
    await resumeRun(pool, ticket.id, runId, repeat)
    await resumeRun(pool, ticket.id, runId, repeat) // the same request again is a no-op
    expect(await runStatus(runId)).toBe("running")

    const busy = (await claim("w-cancel"))!
    await cancelRun(pool, ticket.id, runId, randomUUID())
    expect(await runStatus(runId)).toBe("cancelling")
    expect(await claim("w-late")).toBeNull()
    expect(await completeTask(pool, busy, { late: true })).toBe("cancelled")
    expect(await runStatus(runId)).toBe("cancelled")
    const task = (
      await pool.query("SELECT status FROM worker_tasks WHERE id = $1", [
        busy.taskId,
      ])
    ).rows[0]
    expect(task.status).toBe("cancelled")
    expect(
      (
        await pool.query("SELECT 1 FROM task_results WHERE task_id = $1", [
          busy.taskId,
        ])
      ).rowCount,
    ).toBe(0)
    expect(await code(resumeRun(pool, ticket.id, runId, randomUUID()))).toBe(
      "invalid-transition",
    )
  })

  it("hands work back on graceful shutdown without counting the attempt, and a new worker finishes it", async () => {
    const ticket = await readyTicket(1)
    const { runId } = await plan(ticket, {
      verification: { durationMs: 2_000 },
    })
    const [w] = workers(1, 2_000, 50) // only 50 ms grace: the 2 s step can't finish
    await sleep(300)
    const first = (
      await pool.query(
        "SELECT id, attempts FROM worker_tasks WHERE run_id = $1 AND status = 'running'",
        [runId],
      )
    ).rows[0]
    expect(first.attempts).toBe(1)
    await w.stop()
    const released = (
      await pool.query(
        "SELECT status, attempts FROM worker_tasks WHERE id = $1",
        [first.id],
      )
    ).rows[0]
    expect(released).toEqual({ status: "queued", attempts: 0 })
    const outcomes = (
      await pool.query("SELECT outcome FROM task_attempts WHERE task_id = $1", [
        first.id,
      ])
    ).rows.map((r) => r.outcome)
    expect(outcomes).toEqual(["released"])
    await pool.query(
      `UPDATE worker_tasks SET params = '{"durationMs": 10}' WHERE run_id = $1`,
      [runId],
    )
    const ws = workers(1)
    try {
      expect(await untilSettled(runId)).toBe("completed")
    } finally {
      await Promise.all(ws.map((x) => x.stop()))
    }
    expect(
      (
        await pool.query(
          "SELECT outcome FROM task_attempts WHERE task_id = $1 ORDER BY attempt_number",
          [first.id],
        )
      ).rows.map((r) => r.outcome),
    ).toEqual(["released", "succeeded"])
  })

  it("rejects actions across tickets and runs", async () => {
    const a = await readyTicket(1, "Owner A")
    const b = await readyTicket(1, "Owner B")
    const ra = await plan(a)
    const rb = await plan(b)
    const taskB = (
      await pool.query(
        "SELECT id FROM worker_tasks WHERE run_id = $1 LIMIT 1",
        [rb.runId],
      )
    ).rows[0].id
    expect(await code(pauseRun(pool, b.id, ra.runId, randomUUID()))).toBe(
      "not-found",
    )
    expect(await code(cancelRun(pool, b.id, ra.runId, randomUUID()))).toBe(
      "not-found",
    )
    expect(
      await code(retryTask(pool, a.id, ra.runId, taskB, randomUUID())),
    ).toBe("not-found")
    expect(await getRun(pool, b.id, ra.runId)).toBeNull()
    await cancelRun(pool, a.id, ra.runId, randomUUID())
    await cancelRun(pool, b.id, rb.runId, randomUUID())
  })

  it("keeps run state across reconnecting, and fails cleanly when the database is unreachable", async () => {
    const ticket = await readyTicket(1)
    const { runId } = await plan(ticket)
    const other = createPool(scratch.config)
    try {
      expect((await getRun(other, ticket.id, runId))!.run.status).toBe("queued")
    } finally {
      await other.end()
    }
    const dead = createPool(
      { ...scratch.config, port: 1 },
      { connectionTimeoutMs: 300 },
    )
    try {
      await expect(
        claimTask(dead, { workerId: "w", stages: STAGES, leaseMs: 1000 }),
      ).rejects.toThrow()
    } finally {
      await dead.end()
    }
    await cancelRun(pool, ticket.id, runId, randomUUID())
  })
})

/** Highest number of simultaneously running attempts per resource class. */
async function maxOverlap(runId: string) {
  const rows = (
    await pool.query(
      `SELECT t.resource_class, a.started_at, coalesce(a.finished_at, now()) AS finished_at
         FROM task_attempts a JOIN worker_tasks t ON t.id = a.task_id WHERE t.run_id = $1`,
      [runId],
    )
  ).rows as { resource_class: string; started_at: Date; finished_at: Date }[]
  const result: Record<string, number> = { general: 0, cpu: 0, render: 0 }
  for (const cls of Object.keys(result)) {
    const points = rows
      .filter((r) => r.resource_class === cls)
      .flatMap((r) => [
        { t: r.started_at.getTime(), d: 1 },
        { t: r.finished_at.getTime(), d: -1 },
      ])
      .sort((x, y) => x.t - y.t || x.d - y.d)
    let current = 0
    for (const p of points)
      result[cls] = Math.max(result[cls], (current += p.d))
  }
  return result
}

export { maxOverlap }
