import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import pg from "pg"

import { FIXTURE_PRODUCTS, startFixtureSites } from "./fixture-sites"
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
import { RESEARCH_WORKFLOW } from "@/server/orchestrator/workflows"
import { getResearchReport } from "@/server/scout/store"
import {
  addProduct,
  changeStatus,
  createTicket,
} from "@/server/tickets/repository"

/**
 * DV-005A research crash and recovery with real worker PROCESSES, on a
 * guarded scratch database, against Scout's fixture sites (never the
 * internet, never the development database). Used by `yarn scout:verify`
 * and tests/db/scout-crash.db.test.ts.
 *
 * 8 products (supporting sources, conflicting sources, inaccessible
 * sources, no references, plain text…), three workers. While research is
 * in flight: SIGTERM one worker (graceful hand-back) and SIGKILL another;
 * and one product's first attempt is killed by a test-only hook AFTER it
 * wrote its report rows but BEFORE the transaction committed. Crashed
 * workers are replaced. Then every report, attempt and claim is checked.
 */

export interface ScoutScenarioReport {
  database: string
  runStatus: string
  products: { name: string; status: string; attempts: string[] }[]
  checks: Record<string, boolean>
  evidence: Record<string, unknown>
}

const ROOT = process.cwd()
const CRASH = "(crash test)"

function workerProcess(
  db: DatabaseConfig,
  fixturePort: number,
  name: string,
  log: string[],
) {
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
        // Never the owner's data folder (its render lock or videos): this run renders nothing.
        DESKVERSE_DATA_DIR: path.join(
          os.tmpdir(),
          `deskverse-scout-verify-${process.pid}`,
        ),
        DESKVERSE_SCOUT_RETRIEVAL: "on",
        DESKVERSE_SCOUT_TEST_NETWORK: JSON.stringify({
          port: fixturePort,
          crashBeforeCommit: CRASH,
        }),
        DESKVERSE_SCOUT_HOST_INTERVAL_MS: "50",
        DESKVERSE_SCOUT_REQUEST_TIMEOUT_MS: "8000",
        DESKVERSE_WORKER_LEASE_MS: "1500",
        DESKVERSE_WORKER_POLL_MS: "50",
        DESKVERSE_ORCHESTRATOR_RETRY_BASE_MS: "100",
        DESKVERSE_ORCHESTRATOR_RETRY_MAX_MS: "500",
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
) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

