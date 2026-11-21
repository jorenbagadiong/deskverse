import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import pg from "pg"

import { validateNewTicket } from "@/lib/tickets/validation"
import { parseDatabaseUrl, type DatabaseConfig } from "@/server/db/config"
import { readEnvFile } from "@/server/db/env-file"
import { journal } from "@/server/db/journal"
import { migrationsFolder, runMigrations } from "@/server/db/migrations"
import { createDatabase, createPool } from "@/server/db/pool"
import {
  assertTestDatabase,
  isScratchDatabaseName,
  scratchDatabaseName,
} from "@/server/db/test-guard"
import { getRun, planRun } from "@/server/orchestrator/store"
import {
  addProduct,
  changeStatus,
  createTicket,
} from "@/server/tickets/repository"

/**
 * The DV-004C deterministic orchestration verification with real worker
 * PROCESSES and real crashes, on a guarded scratch database (never the
 * development database). Used by `yarn orchestrator:verify` and by
 * tests/db/orchestrator-crash.db.test.ts.
 *
 * 10 products × 4 verification steps, three worker processes, injected
 * faults (one permanent, one transient ×2, one needs-input), then while
 * work is in flight: SIGTERM one worker (graceful) and restart it, and
 * SIGKILL another (crash) and restart it. Every claim is then checked.
 *
 * This verifies orchestration only. No research, script, video or review
 * is produced.
 */

export interface ScenarioReport {
  database: string
  runStatus: string
  products: { position: number; states: string[] }[]
  checks: Record<string, boolean>
  evidence: Record<string, unknown>
}

const ROOT = process.cwd()

function workerProcess(
  db: DatabaseConfig,
  name: string,
  log: string[],
): ChildProcess {
  const url = `postgresql://${encodeURIComponent(db.user)}:${encodeURIComponent(db.password)}@${db.host}:${db.port}/${db.database}`
  const child: ChildProcess = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./scripts/server-only-hook.mjs",
      path.join("scripts", "worker", "start.ts"),
    ],
    {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DATABASE_URL: url,
        DATABASE_TEST_URL: "",
        DESKVERSE_ORCHESTRATOR_VERIFICATION: "1",
        DESKVERSE_WORKER_LEASE_MS: "1500",
        DESKVERSE_WORKER_POLL_MS: "50",
        DESKVERSE_ORCHESTRATOR_RETRY_BASE_MS: "100",
        DESKVERSE_ORCHESTRATOR_RETRY_MAX_MS: "500",
        // Shorter than a step, so a SIGTERM hands the running task back.
        DESKVERSE_WORKER_SHUTDOWN_GRACE_MS: "200",
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  const capture = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n"))
      if (line.trim()) log.push(`${name}: ${line}`)
  }
  child.stdout?.on("data", capture)
  child.stderr?.on("data", capture)
  return child
}

const exited = (child: ChildProcess) =>
  new Promise<number | string | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null)
      resolve(child.exitCode ?? child.signalCode)
    else child.once("exit", (code, signal) => resolve(code ?? signal))
  })

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 60_000,
): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

