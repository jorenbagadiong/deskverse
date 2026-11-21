import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import pg from "pg"

import { redact, type DatabaseConfig } from "@/server/db/config"
import { schema } from "@/server/db/schema"

/**
 * Connection pools (DV-004A). Nothing connects until the first query.
 *
 * Bounded on every axis so a stuck or missing database can never hang a
 * request or pile up sockets:
 * - at most `max` connections (5 by default; Deskverse is single-user)
 * - 3 s to establish a connection, 10 s per statement
 * - idle connections close after 10 s
 *
 * This module has no "server-only" marker so that scripts and tests can use
 * it outside Next.js. App code should go through `@/server/db/client`.
 */

export interface PoolOptions {
  max?: number
  connectionTimeoutMs?: number
  statementTimeoutMs?: number
  idleTimeoutMs?: number
  /** Shown in pg_stat_activity, e.g. "deskverse-web". */
  applicationName?: string
}

export function createPool(config: DatabaseConfig, options: PoolOptions = {}) {
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: options.max ?? 5,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 3_000,
    idleTimeoutMillis: options.idleTimeoutMs ?? 10_000,
    statement_timeout: options.statementTimeoutMs ?? 10_000,
    query_timeout: (options.statementTimeoutMs ?? 10_000) + 2_000,
    application_name: options.applicationName ?? "deskverse",
    // Let a script exit once its work is done, even if it forgot `end()`.
    allowExitOnIdle: true,
  })
  // An idle connection dropping (e.g. PostgreSQL restarting) emits "error"
  // on the pool; unhandled, that would crash the whole Next.js server.
  pool.on("error", (error) => {
    console.warn(
      `[deskverse] database connection lost: ${redact(error.message, config.password)}`,
    )
  })
  return pool
}

export type DeskverseDatabase = NodePgDatabase<typeof schema>

export function createDatabase(pool: pg.Pool): DeskverseDatabase {
  return drizzle({ client: pool, schema })
}
