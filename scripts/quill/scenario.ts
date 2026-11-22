import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import pg from "pg"

import { FIXTURE_PRODUCTS, startFixtureSites } from "../scout/fixture-sites"
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
import { planRun } from "@/server/orchestrator/store"
import {
  createRegistry,
  QUILL_WORKFLOW,
  RESEARCH_WORKFLOW,
} from "@/server/orchestrator/workflows"
import { Worker } from "@/server/orchestrator/worker"
import { getScript } from "@/server/quill/store"
import { readScoutConfig } from "@/server/scout/config"
import { createScoutHandler } from "@/server/scout/handler"
import { testNetwork } from "@/server/scout/net/test-network"
import { verifyScoutReport } from "@/server/scout/store"
import {
  addProduct,
  changeStatus,
  createTicket,
} from "@/server/tickets/repository"

/**
 * DV-005B scriptwriting crash and recovery with real worker PROCESSES, on
 * a guarded scratch database (never the development database), from real
 * Scout reports of local fixture sites. Used by `yarn quill:verify` and
 * tests/db/quill-crash.db.test.ts.
 *
 * 7 products (6 with enough facts, 1 without), three Quill workers with a
 * test-only generation delay. While scripts are being written: SIGTERM one
 * worker and SIGKILL another; one product's first attempt is killed after
 * writing its script rows but before COMMIT. Crashed workers are replaced.
 * Afterwards a fresh worker runs to prove nothing is redone, and every
 * script, report checksum and attempt is checked.
 */

export interface QuillScenarioReport {
  database: string
  runStatus: string
  products: { name: string; status: string; attempts: string[] }[]
  checks: Record<string, boolean>
  evidence: Record<string, unknown>
}

const CRASH = "(crash test)"

