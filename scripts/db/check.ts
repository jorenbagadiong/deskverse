import { describeDatabase, requireDatabase, run } from "./cli"

import { checkDatabaseHealth } from "@/server/db/health"
import { journal } from "@/server/db/journal"
import { createPool } from "@/server/db/pool"

/**
 * yarn db:check — the same readiness check as
 * GET /api/system/database/health, plus a few details for the owner's own
 * terminal (server version, when the database was first set up). Read-only.
 */
const config = requireDatabase()
run(async () => {
  const report = await checkDatabaseHealth(journal)
  console.log(`Database: ${describeDatabase(config)}`)
  console.log(`Status:   ${report.status} — ${report.message}`)
  if (report.status !== "ready") process.exit(1)
  const pool = createPool(config, {
    max: 1,
    applicationName: "deskverse-check",
  })
  try {
    const server = await pool.query<{ v: string }>(
      "SELECT current_setting('server_version') AS v",
    )
    console.log(`Server:   PostgreSQL ${server.rows[0].v}`)
    const row = await pool
      .query<{ created_at: Date }>(
        "SELECT created_at FROM app_metadata WHERE key = $1",
        ["database.initialized"],
      )
      .catch(() => null)
    const created = row?.rows[0]?.created_at
    if (created) console.log(`Set up:   ${created.toISOString()}`)
  } finally {
    await pool.end()
  }
}, config.password)
