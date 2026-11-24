import { describeDatabase, requireDatabase, run } from "../db/cli"

import { checkDatabaseHealth } from "@/server/db/health"
import { journal } from "@/server/db/journal"
import { createPool } from "@/server/db/pool"
import {
  readOrchestratorConfig,
  verificationAllowed,
} from "@/server/orchestrator/config"
import { createRegistry, CAMPAIGN_READY } from "@/server/orchestrator/workflows"
import { campaignWorkerAvailable } from "@/server/orchestrator/store"
import { readScoutConfig } from "@/server/scout/config"

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
  const scout = readScoutConfig()
  console.log(
    `Scout:        ${scout.retrieval ? "research on (scout-research-v1)" : "research off (DESKVERSE_SCOUT_RETRIEVAL isn't on)"}; extraction ${scout.extraction}${scout.extraction === "ollama" && !scout.ollama ? ` (unusable: ${scout.ollamaProblem})` : ""}; run yarn scout:check for details`,
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
    const campaign = CAMPAIGN_READY
      ? (await campaignWorkerAvailable(pool))
        ? "available"
        : "no compatible worker has checked in"
      : "release verification pending"
    console.log(`Campaign:     ${campaign}`)
    const runs = await pool.query<{ status: string; n: number }>(
      "SELECT status, count(*)::int AS n FROM campaign_runs GROUP BY status ORDER BY status",
    )
    const tasks = await pool.query<{ status: string; n: number }>(
      "SELECT status, count(*)::int AS n FROM worker_tasks GROUP BY status ORDER BY status",
    )
    const fmt = (rows: { status: string; n: number }[]) =>
      rows.length ? rows.map((r) => `${r.status} ${r.n}`).join(", ") : "none"
    const workers = await pool.query<{
      worker_id: string
      ago: number
      stages: string[]
    }>(
      "SELECT worker_id, extract(epoch FROM now() - last_seen_at)::int AS ago, stages FROM orchestrator_workers ORDER BY last_seen_at DESC LIMIT 10",
    )
    console.log(`Runs:         ${fmt(runs.rows)}`)
    console.log(`Tasks:        ${fmt(tasks.rows)}`)
    console.log(
      `Workers:      ${
        workers.rows.length
          ? workers.rows
              .map(
                (w) =>
                  `${w.worker_id} seen ${w.ago}s ago (${w.stages.join(", ") || "no handlers"})`,
              )
              .join("; ")
          : "none checked in"
      }`,
    )
  } finally {
    await pool.end()
  }
}, config.password)