function workerProcess(db: DatabaseConfig, name: string, log: string[]) {
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
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DATABASE_URL: url,
        DATABASE_TEST_URL: "",
        DESKVERSE_QUILL_TEST: JSON.stringify({
          delayMs: 1200,
          crashBeforeCommit: CRASH,
        }),
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

export async function runQuillScenario({
  keep = false,
  log = () => {},
}: {
  keep?: boolean
  log?: (line: string) => void
} = {}): Promise<QuillScenarioReport> {
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
  const name = scratchDatabaseName("quillverify")
  const admin = new pg.Client({ ...base, connectionTimeoutMillis: 5_000 })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)}`)
  await admin.end()
  const config: DatabaseConfig = { ...base, database: name }
  assertTestDatabase(config, dev.ok ? dev.config : null)
  const sites = await startFixtureSites()
  const pool = createPool(config, { max: 6 })
  const workerLog: string[] = []
  const children: ChildProcess[] = []
  const intentional = new Set<ChildProcess>()
  let stopping = false
  let replacements = 0
  try {
    await runMigrations(pool, journal, migrationsFolder())
    const db = createDatabase(pool)
    const input = validateNewTicket({
      title: "Quill scriptwriting verification",
      requestId: randomUUID(),
    })
    if (!input.ok) throw new Error("bad ticket")
    const ticket = (await createTicket(db, input.value)).ticket
    const k = FIXTURE_PRODUCTS.kettle
    const b = FIXTURE_PRODUCTS.buds
    const products = [
      k,
      b,
      { ...k, name: `${k.name} ${CRASH}` },
      { ...k, name: `${k.name} (second batch)` },
      { ...b, name: `${b.name} (second batch)` },
      { ...k, name: `${k.name} (third batch)` },
      {
        ...b,
        name: `${b.name} (one source)`,
        references: [
          { kind: "listing", url: "https://shop.example/p/nova-x3", label: "" },
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
    const version = async () =>
      (
        await pool.query(
          "SELECT version FROM affiliate_tickets WHERE id = $1",
          [ticket.id],
        )
      ).rows[0].version
    await changeStatus(db, ticket.id, await version(), "ready")

    // 1. Real Scout reports (in this process, fixture sites only).
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
    const scout = new Worker({
      pool,
      registry: createRegistry({
        verification: false,
        production: [
          createScoutHandler({
            config: readScoutConfig({
              DESKVERSE_SCOUT_RETRIEVAL: "on",
              DESKVERSE_SCOUT_HOST_INTERVAL_MS: "0",
            }),
            network: testNetwork({ port: sites.port }),
          }),
        ],
      }),
      pollMs: 50,
      log: () => {},
    }).start()
    await waitFor("Scout research", async () => {
      const s = (
        await pool.query("SELECT status FROM campaign_runs WHERE id = $1", [
          research.runId,
        ])
      ).rows[0].status
      return s === "completed" ? s : null
    })
    await scout.stop()
    const reports = (
      await pool.query(
        "SELECT id, product_id FROM scout_reports WHERE run_id = $1",
        [research.runId],
      )
    ).rows
    log(`Scout wrote ${reports.length} reports`)

    // 2. The Quill run, pinned to those reports.
    const { runId } = await planRun(pool, {
      ticketId: ticket.id,
      ticketVersion: await version(),
      requestId: randomUUID(),
      mode: "production",
      workflow: QUILL_WORKFLOW.id,
      productionAvailable: false,
      verificationAllowed: false,
      availableWorkflows: [QUILL_WORKFLOW.id],
      scripts: reports.map((r) => ({
        productId: r.product_id,
        reportId: r.id,
      })),
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 },
    })
    log(`Quill run ${runId} planned for ${reports.length} products`)

    const start = (label: string) => {
      const child = workerProcess(config, label, workerLog)
      children.push(child)
      child.once("exit", () => {
        if (!stopping && !intentional.has(child)) {
          replacements++
          log(`worker ${label} died unexpectedly; starting a replacement`)
          start(`${label}+`)
        }
      })
      return child
    }
    const pickWorker = async (exclude: Set<ChildProcess>) => {
      for (const child of children) {
        if (
          exclude.has(child) ||
          intentional.has(child) ||
          child.exitCode !== null ||
          child.signalCode !== null
        )
          continue
        const rows = (
          await pool.query<{ task_id: string; name: string }>(
            `SELECT a.task_id, s.data->'product'->>'name' AS name FROM task_attempts a
               JOIN worker_tasks t ON t.id = a.task_id JOIN run_product_snapshots s ON s.id = t.snapshot_id
              WHERE a.outcome = 'running' AND t.run_id = $2 AND a.worker_id LIKE $1`,
            [`worker-${child.pid}-%`, runId],
          )
        ).rows
        if (
          rows.some(
            (r) => r.name.includes(CRASH) || r.name.includes("(one source)"),
          )
        )
          continue
        if (rows[0]) return { child, task_id: rows[0].task_id }
      }
      return null
    }
    start("A")
    start("B")
    start("C")
    const graceful = await waitFor("a worker writing a script", () =>
      pickWorker(new Set()),
    )
    intentional.add(graceful.child)
    graceful.child.kill("SIGTERM")
    const aExit = await exited(graceful.child)
    log(
      `a worker (SIGTERM) exited with ${aExit} while writing ${graceful.task_id.slice(0, 8)}`,
    )
    start("A2")
    const crashed = await waitFor("another worker writing a script", () =>
      pickWorker(new Set([graceful.child])),
    )
    intentional.add(crashed.child)
    crashed.child.kill("SIGKILL")
    const bExit = await exited(crashed.child)
    log(
      `a worker (SIGKILL) exited with ${bExit} while writing ${crashed.task_id.slice(0, 8)}`,
    )
    start("B2")

    const finalStatus = await waitFor(
      "the scriptwriting run to finish",
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
    const attemptsBefore = (
      await q<{ n: number }>(
        "SELECT count(*)::int AS n FROM task_attempts a JOIN worker_tasks t ON t.id = a.task_id WHERE t.run_id = $1",
      )
    )[0].n
    // 3. A fresh worker after all the crashes finds nothing to redo.
    stopping = true
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM")
    await Promise.all(children.map(exited))
    stopping = false
    const fresh = start("FRESH")
    await sleep(2_000)
    intentional.add(fresh)
    fresh.kill("SIGTERM")
    await exited(fresh)
    const attemptsAfter = (
      await q<{ n: number }>(
        "SELECT count(*)::int AS n FROM task_attempts a JOIN worker_tasks t ON t.id = a.task_id WHERE t.run_id = $1",
      )
    )[0].n

    const tasks = await q<{
      id: string
      status: string
      name: string
      fence: string
      params: { reportId: string; reportChecksum: string }
    }>(
      `SELECT t.id, t.status, t.fence, t.params, s.data->'product'->>'name' AS name FROM worker_tasks t
         JOIN run_product_snapshots s ON s.id = t.snapshot_id WHERE t.run_id = $1 ORDER BY s.position`,
    )
    const attemptsOf = async (taskId: string) =>
      (
        await q<{ outcome: string }>(
          "SELECT outcome FROM task_attempts WHERE task_id = $1 ORDER BY attempt_number",
          [taskId],
        )
      ).map((x) => x.outcome)
    const productStates = await Promise.all(
      tasks.map(async (t) => ({
        name: t.name,
        status: t.status,
        attempts: await attemptsOf(t.id),
      })),
    )
    const scripts = await q<{ id: string; task_id: string; fence: string }>(
      "SELECT id, task_id, fence FROM quill_scripts WHERE run_id = $1",
    )
    const results = (
      await q<{ n: number }>(
        "SELECT count(*)::int AS n FROM task_results WHERE run_id = $1 AND kind = 'quill_script'",
      )
    )[0].n
    const completed = tasks.filter((t) => t.status === "completed")
    const integrity = await Promise.all(
      scripts.map((s) => getScript(pool, ticket.id, runId, s.id)),
    )
    const reportChecks = await Promise.all(
      tasks.map((t) => verifyScoutReport(pool, t.params.reportId)),
    )
    const succeededTwice = (
      await q<{ n: number }>(
        "SELECT count(*)::int AS n FROM (SELECT a.task_id FROM task_attempts a JOIN worker_tasks t ON t.id = a.task_id WHERE t.run_id = $1 AND a.outcome = 'succeeded' GROUP BY 1 HAVING count(*) > 1) x",
      )
    )[0].n
    const rerun = (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM task_attempts later JOIN task_attempts ok ON ok.task_id = later.task_id AND ok.outcome = 'succeeded'
        JOIN worker_tasks t ON t.id = later.task_id WHERE t.run_id = $1 AND later.started_at > ok.started_at`,
      )
    )[0].n
    const crashTask = tasks.find((t) => t.name.includes(CRASH))!
    const crashAttempts = await attemptsOf(crashTask.id)
    const aAttempts = await attemptsOf(graceful.task_id)
    const bAttempts = await attemptsOf(crashed.task_id)
    const workers = (
      await q<{ n: number }>(
        "SELECT count(DISTINCT a.worker_id)::int AS n FROM task_attempts a JOIN worker_tasks t ON t.id = a.task_id WHERE t.run_id = $1",
      )
    )[0].n
    const ineligible = (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM quill_scene_claims qc JOIN quill_scripts q ON q.id = qc.script_id
         JOIN scout_claims c ON c.report_id = qc.report_id AND c.key = qc.claim_key
        WHERE q.run_id = $1 AND (c.status <> 'supported' OR c.topic IS NOT NULL OR c.time_sensitive)`,
      )
    )[0].n
    const pinned = (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM quill_scripts q JOIN worker_tasks t ON t.id = q.task_id
        WHERE q.run_id = $1 AND (q.report_id::text <> t.params->>'reportId' OR q.report_checksum <> t.params->>'reportChecksum')`,
      )
    )[0].n
    const needsInput = tasks
      .filter((t) => t.status === "needs_input")
      .map((t) => t.name)

    const checks: Record<string, boolean> = {
      "run finished as completed_with_errors":
        finalStatus === "completed_with_errors",
      "6 products got scripts; the one with too few safe facts needs input":
        completed.length === 6 &&
        needsInput.length === 1 &&
        needsInput[0].includes("(one source)"),
      "exactly one script per completed task, none for the other":
        scripts.length === completed.length &&
        results === completed.length &&
        new Set(scripts.map((s) => s.task_id)).size === scripts.length,
      "every script was written under the task's final fence": scripts.every(
        (s) => s.fence === tasks.find((t) => t.id === s.task_id)!.fence,
      ),
      "every script's checksum verifies": integrity.every(
        (s) => s?.integrity === "verified",
      ),
      "every pinned Scout report still verifies, and scripts used exactly the pinned report":
        reportChecks.every((r) => r?.intact) && pinned === 0,
      "only supported, non-sensitive, current claims appear in scripts":
        ineligible === 0,
      "no task succeeded twice; no completed task ran again":
        succeededTwice === 0 && rerun === 0,
      "SIGTERM during generation: handed back (released), then completed by another worker":
        aAttempts[0] === "released" && aAttempts.at(-1) === "succeeded",
      "SIGKILL during generation: recovered by lease expiry, then completed by another worker":
        bAttempts[0] === "lease_expired" && bAttempts.at(-1) === "succeeded",
      "killed after writing script rows but before commit: rolled back, retried, one script":
        crashAttempts[0] === "lease_expired" &&
        crashAttempts.at(-1) === "succeeded" &&
        scripts.filter((s) => s.task_id === crashTask.id).length === 1,
      "after the crashes and commits, a fresh worker redid nothing":
        attemptsAfter === attemptsBefore,
      "at least 3 worker processes wrote scripts": workers >= 3,
      "the SIGTERM'd worker exited cleanly": aExit === 0,
      "the SIGKILL'd worker was killed": bExit === "SIGKILL",
    }
    const sample = integrity.find((s) => s?.document.productName === k.name)
    return {
      database: name,
      runStatus: finalStatus,
      products: productStates,
      checks,
      evidence: {
        products: products.length,
        completed: completed.length,
        scripts: scripts.length,
        taskResults: results,
        workerProcesses: workers,
        replacementsAfterCrash: replacements,
        gracefulTask: { id: graceful.task_id, attempts: aAttempts },
        crashedTask: { id: crashed.task_id, attempts: bAttempts },
        crashBeforeCommitTask: { id: crashTask.id, attempts: crashAttempts },
        sampleScript: sample
          ? {
              product: sample.document.productName,
              version: sample.scriptVersion,
              checksum: sample.checksum,
              report: sample.document.report,
              scenes: sample.document.scenes.map(
                (s) =>
                  `${s.kind}: “${s.caption}” — “${s.narration}”${s.claims.length ? ` [${s.claims.map((c) => `${c.claimKey}: ${c.evidence.map((e) => e.key).join("+")}`).join(", ")}]` : ""}`,
              ),
              disclosure: sample.document.disclosure.text,
              pixel: {
                textCompatible: sample.document.pixel.textCompatible,
                renderReady: sample.document.pixel.renderReady,
              },
            }
          : null,
        workerLogTail: workerLog.slice(-8),
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
