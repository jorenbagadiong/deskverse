import { describeDatabase, requireDatabase, run } from "./cli"

import { createPool } from "@/server/db/pool"
import { journal } from "@/server/db/journal"
import {
  migrationsFolder,
  migrationStatus,
  runMigrations,
} from "@/server/db/migrations"

/**
 * yarn db:migrate — applies pending versioned migrations (drizzle/) to the
 * development database in DATABASE_URL. Safe to repeat.
 */
const config = requireDatabase()
run(async () => {
  const pool = createPool(config, {
    max: 1,
    applicationName: "deskverse-migrate",
  })
  try {
    console.log(`Migrating ${describeDatabase(config)}…`)
    const applied = await runMigrations(pool, journal, migrationsFolder())
    const status = await migrationStatus(pool, journal)
    console.log(
      applied.length === 0
        ? `✓ Already up to date (${status.current ?? "no migrations"}).`
        : `✓ Applied ${applied.length}: ${applied.join(", ")}. Current: ${status.current}.`,
    )
  } finally {
    await pool.end()
  }
}, config.password)
