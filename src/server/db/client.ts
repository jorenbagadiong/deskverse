import "server-only"

import type pg from "pg"

import { readDatabaseConfig } from "@/server/db/config"
import {
  createDatabase,
  createPool,
  type DeskverseDatabase,
} from "@/server/db/pool"

/**
 * The app's database handle (DV-004A). Server-only.
 *
 * Created lazily on first use, never at import time, so `next build` and
 * pages that don't touch the database never connect. One bounded pool is
 * kept per server process (on globalThis, so dev-mode reloads don't leak
 * pools). Nothing in DV-004A's pages uses it yet; Affiliate Tickets will.
 */

export class DatabaseUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DatabaseUnavailableError"
  }
}

interface Handle {
  pool: pg.Pool
  db: DeskverseDatabase
}

const globalForDb = globalThis as typeof globalThis & {
  __deskverseDb?: Handle
}

/** Throws DatabaseUnavailableError (with a safe message) when unconfigured. */
export function getDatabase(): DeskverseDatabase {
  if (!globalForDb.__deskverseDb) {
    const config = readDatabaseConfig()
    if (!config.ok) throw new DatabaseUnavailableError(config.message)
    const pool = createPool(config.config, { applicationName: "deskverse-web" })
    globalForDb.__deskverseDb = { pool, db: createDatabase(pool) }
  }
  return globalForDb.__deskverseDb.db
}