export async function runScoutScenario({
  keep = false,
  log = () => {},
}: {
  keep?: boolean
  log?: (line: string) => void
} = {}): Promise<ScoutScenarioReport> {
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
  const name = scratchDatabaseName("scoutverify")
  const admin = new pg.Client({ ...base, connectionTimeoutMillis: 5_000 })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)}`)
  await admin.end()
  const config: DatabaseConfig = { ...base, database: name }
  assertTestDatabase(config, dev.ok ? dev.config : null)
  // Slow pages, so research is in flight long enough to interrupt.
  const sites = await startFixtureSites({
    delays: { "acme.example": 900, "nova.example": 900, "shop.example": 600 },
  })
  const pool = createPool(config, { max: 5 })
  const workerLog: string[] = []
  const children: ChildProcess[] = []
  const intentional = new Set<ChildProcess>()
  let stopping = false
  let replacements = 0
  try {
    await runMigrations(pool, journal, migrationsFolder())
    const db = createDatabase(pool)
    const input = validateNewTicket({
      title: "Scout research verification (8 products)",
      requestId: randomUUID(),
    })
    if (!input.ok) throw new Error("bad ticket")
    const ticket = (await createTicket(db, input.value)).ticket
    const k = FIXTURE_PRODUCTS.kettle
    const products = [
      k,
      FIXTURE_PRODUCTS.buds,
      FIXTURE_PRODUCTS.lamp,
      FIXTURE_PRODUCTS.fan,
      { ...k, name: `${k.name} ${CRASH}` },
      { ...k, name: `${k.name} (second batch)` },
      {
        ...FIXTURE_PRODUCTS.buds,
        name: `${FIXTURE_PRODUCTS.buds.name} (second batch)`,
      },
      {
        ...k,
        name: `${k.name} (plain text)`,
        references: [
          { kind: "other", url: "https://text.example/specs.txt", label: "" },
        ],
      },
    ]
    for (const p of products)
      await addProduct(db, ticket.id, randomUUID(), {
        name: p.name,
        affiliateUrl: p.affiliateUrl,
        specifications: p.specifications,
        description: p.description,
        references: p.references.map((r) => ({
          kind: r.kind as "listing",
          url: r.url,
          label: r.label,
        })),
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
      mode: "production",
      workflow: RESEARCH_WORKFLOW.id,
      productionAvailable: false,
      verificationAllowed: false,
      availableWorkflows: [RESEARCH_WORKFLOW.id],
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 },
    })
    log(`run ${runId} planned: ${products.length} products, research only`)

    const start = (label: string) => {
      const child = workerProcess(config, sites.port, label, workerLog)
      children.push(child)
      // Replace workers that die unexpectedly (the crash-before-commit hook).
      child.once("exit", () => {
        if (!stopping && !intentional.has(child)) {
          replacements++
          log(`worker ${label} died unexpectedly; starting a replacement`)
          start(`${label}+`)
        }
      })
      return child
    }
    // Picks whichever live worker is researching a slow product (kettle or
    // earbuds) and isn't also in the middle of the crash-test product.
    const pickWorker = async (exclude: Set<ChildProcess>) => {
      for (const child of children) {
        if (exclude.has(child) || intentional.has(child)) continue
        if (child.exitCode !== null || child.signalCode !== null) continue
        const rows = (
          await pool.query<{ task_id: string; name: string }>(
            `SELECT a.task_id, s.data->'product'->>'name' AS name FROM task_attempts a
               JOIN worker_tasks t ON t.id = a.task_id
               JOIN run_product_snapshots s ON s.id = t.snapshot_id
              WHERE a.outcome = 'running' AND a.worker_id LIKE $1`,
            [`worker-${child.pid}-%`],
          )
        ).rows
        if (rows.some((r) => r.name.includes(CRASH))) continue
        const slow = rows.find((r) => /^(Acme|Nova)/.test(r.name))
        if (slow) return { child, task_id: slow.task_id }
      }
      return null
    }
    start("A")
    start("B")
    start("C")

    const graceful = await waitFor("a worker to research a slow product", () =>
      pickWorker(new Set()),
    )
    const a = graceful.child
    const aTask = graceful
    intentional.add(a)
    a.kill("SIGTERM")
    const aExit = await exited(a)
    log(
      `a worker (SIGTERM) exited with ${aExit} while researching ${aTask.task_id.slice(0, 8)}`,
    )
    start("A2")

    const crashed = await waitFor(
      "another worker to research a slow product",
      () => pickWorker(new Set([a])),
    )
    const b = crashed.child
    const bTask = crashed
    intentional.add(b)
    b.kill("SIGKILL")
    const bExit = await exited(b)
    log(
      `a worker (SIGKILL) exited with ${bExit} while researching ${bTask.task_id.slice(0, 8)}`,
    )
    start("B2")

    const finalStatus = await waitFor(
      "the research run to finish",
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
          ? (s as string)
          : null
      },
      180_000,
    )

    const q = async <T extends pg.QueryResultRow>(
      sql: string,
      params: unknown[] = [runId],
    ) => (await pool.query<T>(sql, params)).rows
    const detail = (await getRun(pool, ticket.id, runId))!
    const attemptsOf = async (taskId: string) =>
      (
        await q<{ outcome: string }>(
          "SELECT outcome FROM task_attempts WHERE task_id = $1 ORDER BY attempt_number",
          [taskId],
        )
      ).map((x) => x.outcome)
    const productStates = await Promise.all(
      detail.products.map(async (p) => ({
        name: p.name,
        status: p.tasks[0].status,
        attempts: await attemptsOf(p.tasks[0].id),
      })),
    )
    const completed = detail.products.filter(
      (p) => p.tasks[0].status === "completed",
    )
    const reports = await q<{
      task_id: string
      fence: string
      task_fence: string
    }>(
      "SELECT r.task_id, r.fence, t.fence AS task_fence FROM scout_reports r JOIN worker_tasks t ON t.id = r.task_id WHERE r.run_id = $1",
    )
    const results = await q<{ n: number }>(
      "SELECT count(*)::int AS n FROM task_results WHERE run_id = $1 AND kind = 'scout_research'",
    )
    const reportsPerTask = await q<{ n: number }>(
      "SELECT count(*)::int AS n FROM (SELECT task_id FROM scout_reports WHERE run_id = $1 GROUP BY 1 HAVING count(*) > 1) x",
    )
    const succeededTwice = await q<{ n: number }>(
      "SELECT count(*)::int AS n FROM (SELECT a.task_id FROM task_attempts a JOIN worker_tasks t ON t.id = a.task_id WHERE t.run_id = $1 AND a.outcome = 'succeeded' GROUP BY 1 HAVING count(*) > 1) x",
    )
    const rerunAfterSuccess = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM task_attempts later JOIN task_attempts ok ON ok.task_id = later.task_id AND ok.outcome = 'succeeded'
        JOIN worker_tasks t ON t.id = later.task_id WHERE t.run_id = $1 AND later.started_at > ok.started_at`,
    )
    const integrity = await Promise.all(
      completed.map(
        async (p) =>
          (await getResearchReport(pool, ticket.id, runId, p.snapshotId))!,
      ),
    )
    const intervals = await q<{ s: Date; f: Date }>(
      "SELECT a.started_at AS s, coalesce(a.finished_at, now()) AS f FROM task_attempts a JOIN worker_tasks t ON t.id = a.task_id WHERE t.run_id = $1",
    )
    let peak = 0
    let current = 0
    for (const p of intervals
      .flatMap((r) => [
        { t: r.s.getTime(), d: 1 },
        { t: r.f.getTime(), d: -1 },
      ])
      .sort((x, y) => x.t - y.t || x.d - y.d))
      peak = Math.max(peak, (current += p.d))
    const workers = await q<{ n: number }>(
      "SELECT count(DISTINCT a.worker_id)::int AS n FROM task_attempts a JOIN worker_tasks t ON t.id = a.task_id WHERE t.run_id = $1",
    )
    const crashTask = detail.products.find((p) => p.name.includes(CRASH))!
      .tasks[0]
    const crashAttempts = await attemptsOf(crashTask.id)
    const aAttempts = await attemptsOf(aTask.task_id)
    const bAttempts = await attemptsOf(bTask.task_id)
    const byName = (n: string) => integrity.find((r) => r.productName === n)
    const kettle = byName(FIXTURE_PRODUCTS.kettle.name)
    const buds = byName(FIXTURE_PRODUCTS.buds.name)
    const plain = byName(`${FIXTURE_PRODUCTS.kettle.name} (plain text)`)
    const hosts = new Set(sites.requests.map((r) => r.host))
    const needsInput = detail.products
      .filter((p) => p.tasks[0].status === "needs_input")
      .map((p) => p.name)

    const checks: Record<string, boolean> = {
      "run finished as completed_with_errors":
        finalStatus === "completed_with_errors",
      "6 researchable products completed; lamp (inaccessible) and fan (no references) need input":
        completed.length === 6 &&
        JSON.stringify(needsInput.sort()) ===
          JSON.stringify(
            [FIXTURE_PRODUCTS.fan.name, FIXTURE_PRODUCTS.lamp.name].sort(),
          ),
      "exactly one report per completed task, none for the others":
        reports.length === completed.length &&
        reportsPerTask[0].n === 0 &&
        results[0].n === completed.length,
      "every report was written under the task's final fence": reports.every(
        (r) => r.fence === r.task_fence,
      ),
      "every report's checksum verifies": integrity.every(
        (r) => r.integrity === "verified",
      ),
      "no task succeeded twice; no completed task ran again":
        succeededTwice[0].n === 0 && rerunAfterSuccess[0].n === 0,
      "SIGTERM: research handed back (released), then completed by another worker":
        aAttempts[0] === "released" && aAttempts.at(-1) === "succeeded",
      "SIGKILL: research recovered by lease expiry, then completed by another worker":
        bAttempts[0] === "lease_expired" && bAttempts.at(-1) === "succeeded",
      "killed after writing the report but before commit: rolled back, retried, one report":
        crashAttempts[0] === "lease_expired" &&
        crashAttempts.at(-1) === "succeeded" &&
        reports.filter((r) => r.task_id === crashTask.id).length === 1,
      "supporting sources: capacity supported by 2 sources":
        kettle?.claims.find((c) => c.statement === "Capacity: 1.7 L")
          ?.status === "supported",
      "conflicting sources: battery life flagged as conflicting":
        buds?.claims.find((c) => c.statement === "Battery life: 30 hours")
          ?.status === "conflicting",
      "plain-text source read and used":
        plain?.claims.find((c) => c.statement === "Capacity: 1.7 L")?.status ===
        "supported",
      "the affiliate link was never visited": ![...hosts].some((h) =>
        h.includes("affiliate"),
      ),
      "at most 3 Scout tasks at once (general limit), across processes":
        peak <= 3,
      "at least 3 worker processes did research": workers[0].n >= 3,
      "the SIGTERM'd worker exited cleanly": aExit === 0,
      "the SIGKILL'd worker was killed": bExit === "SIGKILL",
    }
    return {
      database: name,
      runStatus: finalStatus,
      products: productStates,
      checks,
      evidence: {
        products: products.length,
        completed: completed.length,
        reports: reports.length,
        taskResults: results[0].n,
        peakConcurrency: peak,
        workerProcesses: workers[0].n,
        replacementsAfterCrash: replacements,
        gracefulTask: { id: aTask.task_id, attempts: aAttempts },
        crashedTask: { id: bTask.task_id, attempts: bAttempts },
        crashBeforeCommitTask: { id: crashTask.id, attempts: crashAttempts },
        hostsContacted: [...hosts].sort(),
        sampleReport: kettle
          ? {
              product: kettle.productName,
              version: kettle.reportVersion,
              checksum: kettle.checksum,
              supported: kettle.claims
                .filter((c) => c.status === "supported")
                .map((c) => c.statement)
                .slice(0, 6),
              unverified: kettle.claims
                .filter((c) => c.status === "unverified")
                .map((c) => c.statement),
              sources: kettle.sources.map(
                (s) => `${s.key} ${s.requestedUrl} ${s.outcome} ${s.trust}`,
              ),
            }
          : null,
        workerLogTail: workerLog.slice(-10),
      },
    }
  } finally {
    stopping = true
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM")
    await Promise.all(children.map(exited))
    await pool.end()
    await sites.close()
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
