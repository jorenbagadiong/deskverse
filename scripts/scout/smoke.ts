import "../load-env"

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { parseArgs } from "node:util"

import pg from "pg"

import type { ReferenceKind } from "@/lib/scout/types"
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
import { readScoutConfig } from "@/server/scout/config"
import {
  DEFAULT_FETCH_LIMITS,
  realNetwork,
  ScoutFetcher,
} from "@/server/scout/net/fetcher"
import { researchProduct } from "@/server/scout/research"
import { getResearchReport } from "@/server/scout/store"
import {
  addProduct,
  changeStatus,
  createTicket,
} from "@/server/tickets/repository"

/**
 * yarn scout:smoke --url <public page> --name "<product name>" [--kind manufacturer]
 *                  [--spec "Capacity: 1.7 L" ...] [--pipeline]
 *
 * A carefully bounded LIVE retrieval check (DV-005A): one public page
 * (plus its robots.txt), through Scout's real network path (DNS pinning,
 * address checks, robots.txt, TLS verification, limits). Prints what was
 * retrieved and which claims it supports. Nothing is bypassed: a blocked
 * page is reported as blocked.
 *
 * Default: in memory, writes nothing. --pipeline: also runs the full path
 * (a real worker process, real network) on a scratch TEST database, then
 * drops it. The development database is never used.
 */
const { values } = parseArgs({
  options: {
    url: { type: "string" },
    name: { type: "string" },
    kind: { type: "string", default: "manufacturer" },
    spec: { type: "string", multiple: true },
    pipeline: { type: "boolean" },
  },
})
if (!values.url || !values.name) {
  console.error(
    'Usage: yarn scout:smoke --url https://… --name "Product name" [--kind manufacturer] [--spec "Key: value"] [--pipeline]',
  )
  process.exit(2)
}
const product = {
  name: values.name,
  affiliateUrl: "",
  description: "",
  specifications: (values.spec ?? []).join("\n"),
  references: [
    {
      kind: values.kind as ReferenceKind,
      url: values.url,
      label: "smoke test",
    },
  ],
}

async function inMemory() {
  const config = readScoutConfig({
    ...process.env,
    DESKVERSE_SCOUT_RETRIEVAL: "on",
  })
  const fetcher = new ScoutFetcher(realNetwork, {
    ...DEFAULT_FETCH_LIMITS,
    maxPageBytes: config.maxPageBytes,
    requestTimeoutMs: config.requestTimeoutMs,
  })
  const started = Date.now()
  const out = await researchProduct(
    product,
    { attempt: 3, maxAttempts: 3, signal: AbortSignal.timeout(60_000) },
    { fetcher, config, ollama: null },
  )
  console.log(
    `In-memory research (real network) finished in ${Date.now() - started} ms: ${out.kind}`,
  )
  if (out.kind !== "report") {
    console.log(`  ${out.message}`)
    console.log(`  problems: ${JSON.stringify(out.problems)}`)
    return false
  }
  for (const s of out.sources)
    console.log(
      `  ${s.key} ${s.requestedUrl}\n     → ${s.outcome} HTTP ${s.httpStatus ?? "-"} ${s.contentType ?? ""} ${s.byteCount} bytes sha256 ${s.contentSha256 ?? "-"}\n     final ${s.finalUrl ?? "-"} (${s.transport ?? "-"}); title “${s.title ?? ""}”; retrieved ${s.retrievedAt ?? "-"}\n     ${s.detail ?? ""}`,
    )
  const { claims, evidence, brief } = out.analysis
  console.log(
    `  identification: ${brief.product.identification} (${brief.product.identifiedAs ?? "-"})`,
  )
  console.log(
    `  claims: ${claims.length} (${["supported", "conflicting", "unverified", "insufficient_evidence"].map((s) => `${s} ${claims.filter((c) => c.status === s).length}`).join(", ")}); evidence ${evidence.length}`,
  )
  for (const c of claims.slice(0, 12))
    console.log(
      `   - [${c.status}] ${c.origin === "owner" ? "owner" : "source"}: ${c.statement} ← ${c.evidence.map((e) => e.key).join(", ") || "no evidence"}`,
    )
  for (const e of evidence.slice(0, 5))
    console.log(
      `   ${e.key} (${e.method}, ${e.location}): “${e.passage.slice(0, 160)}”`,
    )
  return out.sources.some((s) => s.outcome === "ok")
}

