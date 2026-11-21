import pg from "pg"

import type {
  DatabaseHealthReport,
  DatabaseSchemaState,
} from "@/lib/system/database-health"
import {
  readDatabaseConfig,
  redact,
  type DatabaseConfig,
} from "@/server/db/config"
import { classifyDatabaseError, type DatabaseFailure } from "@/server/db/errors"
import { migrationStatus, type Journal } from "@/server/db/migrations"

/**
 * Database readiness check (DV-004A).
 *
 * Opens one short-lived connection in a read-only session, runs `SELECT 1`
 * and reads the migration table, then closes it. The whole check is bounded
 * by `timeoutMs`, so a hung server can't hold a request. It never writes.
 */

export interface HealthCheckOptions {
  env?: Readonly<Record<string, string | undefined>>
  timeoutMs?: number
  now?: () => Date
  /** Receives a redacted description of unexpected failures, for server logs. */
  log?: (message: string) => void
}

export const HEALTH_TIMEOUT_MS = 2_500

export async function checkDatabaseHealth(
  journal: Journal,
  {
    env = process.env,
    timeoutMs = HEALTH_TIMEOUT_MS,
    now = () => new Date(),
    log = (message) => console.warn(`[deskverse] ${message}`),
  }: HealthCheckOptions = {},
): Promise<DatabaseHealthReport> {
  const checkedAt = now().toISOString()
  const config = readDatabaseConfig(env)
  if (!config.ok)
    return {
      status: "unconfigured",
      message:
        config.reason === "unconfigured"
          ? "DATABASE_URL isn't set. Local PostgreSQL is only needed for Affiliate Tickets; Pixel Studio works without it."
          : "DATABASE_URL in .env.local isn't a valid local PostgreSQL URL. See .env.example.",
      schema: null,
      checkedAt,
    }

  try {
    const schema = await withTimeout(
      probe(config.config, journal, timeoutMs),
      timeoutMs,
    )
    return {
      status: "ready",
      message: READY_MESSAGE[schema],
      schema,
      checkedAt,
    }
  } catch (error) {
    const { failure, message } = classifyDatabaseError(error)
    if (failure === "error")
      log(
        `database health check failed: ${redact(String((error as Error)?.message ?? error), config.config.password)}`,
      )
    return { status: statusOf(failure), message, schema: null, checkedAt }
  }
}

const READY_MESSAGE: Record<DatabaseSchemaState, string> = {
  current: "Local PostgreSQL is running and the schema is up to date.",
  pending:
    "Local PostgreSQL is running, but the schema needs updating. Run: yarn db:migrate",
  ahead:
    "Local PostgreSQL is running, but its schema is newer than this version of Deskverse. Update the code.",
}

function statusOf(failure: DatabaseFailure): DatabaseHealthReport["status"] {
  return failure === "offline" || failure === "timeout" ? "offline" : "error"
}

async function probe(
  config: DatabaseConfig,
  journal: Journal,
  timeoutMs: number,
): Promise<DatabaseSchemaState> {
  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs,
    application_name: "deskverse-health",
    // The session itself refuses writes.
    options: "-c default_transaction_read_only=on",
  })
  // A socket error after connecting must not become an unhandled event.
  client.on("error", () => {})
  try {
    await client.connect()
    await client.query("SELECT 1")
    const status = await migrationStatus(client, journal)
    if (status.ahead) return "ahead"
    return status.pending.length > 0 ? "pending" : "current"
  } finally {
    await client.end().catch(() => {})
  }
}

class HealthTimeoutError extends Error {
  readonly code = "ETIMEDOUT"
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new HealthTimeoutError("health check timed out")),
      ms + 500,
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
