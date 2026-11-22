import { spawn, type ChildProcess } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  existsSync,
  promises as fs,
  readFileSync,
  readdirSync,
  readlinkSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import pg from "pg"

import { seedTicket, type SeedProduct, type SeededTicket } from "./fixtures"
import { FIXTURE_PRODUCTS, startFixtureSites } from "../scout/fixture-sites"
import { parseDatabaseUrl, type DatabaseConfig } from "@/server/db/config"
import { readEnvFile } from "@/server/db/env-file"
import { journal } from "@/server/db/journal"
import { migrationsFolder, runMigrations } from "@/server/db/migrations"
import { createPool } from "@/server/db/pool"
import {
  assertTestDatabase,
  isScratchDatabaseName,
  scratchDatabaseName,
} from "@/server/db/test-guard"
import { planRun } from "@/server/orchestrator/store"
import { PIXEL_WORKFLOW } from "@/server/orchestrator/workflows"
import { pixelPlanHooks } from "@/server/pixel/plan"
import { reconcileTicketRenders } from "@/server/pixel/reconcile"
import { ticketRenderStorage } from "@/server/pixel/store"
import { createRunner } from "@/server/process/run-executable"
import { outputProbeArgs, verifyOutputProbe } from "@/server/video/ffprobe"
import { RenderGate } from "@/server/video/render-gate"

/**
 * DV-005C batch verification with REAL FFmpeg and real worker PROCESSES,
 * on a guarded scratch database and a temporary data folder (never the
 * development database or real Deskverse data). Used by `yarn
 * pixel:verify` (batches of 1, 3 and 10 products) and
 * tests/db/pixel-crash.db.test.ts (smaller batches).
 *
 * Real inputs: images uploaded through the ticket upload path, Scout
 * research of local fixture sites, Quill scripts. While three ticket
 * workers render: standalone Pixel Studio renders run in other processes;
 * one worker is SIGTERMed and another SIGKILLed mid-render; test-only
 * crash points kill a worker during FFmpeg, after the output is verified
 * (before commit), and inside the commit transaction; one product's image
 * is damaged on disk. Evidence of non-overlap comes from two independent
 * sources: the render gate's audit log and a 50 ms process sampler
 * counting render FFmpeg processes under the data folder.
 */

export interface PixelScenarioReport {
  database: string
  checks: Record<string, boolean>
  evidence: Record<string, unknown>
}

const k = FIXTURE_PRODUCTS.kettle

function workerProcess(
  db: DatabaseConfig,
  dataRoot: string,
  name: string,
  log: string[],
  crashes: unknown[],
) {
  const url = `postgresql://${encodeURIComponent(db.user)}:${encodeURIComponent(db.password)}@${db.host}:${db.port}/${db.database}`
  const child = spawn(
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
        DESKVERSE_DATA_DIR: dataRoot,
        DESKVERSE_RENDER_GATE_AUDIT: path.join(dataRoot, "gate-audit.jsonl"),
        DESKVERSE_PIXEL_TEST: JSON.stringify(crashes),
        DESKVERSE_WORKER_LEASE_MS: "4000",
        DESKVERSE_WORKER_POLL_MS: "100",
        DESKVERSE_ORCHESTRATOR_RETRY_BASE_MS: "200",
        DESKVERSE_ORCHESTRATOR_RETRY_MAX_MS: "1000",
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
  timeoutMs = 600_000,
) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await probe()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

/** Every 50 ms: how many FFmpeg processes run with their working directory under the data folder. */
function startSampler(dataRoot: string) {
  let max = 0
  let samples = 0
  const stop = { stopped: false }
  void (async () => {
    while (!stop.stopped) {
      let n = 0
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue
        try {
          const cwd = readlinkSync(`/proc/${name}/cwd`)
          if (!cwd.startsWith(dataRoot)) continue
          const program = path.basename(
            readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0")[0] ?? "",
          )
          if (program === "ffmpeg") n++
        } catch {
          // gone
        }
      }
      max = Math.max(max, n)
      samples++
      await sleep(50)
    }
  })()
  return { stop: () => (stop.stopped = true), result: () => ({ max, samples }) }
}