async function pipeline() {
  const fromFile = readEnvFile()
  const parsed = parseDatabaseUrl(
    process.env.DATABASE_TEST_URL || fromFile.DATABASE_TEST_URL,
    "DATABASE_TEST_URL",
  )
  if (!parsed.ok) throw new Error(parsed.message)
  const dev = parseDatabaseUrl(
    process.env.DATABASE_URL || fromFile.DATABASE_URL,
    "DATABASE_URL",
  )
  assertTestDatabase(parsed.config, dev.ok ? dev.config : null)
  const name = scratchDatabaseName("scoutsmoke")
  const admin = new pg.Client({
    ...parsed.config,
    connectionTimeoutMillis: 5_000,
  })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)}`)
  await admin.end()
  const config: DatabaseConfig = { ...parsed.config, database: name }
  assertTestDatabase(config, dev.ok ? dev.config : null)
  const pool = createPool(config, { max: 3 })
  let worker: ReturnType<typeof spawn> | null = null
  try {
    await runMigrations(pool, journal, migrationsFolder())
    const db = createDatabase(pool)
    const input = validateNewTicket({
      title: "Scout live smoke test",
      requestId: randomUUID(),
    })
    if (!input.ok) throw new Error("bad ticket")
    const ticket = (await createTicket(db, input.value)).ticket
    await addProduct(db, ticket.id, randomUUID(), {
      name: product.name,
      affiliateUrl: "https://affiliate-link.invalid/never-visited",
      specifications: product.specifications,
      references: product.references,
    })
    const v = (
      await pool.query("SELECT version FROM affiliate_tickets WHERE id = $1", [
        ticket.id,
      ])
    ).rows[0].version
    const ready = await changeStatus(db, ticket.id, v, "ready")
    const { runId } = await planRun(pool, {
      ticketId: ticket.id,
      ticketVersion: ready.version,
      requestId: randomUUID(),
      mode: "production",
      workflow: RESEARCH_WORKFLOW.id,
      productionAvailable: false,
      verificationAllowed: false,
      availableWorkflows: [RESEARCH_WORKFLOW.id],
      retry: { maxAttempts: 1 },
    })
    const url = `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${config.database}`
    worker = spawn(
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
          DESKVERSE_SCOUT_RETRIEVAL: "on",
          DESKVERSE_WORKER_POLL_MS: "200",
        } as unknown as NodeJS.ProcessEnv,
        stdio: ["ignore", "inherit", "inherit"],
      },
    )
    let status = ""
    for (let i = 0; i < 600; i++) {
      status = (
        await pool.query("SELECT status FROM campaign_runs WHERE id = $1", [
          runId,
        ])
      ).rows[0].status
      if (
        ["completed", "completed_with_errors", "failed", "cancelled"].includes(
          status,
        )
      )
        break
      await sleep(200)
    }
    const detail = (await getRun(pool, ticket.id, runId))!
    const task = detail.products[0].tasks[0]
    console.log(
      `Pipeline (worker process, real network, scratch DB ${name}): run ${status}, task ${task.status}${task.failureMessage ? ` — ${task.failureMessage}` : ""}`,
    )
    const report = await getResearchReport(
      pool,
      ticket.id,
      runId,
      detail.products[0].snapshotId,
    )
    if (report)
      console.log(
        `  report v${report.reportVersion} ${report.status}, integrity ${report.integrity}, checksum ${report.checksum}\n  sources: ${report.sources.map((s) => `${s.key} ${s.outcome} HTTP ${s.httpStatus ?? "-"} sha256 ${s.contentSha256?.slice(0, 16) ?? "-"}`).join("; ")}\n  claims: ${report.claims.length}, evidence ${report.evidence.total}`,
      )
    return Boolean(report)
  } finally {
    if (worker && worker.exitCode === null) {
      worker.kill("SIGTERM")
      await new Promise((r) => worker!.once("exit", r))
    }
    await pool.end()
    if (isScratchDatabaseName(name)) {
      const c = new pg.Client({
        ...parsed.config,
        connectionTimeoutMillis: 5_000,
      })
      await c.connect()
      await c.query(
        `DROP DATABASE IF EXISTS ${c.escapeIdentifier(name)} WITH (FORCE)`,
      )
      await c.end()
    }
  }
}

;(async () => {
  const read = await inMemory()
  const piped = values.pipeline ? await pipeline() : null
  process.exit(read && piped !== false ? 0 : 1)
})().catch((error: unknown) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