export async function runScenario({
  keep = false,
  log = () => {},
}: {
  keep?: boolean
  log?: (line: string) => void
} = {}): Promise<ScenarioReport> {
  const fromFile = readEnvFile()
  const parsed = parseDatabaseUrl(
    process.env.DATABASE_TEST_URL || fromFile.DATABASE_TEST_URL,
    "DATABASE_TEST_URL",
  )
  if (!parsed.ok)
    throw new Error(`${parsed.message} Run scripts/db/setup-local.sh first.`)
  const dev = parseDatabaseUrl(
    process.env.DATABASE_URL || fromFile.DATABASE_URL,
    "DATABASE_URL",
  )
  assertTestDatabase(parsed.config, dev.ok ? dev.config : null)
  const base = parsed.config
  const name = scratchDatabaseName("orchverify")
  const admin = new pg.Client({ ...base, connectionTimeoutMillis: 5_000 })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)}`)
  await admin.end()
  const config: DatabaseConfig = { ...base, database: name }
  assertTestDatabase(config, dev.ok ? dev.config : null)
  const pool = createPool(config, { max: 5 })
  const workerLog: string[] = []
  const children: ChildProcess[] = []
  try {
    await runMigrations(pool, journal, migrationsFolder())
    const db = createDatabase(pool)
    const input = validateNewTicket({
      title: "Orchestration verification (10 products)",
      requestId: randomUUID(),
    })
    if (!input.ok) throw new Error("bad ticket")
    const ticket = (await createTicket(db, input.value)).ticket
    for (let i = 0; i < 10; i++)
      await addProduct(db, ticket.id, randomUUID(), {
        name: `Verification product ${i + 1}`,
        affiliateUrl: `https://shop.example.com/v${i + 1}`,
      })
    const version = (
      await pool.query("SELECT version FROM affiliate_tickets WHERE id = $1", [
        ticket.id,
      ])
    ).rows[0].version
    const ready = await changeStatus(db, ticket.id, version, "ready")
    const { runId } = await planRun(pool, {
      ticketId: ticket.id,
      ticketVersion: ready.version,
      requestId: randomUUID(),
      mode: "verification",
      productionAvailable: false,
      verificationAllowed: true,
      verification: {
        durationMs: 600,
        faults: [
          { product: 2, stage: "verify.compute", kind: "permanent" },
          { product: 4, stage: "verify.collect", kind: "transient", times: 2 },
          { product: 6, stage: "verify.exclusive", kind: "needs_input" },
        ],
      },
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 },
    })
    log(`run ${runId} planned: 10 products, 40 tasks`)

    const start = (label: string) => {
      const child = workerProcess(config, label, workerLog)
      children.push(child)
      return child
    }
    const runningOf = async (child: ChildProcess) =>
      (
        await pool.query<{ task_id: string; fence: string }>(
          "SELECT a.task_id, a.fence FROM task_attempts a WHERE a.outcome = 'running' AND a.worker_id LIKE $1 LIMIT 1",
          [`worker-${child.pid}-%`],
        )
      ).rows[0]
    const a = start("A")
    const b = start("B")
    start("C")

    // 1. Graceful: SIGTERM worker A while it runs a task, then restart it.
    const aTask = await waitFor("worker A to run a task", () => runningOf(a))
    a.kill("SIGTERM")
    const aExit = await exited(a)
    log(
      `worker A (SIGTERM) exited with ${aExit} while running ${aTask.task_id.slice(0, 8)}`,
    )
    start("A2")

    // 2. Crash: SIGKILL worker B while it runs a task, then restart it.
    const bTask = await waitFor("worker B to run a task", () => runningOf(b))
    b.kill("SIGKILL")
    const bExit = await exited(b)
    log(
      `worker B (SIGKILL) exited with ${bExit} while running ${bTask.task_id.slice(0, 8)}`,
    )
    start("B2")

    const finalStatus = await waitFor(
      "the run to finish",
      async () => {
        const s = (
          await pool.query("SELECT status FROM campaign_runs WHERE id = $1", [
            runId,
          ])
        ).rows[0].status
        return [
          "completed",
          "completed_with_errors",
          "failed",
          "cancelled",
        ].includes(s)
          ? s
          : null
      },
      180_000,
    )

    const detail = (await getRun(pool, ticket.id, runId))!
    const q = async <T extends pg.QueryResultRow>(
      sql: string,
      params: unknown[] = [runId],
    ) => (await pool.query<T>(sql, params)).rows
    const resultsDup = await q<{ n: number }>(
      "SELECT count(*)::int AS n FROM (SELECT payload->>'digest' FROM task_results WHERE run_id = $1 GROUP BY 1 HAVING count(*) > 1) d",
    )
    const completed = await q<{ n: number }>(
      "SELECT count(*)::int AS n FROM worker_tasks WHERE run_id = $1 AND status = 'completed'",
    )
    const results = await q<{ n: number }>(
      "SELECT count(*)::int AS n FROM task_results WHERE run_id = $1",
    )
    const succeededTwice = await q<{ n: number }>(
      "SELECT count(*)::int AS n FROM (SELECT a.task_id FROM task_attempts a JOIN worker_tasks t ON t.id = a.task_id WHERE t.run_id = $1 AND a.outcome = 'succeeded' GROUP BY 1 HAVING count(*) > 1) x",
    )
    const rerunAfterSuccess = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM task_attempts later JOIN task_attempts ok ON ok.task_id = later.task_id AND ok.outcome = 'succeeded'
        JOIN worker_tasks t ON t.id = later.task_id WHERE t.run_id = $1 AND later.started_at > ok.started_at`,
    )
    const orderViolations = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM task_dependencies d
         JOIN task_attempts dep ON dep.task_id = d.depends_on_task_id AND dep.outcome = 'succeeded'
         JOIN task_attempts t ON t.task_id = d.task_id
        WHERE d.run_id = $1 AND t.started_at < dep.finished_at`,
    )
    const ranWithoutPrerequisite = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM task_dependencies d JOIN worker_tasks p ON p.id = d.depends_on_task_id
         JOIN task_attempts t ON t.task_id = d.task_id WHERE d.run_id = $1 AND p.status <> 'completed'`,
    )
    const attemptsOf = async (taskId: string) =>
      (
        await pool.query<{ outcome: string; worker_id: string }>(
          "SELECT outcome, worker_id FROM task_attempts WHERE task_id = $1 ORDER BY attempt_number",
          [taskId],
        )
      ).rows
    const aAttempts = await attemptsOf(aTask.task_id)
    const bAttempts = await attemptsOf(bTask.task_id)
    const intervals = await q<{ resource_class: string; s: Date; f: Date }>(
      `SELECT t.resource_class, a.started_at AS s, coalesce(a.finished_at, now()) AS f
         FROM task_attempts a JOIN worker_tasks t ON t.id = a.task_id WHERE t.run_id = $1`,
    )
    const peak: Record<string, number> = { general: 0, cpu: 0, render: 0 }
    for (const cls of Object.keys(peak)) {
      let current = 0
      for (const p of intervals
        .filter((r) => r.resource_class === cls)
        .flatMap((r) => [
          { t: r.s.getTime(), d: 1 },
          { t: r.f.getTime(), d: -1 },
        ])
        .sort((x, y) => x.t - y.t || x.d - y.d))
        peak[cls] = Math.max(peak[cls], (current += p.d))
    }
    const workers = await q<{ n: number }>(
      "SELECT count(DISTINCT a.worker_id)::int AS n FROM task_attempts a JOIN worker_tasks t ON t.id = a.task_id WHERE t.run_id = $1",
    )
    const products = detail.products.map((p) => ({
      position: p.position,
      states: p.tasks.map((t) => t.status),
    }))
    const allDone = ["completed", "completed", "completed", "completed"]
    const expected = (pos: number) =>
      pos === 2
        ? ["completed", "failed", "blocked", "blocked"]
        : pos === 6
          ? ["completed", "completed", "needs_input", "blocked"]
          : allDone

    const checks: Record<string, boolean> = {
      "run finished as completed_with_errors":
        finalStatus === "completed_with_errors",
      "8 independent products completed every step":
        products.filter((p) => p.states.every((s) => s === "completed"))
          .length === 8,
      "failed/needs-input products only blocked their own later steps":
        products.every(
          (p) =>
            JSON.stringify(p.states) === JSON.stringify(expected(p.position)),
        ),
      "transient faults retried within the limit (product 5: 3 attempts)":
        detail.products[4].tasks[0].attempts === 3,
      "one result per completed task, no duplicates":
        results[0].n === completed[0].n &&
        resultsDup[0].n === 0 &&
        succeededTwice[0].n === 0,
      "no completed task ran again": rerunAfterSuccess[0].n === 0,
      "dependents started only after prerequisites succeeded":
        orderViolations[0].n === 0 && ranWithoutPrerequisite[0].n === 0,
      "SIGTERM: attempt handed back (released), then completed by another worker":
        aAttempts[0]?.outcome === "released" &&
        aAttempts.at(-1)?.outcome === "succeeded",
      "SIGKILL: attempt recovered by lease expiry, then completed by another worker":
        bAttempts[0]?.outcome === "lease_expired" &&
        bAttempts.at(-1)?.outcome === "succeeded",
      "render-class steps never overlapped": peak.render === 1,
      "general ≤ 3 and cpu ≤ 2 at once, across all worker processes":
        peak.general <= 3 && peak.cpu <= 2,
      "at least 3 worker processes did work": workers[0].n >= 3,
      "worker A exited cleanly on SIGTERM": aExit === 0,
      "worker B was killed (SIGKILL)": bExit === "SIGKILL",
    }
    return {
      database: name,
      runStatus: finalStatus,
      products,
      checks,
      evidence: {
        tasks: 40,
        completedTasks: completed[0].n,
        results: results[0].n,
        peakConcurrency: peak,
        workerProcesses: workers[0].n,
        gracefulTask: {
          id: aTask.task_id,
          attempts: aAttempts.map((x) => x.outcome),
        },
        crashedTask: {
          id: bTask.task_id,
          attempts: bAttempts.map((x) => x.outcome),
        },
        runError: detail.run.error,
        workerLogTail: workerLog.slice(-8),
      },
    }
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM")
    await Promise.all(children.map(exited))
    await pool.end()
    if (!keep && isScratchDatabaseName(name)) {
      const c = new pg.Client({ ...base, connectionTimeoutMillis: 5_000 })
      await c.connect()
      await c.query(
        `DROP DATABASE IF EXISTS ${c.escapeIdentifier(name)} WITH (FORCE)`,
      )
      await c.end()
    }
  }
}