export async function runPixelScenario({
  batches = [1, 3, 10],
  studioRenders = 2,
  keep = false,
  log = () => {},
}: {
  batches?: number[]
  studioRenders?: number
  keep?: boolean
  log?: (line: string) => void
} = {}): Promise<PixelScenarioReport> {
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
  const name = scratchDatabaseName("pixelverify")
  const admin = new pg.Client({ ...base, connectionTimeoutMillis: 5_000 })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)}`)
  await admin.end()
  const config: DatabaseConfig = { ...base, database: name }
  assertTestDatabase(config, dev.ok ? dev.config : null)
  const dataRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-pixel-verify-")),
  )
  const sites = await startFixtureSites()
  const pool = createPool(config, { max: 6 })
  const workerLog: string[] = []
  const children: ChildProcess[] = []
  const intentional = new Set<ChildProcess>()
  let stopping = false
  let replacements = 0
  const sampler = startSampler(dataRoot)
  try {
    await runMigrations(pool, journal, migrationsFolder())
    // Crash points (attempt 1 only) go to the second batch's products.
    const crashes = [
      { crashAt: "during-render", product: "(crash-render)" },
      { crashAt: "after-output", product: "(crash-output)" },
      { crashAt: "before-commit", product: "(crash-commit)" },
    ]
    const tickets: { size: number; seeded: SeededTicket }[] = []
    for (const [b, size] of batches.entries()) {
      const products: SeedProduct[] = Array.from({ length: size }, (_, i) => {
        const special =
          b === 1 && i < 3
            ? ["(crash-render)", "(crash-output)", "(crash-commit)"][i]
            : b === batches.length - 1 && size >= 5 && i === size - 1
              ? "(broken-image)"
              : `(b${b + 1}-${i + 1})`
        return { name: `${k.name} ${special}`, base: k, images: 3 }
      })
      tickets.push({
        size,
        seeded: await seedTicket({
          pool,
          dataRoot,
          fixturePort: sites.port,
          products,
          title: `Batch of ${size}`,
        }),
      })
      log(
        `seeded a ticket with ${size} product(s): images, research and scripts`,
      )
    }
    const runs: string[] = []
    for (const { seeded } of tickets) {
      const v = (
        await pool.query(
          "SELECT version FROM affiliate_tickets WHERE id = $1",
          [seeded.ticketId],
        )
      ).rows[0].version
      const selections = seeded.products.map((p) => ({
        productId: p.productId,
        scriptId: p.scriptId!,
        assetIds: p.assetIds,
      }))
      const { runId } = await planRun(pool, {
        ticketId: seeded.ticketId,
        ticketVersion: v,
        requestId: randomUUID(),
        mode: "production",
        workflow: PIXEL_WORKFLOW.id,
        productionAvailable: false,
        verificationAllowed: false,
        availableWorkflows: [PIXEL_WORKFLOW.id],
        retry: { maxAttempts: 4, baseDelayMs: 200, maxDelayMs: 1000 },
        ...pixelPlanHooks(seeded.ticketId, selections),
      })
      runs.push(runId)
    }
    // Damage one pinned image of the "broken" product on disk.
    const broken = tickets
      .flatMap((t) => t.seeded.products)
      .find((p) => p.name.includes("(broken-image)"))
    if (broken) {
      const row = (
        await pool.query(
          "SELECT ticket_id, id, extension FROM ticket_assets WHERE id = $1",
          [broken.assetIds[1]],
        )
      ).rows[0]
      const file = path.join(
        dataRoot,
        "tickets",
        row.ticket_id,
        "assets",
        `${row.id}.${row.extension}`,
      )
      const bytes = await fs.readFile(file)
      bytes[bytes.length - 10] ^= 0xff
      await fs.writeFile(file, bytes)
    }
    log(
      `planned ${runs.length} video run(s) for ${tickets.reduce((n, t) => n + t.size, 0)} products`,
    )

    const start = (label: string) => {
      const child = workerProcess(config, dataRoot, label, workerLog, crashes)
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
    start("A")
    start("B")
    start("C")
    // Standalone Pixel Studio renders in their own processes, competing for the gate.
    const studio: Promise<{ code: number | string | null; out: string }>[] = []
    for (let i = 0; i < studioRenders; i++) {
      await sleep(i === 0 ? 2_000 : 9_000)
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          "./scripts/server-only-hook.mjs",
          "scripts/pixel/studio-render.ts",
          "--data",
          dataRoot,
        ],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            DESKVERSE_RENDER_GATE_AUDIT: path.join(
              dataRoot,
              "gate-audit.jsonl",
            ),
          } as unknown as NodeJS.ProcessEnv,
          stdio: ["ignore", "pipe", "pipe"],
        },
      )
      let out = ""
      child.stdout.on("data", (c: Buffer) => (out += c.toString()))
      studio.push(exited(child).then((code) => ({ code, out })))
    }

    // SIGTERM and SIGKILL the worker that is rendering an ordinary product.
    const renderingWorker = async (exclude: Set<string>) => {
      const row = (
        await pool.query<{ worker_id: string; task_id: string; name: string }>(
          `SELECT a.worker_id, a.task_id, s.data->'product'->>'name' AS name FROM task_attempts a
             JOIN worker_tasks t ON t.id = a.task_id JOIN run_product_snapshots s ON s.id = t.snapshot_id
             JOIN pixel_render_jobs j ON j.task_id = t.id
            WHERE a.outcome = 'running' AND t.stage = 'pixel.render' AND j.state = 'rendering'`,
        )
      ).rows.find(
        (r) => !/crash|broken/.test(r.name) && !exclude.has(r.task_id),
      )
      if (!row) return null
      const pid = Number(row.worker_id.split("-")[1])
      const child = children.find(
        (c) => c.pid === pid && c.exitCode === null && c.signalCode === null,
      )
      return child ? { child, taskId: row.task_id } : null
    }
    await sleep(1_500)
    const graceful = await waitFor(
      "a worker rendering an ordinary product",
      () => renderingWorker(new Set()),
    )
    intentional.add(graceful.child)
    graceful.child.kill("SIGTERM")
    const termExit = await exited(graceful.child)
    log(
      `SIGTERM: worker exited with ${termExit} while rendering ${graceful.taskId.slice(0, 8)}`,
    )
    start("A2")
    const killed = await waitFor(
      "another worker rendering an ordinary product",
      () => renderingWorker(new Set([graceful.taskId])),
    )
    intentional.add(killed.child)
    killed.child.kill("SIGKILL")
    const killExit = await exited(killed.child)
    log(`SIGKILL: worker killed while rendering ${killed.taskId.slice(0, 8)}`)
    start("B2")

    const statuses = await waitFor(
      "every video run to finish",
      async () => {
        const rows = (
          await pool.query(
            "SELECT id, status FROM campaign_runs WHERE id = ANY($1)",
            [runs],
          )
        ).rows
        return rows.every((r) =>
          [
            "completed",
            "completed_with_errors",
            "failed",
            "cancelled",
          ].includes(r.status),
        )
          ? rows
          : null
      },
      1_200_000,
    )
    const studioResults = await Promise.all(studio)
    const q = async <T extends pg.QueryResultRow>(
      sql: string,
      params: unknown[] = [runs],
    ) => (await pool.query<T>(sql, params)).rows
    const attemptsBefore = (
      await q<{ n: number }>(
        "SELECT count(*)::int AS n FROM task_attempts a JOIN worker_tasks t ON t.id = a.task_id WHERE t.run_id = ANY($1)",
      )
    )[0].n
    // A fresh worker after everything: nothing may be redone.
    stopping = true
    for (const c of children)
      if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM")
    await Promise.all(children.map(exited))
    stopping = false
    const fresh = start("FRESH")
    await sleep(3_000)
    intentional.add(fresh)
    fresh.kill("SIGTERM")
    await exited(fresh)
    stopping = true
    sampler.stop()
    const attemptsAfter = (
      await q<{ n: number }>(
        "SELECT count(*)::int AS n FROM task_attempts a JOIN worker_tasks t ON t.id = a.task_id WHERE t.run_id = ANY($1)",
      )
    )[0].n

    const tasks = await q<{
      id: string
      status: string
      name: string
      failure_message: string | null
    }>(
      `SELECT t.id, t.status, t.failure_message, s.data->'product'->>'name' AS name FROM worker_tasks t JOIN run_product_snapshots s ON s.id = t.snapshot_id WHERE t.run_id = ANY($1)`,
    )
    const attemptsOf = async (taskId: string) =>
      (
        await pool.query<{ outcome: string }>(
          "SELECT outcome FROM task_attempts WHERE task_id = $1 ORDER BY attempt_number",
          [taskId],
        )
      ).rows.map((r) => r.outcome)
    const deliverables = await q<{
      task_id: string
      pixel_job_id: string
      sha256: string
      byte_size: string
      checks: { reusedEarlierAttempt?: boolean }
    }>(
      "SELECT task_id, pixel_job_id, sha256, byte_size, checks FROM pixel_deliverables WHERE run_id = ANY($1)",
    )
    const results = (
      await q<{ n: number }>(
        "SELECT count(*)::int AS n FROM task_results WHERE run_id = ANY($1) AND kind = 'pixel_video'",
      )
    )[0].n
    const completed = tasks.filter((t) => t.status === "completed")
    // Every committed MP4 on disk: right bytes, still a valid video.
    const storage = ticketRenderStorage(dataRoot)
    const run = createRunner({ timeoutMs: 60_000 })
    let filesOk = 0
    for (const d of deliverables) {
      const output = await storage.resolveCompletedOutput(
        d.pixel_job_id as never,
      )
      if (!output) continue
      const sha = createHash("sha256")
        .update(await fs.readFile(output.path))
        .digest("hex")
      const project = await storage.readProject(d.pixel_job_id)
      const frames = project.scenes.reduce((n, s) => n + s.durationFrames, 0)
      const probe = await run("ffprobe", outputProbeArgs(output.path))
      if (
        sha === d.sha256 &&
        output.sizeBytes === Number(d.byte_size) &&
        probe.ok &&
        verifyOutputProbe(probe.stdout, frames).ok
      )
        filesOk++
    }
    // Gate audit: acquire/release intervals across every process.
    const audit = existsSync(path.join(dataRoot, "gate-audit.jsonl"))
      ? readFileSync(path.join(dataRoot, "gate-audit.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map(
            (l) =>
              JSON.parse(l) as {
                event: string
                t: number
                mono: string
                token: string
                kind: string
                pid: number
              },
          )
      : []
    // Clock-free check, in file order (appends are atomic and ordered): a
    // holder logs "released" BEFORE closing the lock and the next holder
    // logs "acquired" only AFTER getting it, so a "released" that comes
    // after someone else's "acquired" is a real overlap. A crashed holder
    // never logs "released" (the kernel freed its lock when it died).
    let overlaps = 0
    let open: string | null = null
    const superseded = new Set<string>()
    for (const e of audit) {
      if (e.event === "acquired") {
        if (open) superseded.add(open)
        open = e.token
      } else {
        if (superseded.has(e.token)) overlaps++
        if (open === e.token) open = null
      }
    }
    // Second, independent check on CLOCK_MONOTONIC (system-wide, immune to
    // the wall-clock steps WSL2 makes when it syncs time).
    const intervals = new Map<
      string,
      { start: bigint; end: bigint | null; kind: string }
    >()
    for (const e of audit) {
      const t = BigInt(e.mono)
      if (e.event === "acquired")
        intervals.set(e.token, { start: t, end: null, kind: e.kind })
      else if (intervals.has(e.token)) intervals.get(e.token)!.end = t
    }
    const list = [...intervals.values()].sort((a, b) =>
      a.start < b.start ? -1 : a.start > b.start ? 1 : 0,
    )
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]
      if (prev.end !== null && list[i].start < prev.end) overlaps++
    }
    const crashedHolders = list.filter((x) => x.end === null).length
    const byName = (s: string) => tasks.find((t) => t.name.includes(s))
    const crashRender = byName("(crash-render)")
    const crashOutput = byName("(crash-output)")
    const crashCommit = byName("(crash-commit)")
    const brokenTask = byName("(broken-image)")
    const succeededTwice = (
      await q<{ n: number }>(
        "SELECT count(*)::int AS n FROM (SELECT a.task_id FROM task_attempts a JOIN worker_tasks t ON t.id = a.task_id WHERE t.run_id = ANY($1) AND a.outcome = 'succeeded' GROUP BY 1 HAVING count(*) > 1) x",
      )
    )[0].n
    const reconcile = await reconcileTicketRenders(
      pool,
      dataRoot,
      new RenderGate(dataRoot),
    )
    const repaired = await reconcileTicketRenders(
      pool,
      dataRoot,
      new RenderGate(dataRoot),
      { repair: true },
    )
    const afterRepair = await reconcileTicketRenders(
      pool,
      dataRoot,
      new RenderGate(dataRoot),
    )
    const totalProducts = tickets.reduce((n, t) => n + t.size, 0)
    const expectedCompleted = totalProducts - (brokenTask ? 1 : 0)
    const sampled = sampler.result()
    const attempts = async (t?: { id: string }) =>
      t ? await attemptsOf(t.id) : []

    const checks: Record<string, boolean> = {
      [`batches ${batches.join(", ")}: every product rendered except the damaged one`]:
        completed.length === expectedCompleted,
      "the damaged image stopped only its own product (needs input)":
        !brokenTask ||
        (brokenTask.status === "needs_input" &&
          /checksum/.test(brokenTask.failure_message ?? "")),
      "exactly one deliverable per completed task":
        deliverables.length === completed.length &&
        new Set(deliverables.map((d) => d.task_id)).size ===
          deliverables.length &&
        results === completed.length,
      "every committed MP4 exists with its recorded size and SHA-256 and re-verifies (1080×1920 H.264)":
        filesOk === deliverables.length,
      "never more than one render FFmpeg at a time (process sampler)":
        sampled.max <= 1 && sampled.samples > 100,
      "render-gate holds never overlapped across processes (audit log)":
        overlaps === 0 && list.length >= expectedCompleted,
      [`${studioRenders} standalone Pixel Studio render(s) completed while workers rendered`]:
        studioResults.length === studioRenders &&
        studioResults.every((r) => r.code === 0) &&
        list.filter((x) => x.kind === "studio").length === studioRenders,
      "SIGTERM mid-render: handed back (released), then completed":
        (await attemptsOf(graceful.taskId)).includes("released") &&
        (await attemptsOf(graceful.taskId)).at(-1) === "succeeded" &&
        termExit === 0,
      "SIGKILL mid-render: recovered by lease expiry, then completed":
        (await attemptsOf(killed.taskId)).includes("lease_expired") &&
        (await attemptsOf(killed.taskId)).at(-1) === "succeeded" &&
        killExit === "SIGKILL",
      "crash during FFmpeg: recovered, rendered again, one deliverable":
        !crashRender ||
        ((await attempts(crashRender))[0] === "lease_expired" &&
          crashRender.status === "completed"),
      "crash after the output was verified: the output was reused, not rendered again":
        !crashOutput ||
        (deliverables.find((d) => d.task_id === crashOutput.id)?.checks
          .reusedEarlierAttempt === true &&
          (await attempts(crashOutput))[0] === "lease_expired"),
      "crash inside the commit transaction: rolled back, recovered, one deliverable":
        !crashCommit ||
        ((await attempts(crashCommit))[0] === "lease_expired" &&
          deliverables.filter((d) => d.task_id === crashCommit.id).length ===
            1),
      "no task succeeded twice": succeededTwice === 0,
      "after the crashes, a fresh worker redid nothing":
        attemptsAfter === attemptsBefore,
      "reconciliation found no problems; --repair removed only abandoned folders":
        reconcile.problems.length === 0 &&
        repaired.removed.length === reconcile.abandoned.length &&
        afterRepair.abandoned.length === 0 &&
        afterRepair.delivered === deliverables.length &&
        afterRepair.problems.length === 0,
      "the render gate is free at the end": !(
        await new RenderGate(dataRoot).status()
      ).held,
    }
    return {
      database: name,
      checks,
      evidence: {
        runs: statuses.map((s) => s.status),
        products: totalProducts,
        completed: completed.length,
        deliverables: deliverables.length,
        taskResults: results,
        gateHolds: list.length,
        studioHolds: list.filter((x) => x.kind === "studio").length,
        crashedHolders,
        sampler: sampled,
        replacementsAfterCrash: replacements,
        attempts: {
          sigterm: await attemptsOf(graceful.taskId),
          sigkill: await attemptsOf(killed.taskId),
          crashRender: await attempts(crashRender),
          crashOutput: await attempts(crashOutput),
          crashCommit: await attempts(crashCommit),
        },
        reconcile: {
          abandoned: reconcile.abandoned.length,
          removed: repaired.removed.length,
          problems: reconcile.problems,
        },
        workerLogTail: workerLog.slice(-6),
      },
    }
  } finally {
    stopping = true
    sampler.stop()
    for (const c of children)
      if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM")
    await Promise.all(children.map(exited))
    await pool.end()
    await sites.close()
    if (!keep) {
      await fs.rm(dataRoot, { recursive: true, force: true })
      if (isScratchDatabaseName(name)) {
        const c = new pg.Client({ ...base, connectionTimeoutMillis: 5_000 })
        await c.connect()
        await c.query(
          `DROP DATABASE IF EXISTS ${c.escapeIdentifier(name)} WITH (FORCE)`,
        )
        await c.end()
      }
    }
  }
}
