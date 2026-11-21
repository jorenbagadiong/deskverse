import { describeDatabase, requireDatabase, run } from "../db/cli"

import { checkDatabaseHealth } from "@/server/db/health"
import { journal } from "@/server/db/journal"
import { createPool } from "@/server/db/pool"
import {
  readOrchestratorConfig,
  verificationAllowed,
} from "@/server/orchestrator/config"
import {
  createRegistry,
  MISSING_PRODUCTION_CAPABILITIES,
  productionAvailable,
} from "@/server/orchestrator/workflows"

/**
 * yarn worker:check — read-only report: configuration, database, schema,
 * available handlers and current run/task counts. Changes nothing.
 */
const config = requireDatabase()
run(async () => {
  const settings = readOrchestratorConfig()
  const registry = createRegistry({
    verification: verificationAllowed(process.env, config),
  })
  const health = await checkDatabaseHealth(journal)
  console.log(
    `Database:     ${describeDatabase(config)} — ${health.status}${health.schema ? `, schema ${health.schema}` : ""}`,
  )
  console.log(
    `Limits:       ${settings.slots} slots per worker; general ${settings.limits.general}, cpu ${settings.limits.cpu}, render 1 (all workers)`,
  )
  console.log(
    `Leases:       ${settings.leaseMs} ms; retries: ${settings.retry.maxAttempts} attempts, ${settings.retry.baseDelayMs}–${settings.retry.maxDelayMs} ms backoff`,
  )
  console.log(
    `Production:   ${productionAvailable(registry) ? "available" : `not available yet (${MISSING_PRODUCTION_CAPABILITIES.map((c) => c.milestone).join(", ")})`}`,
  )
  console.log(
    `Verification: ${registry.size > 0 ? "enabled (test database)" : "disabled"}`,
  )
  if (health.status !== "ready" || health.schema !== "current") process.exit(1)
  const pool = createPool(config, {
    max: 1,
    applicationName: "deskverse-worker-check",
  })
  try {
    const runs = await pool.query<{ status: string; n: number }>(
      "SELECT status, count(*)::int AS n FROM campaign_runs GROUP BY status ORDER BY status",
    )
    const tasks = await pool.query<{ status: string; n: number }>(
      "SELECT status, count(*)::int AS n FROM worker_tasks GROUP BY status ORDER BY status",
    )
    const fmt = (rows: { status: string; n: number }[]) =>
      rows.length ? rows.map((r) => `${r.status} ${r.n}`).join(", ") : "none"
    console.log(`Runs:         ${fmt(runs.rows)}`)
    console.log(`Tasks:        ${fmt(tasks.rows)}`)
  } finally {
    await pool.end()
  }
}, config.password)
