import {
  DEFAULT_RETRY_POLICY,
  MAX_ATTEMPTS_LIMIT,
  type RetryPolicy,
} from "@/lib/orchestrator/model"
import type { DatabaseConfig } from "@/server/db/config"
import {
  DEFAULT_LIMITS,
  type ResourceLimits,
} from "@/server/orchestrator/store"

/**
 * Orchestrator settings (DV-004C), from the environment. Every value is
 * bounded; anything out of range falls back to the default.
 *
 *   DESKVERSE_WORKER_SLOTS               1–16      tasks at once in one worker process (3)
 *   DESKVERSE_ORCHESTRATOR_GENERAL_LIMIT 1–16      general tasks at once, all workers (3)
 *   DESKVERSE_ORCHESTRATOR_CPU_LIMIT     1–8       CPU-heavy tasks at once, all workers (2)
 *   (render-class tasks: always 1 at a time)
 *   DESKVERSE_WORKER_LEASE_MS            500–600000 lease length (30 000)
 *   DESKVERSE_WORKER_POLL_MS             50–60000  idle polling interval (1 000)
 *   DESKVERSE_WORKER_SHUTDOWN_GRACE_MS   0–120000  on SIGTERM, wait this long for running tasks (20 000)
 *   DESKVERSE_ORCHESTRATOR_MAX_ATTEMPTS  1–10      counted attempts per task (3)
 *   DESKVERSE_ORCHESTRATOR_RETRY_BASE_MS 10–60000  first retry delay, doubling (2 000)
 *   DESKVERSE_ORCHESTRATOR_RETRY_MAX_MS  10–600000 longest retry delay (60 000)
 *   DESKVERSE_ORCHESTRATOR_VERIFICATION  "1" enables deterministic test runs,
 *                                         only on a test database (see below)
 */

type Env = Readonly<Record<string, string | undefined>>

function int(
  env: Env,
  name: string,
  min: number,
  max: number,
  fallback: number,
) {
  const raw = env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  return /^\d+$/.test(raw) && value >= min && value <= max ? value : fallback
}

export interface OrchestratorConfig {
  slots: number
  limits: ResourceLimits
  leaseMs: number
  pollMs: number
  shutdownGraceMs: number
  retry: RetryPolicy
}

export function readOrchestratorConfig(
  env: Env = process.env,
): OrchestratorConfig {
  const base = int(
    env,
    "DESKVERSE_ORCHESTRATOR_RETRY_BASE_MS",
    10,
    60_000,
    DEFAULT_RETRY_POLICY.baseDelayMs,
  )
  return {
    slots: int(env, "DESKVERSE_WORKER_SLOTS", 1, 16, 3),
    limits: {
      general: int(
        env,
        "DESKVERSE_ORCHESTRATOR_GENERAL_LIMIT",
        1,
        16,
        DEFAULT_LIMITS.general,
      ),
      cpu: int(
        env,
        "DESKVERSE_ORCHESTRATOR_CPU_LIMIT",
        1,
        8,
        DEFAULT_LIMITS.cpu,
      ),
      render: 1,
      perProduct: 1,
    },
    leaseMs: int(env, "DESKVERSE_WORKER_LEASE_MS", 500, 600_000, 30_000),
    pollMs: int(env, "DESKVERSE_WORKER_POLL_MS", 50, 60_000, 1_000),
    shutdownGraceMs: int(
      env,
      "DESKVERSE_WORKER_SHUTDOWN_GRACE_MS",
      0,
      120_000,
      20_000,
    ),
    retry: {
      maxAttempts: int(
        env,
        "DESKVERSE_ORCHESTRATOR_MAX_ATTEMPTS",
        1,
        MAX_ATTEMPTS_LIMIT,
        DEFAULT_RETRY_POLICY.maxAttempts,
      ),
      baseDelayMs: base,
      maxDelayMs: Math.max(
        base,
        int(
          env,
          "DESKVERSE_ORCHESTRATOR_RETRY_MAX_MS",
          10,
          600_000,
          DEFAULT_RETRY_POLICY.maxDelayMs,
        ),
      ),
    },
  }
}

/**
 * Deterministic verification runs are allowed only when explicitly enabled
 * AND the database is a test database (`deskverse_test` or
 * `deskverse_test_*`, as guarded by the test tooling). They can never run
 * against the owner's development data.
 */
export function verificationAllowed(env: Env, database: DatabaseConfig | null) {
  return (
    env.DESKVERSE_ORCHESTRATOR_VERIFICATION === "1" &&
    database !== null &&
    /^deskverse_test(_[a-z0-9_]{1,40})?$/.test(database.database) &&
    database.user.includes("test")
  )
}

/** Real campaign verification is opt-in and only available to guarded test databases. */
export function campaignTestingAllowed(
  env: Env,
  database: DatabaseConfig | null,
) {
  return (
    env.DESKVERSE_CAMPAIGN_TEST === "1" && verificationAllowed(env, database)
  )
}
