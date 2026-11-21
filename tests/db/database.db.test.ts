import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { checkDatabaseHealth } from "@/server/db/health"
import { journal } from "@/server/db/journal"
import {
  MigrationError,
  migrationsFolder,
  migrationStatus,
  runMigrations,
  type Journal,
} from "@/server/db/migrations"
import { createDatabase, createPool } from "@/server/db/pool"
import { classifyDatabaseError } from "@/server/db/errors"
import { appMetadata } from "@/server/db/schema"

import {
  client,
  createScratchDatabase,
  databaseUrl,
  developmentDatabaseName,
  testDatabase,
  type ScratchDatabase,
} from "./helpers"

/** DV-004A: real PostgreSQL (yarn test:db), each test file in its own scratch database. */

/** Every migration in this checkout, in order (follows drizzle/meta/_journal.json). */
const TAGS = journal.entries.map((entry) => entry.tag)
const LATEST = TAGS[TAGS.length - 1]
const LAST_WHEN = journal.entries[journal.entries.length - 1].when

describe("test database isolation", () => {
  it("never sees DATABASE_URL", () => {
    expect(process.env.DATABASE_URL).toBeUndefined()
  })

  it("the test role can't connect to the development database", async () => {
    const c = client({ ...testDatabase(), database: developmentDatabaseName })
    const error = await c.connect().then(
      () => null,
      (e: unknown) => e,
    )
    await c.end().catch(() => {})
    expect(error).not.toBeNull()
    // "permission denied for database" (CONNECT revoked) — not a missing database.
    expect((error as { code?: string }).code).toBe("42501")
  })
})

describe("connection, migrations and persistence", () => {
  let scratch: ScratchDatabase

  beforeAll(async () => {
    scratch = await createScratchDatabase("main")
  })
  afterAll(() => scratch?.drop())

  const env = () => ({ DATABASE_URL: databaseUrl(scratch.config) })

  it("connects through Drizzle", async () => {
    const pool = createPool(scratch.config)
    try {
      const result = await createDatabase(pool).execute(sql`SELECT 1 AS one`)
      expect(result.rows).toEqual([{ one: 1 }])
    } finally {
      await pool.end()
    }
  })

  it("health is ready with the schema pending before migrating", async () => {
    const report = await checkDatabaseHealth(journal, { env: env() })
    expect(report).toMatchObject({ status: "ready", schema: "pending" })
    expect(report.message).toContain("yarn db:migrate")
  })

  it("applies the versioned migrations to a new database", async () => {
    const pool = createPool(scratch.config)
    try {
      expect(await runMigrations(pool, journal, migrationsFolder())).toEqual(
        TAGS,
      )
      const status = await migrationStatus(pool, journal)
      expect(status).toEqual({
        known: TAGS.length,
        applied: TAGS.length,
        pending: [],
        current: LATEST,
        ahead: false,
      })
      const rows = await createDatabase(pool).select().from(appMetadata)
      expect(rows.map((r) => r.key)).toEqual(["database.initialized"])
      expect(rows[0].value).toEqual({ milestone: "DV-004A" })
    } finally {
      await pool.end()
    }
    const report = await checkDatabaseHealth(journal, { env: env() })
    expect(report).toMatchObject({ status: "ready", schema: "current" })
  })

  it("is safe to run again, including two migrators at once", async () => {
    const pools = [createPool(scratch.config), createPool(scratch.config)]
    try {
      const results = await Promise.all(
        pools.map((pool) => runMigrations(pool, journal, migrationsFolder())),
      )
      expect(results).toEqual([[], []])
      const count = await pools[0].query(
        'SELECT count(*)::int AS n FROM drizzle."__drizzle_migrations"',
      )
      expect(count.rows[0].n).toBe(TAGS.length)
      const seeds = await pools[0].query(
        "SELECT count(*)::int AS n FROM app_metadata",
      )
      expect(seeds.rows[0].n).toBe(1)
    } finally {
      await Promise.all(pools.map((pool) => pool.end()))
    }
  })

  it("keeps a record across reconnecting", async () => {
    const first = createPool(scratch.config)
    await createDatabase(first)
      .insert(appMetadata)
      .values({ key: "test.persisted", value: { n: 42 } })
    await first.end()

    const second = createPool(scratch.config)
    try {
      const rows = await createDatabase(second)
        .select()
        .from(appMetadata)
        .where(eq(appMetadata.key, "test.persisted"))
      expect(rows).toHaveLength(1)
      expect(rows[0].value).toEqual({ n: 42 })
    } finally {
      await second.end()
    }
  })

  it("rolls a failed transaction back completely", async () => {
    const pool = createPool(scratch.config)
    try {
      const db = createDatabase(pool)
      await expect(
        db.transaction(async (tx) => {
          await tx
            .insert(appMetadata)
            .values({ key: "test.rolled-back", value: {} })
          throw new Error("abort")
        }),
      ).rejects.toThrow("abort")
      const rows = await db
        .select()
        .from(appMetadata)
        .where(eq(appMetadata.key, "test.rolled-back"))
      expect(rows).toEqual([])
    } finally {
      await pool.end()
    }
  })

  it("closes every pooled connection on end()", async () => {
    const pool = createPool(scratch.config, {
      applicationName: "deskverse-pool-test",
    })
    await Promise.all(
      Array.from({ length: 4 }, () => pool.query("SELECT pg_sleep(0.05)")),
    )
    expect(pool.totalCount).toBeGreaterThan(1)
    expect(pool.totalCount).toBeLessThanOrEqual(5)
    await pool.end()
    expect(pool.totalCount).toBe(0)

    const observer = client(scratch.config)
    await observer.connect()
    try {
      // Backends can take a moment to disappear after the socket closes.
      let remaining = -1
      for (let i = 0; i < 20 && remaining !== 0; i++) {
        const result = await observer.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1",
          ["deskverse-pool-test"],
        )
        remaining = result.rows[0].n
        if (remaining !== 0) await new Promise((r) => setTimeout(r, 50))
      }
      expect(remaining).toBe(0)
    } finally {
      await observer.end()
    }
  })

  it("bounds a slow statement with the statement timeout", async () => {
    const pool = createPool(scratch.config, { statementTimeoutMs: 200 })
    try {
      const started = Date.now()
      const error = await pool.query("SELECT pg_sleep(5)").catch((e) => e)
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(classifyDatabaseError(error).failure).toBe("timeout")
    } finally {
      await pool.end()
    }
  })

  it("health reports a wrong password as a connection error, without details", async () => {
    const report = await checkDatabaseHealth(journal, {
      env: {
        DATABASE_URL: databaseUrl({
          ...scratch.config,
          password: "definitely-wrong",
        }),
      },
      log: () => {},
    })
    expect(report).toMatchObject({ status: "error", schema: null })
    expect(report.message).toMatch(/refused the password/)
    expect(JSON.stringify(report)).not.toMatch(
      new RegExp(
        `${scratch.config.user}|${scratch.config.database}|definitely`,
      ),
    )
  })

  it("health reports a missing database as an error", async () => {
    const report = await checkDatabaseHealth(journal, {
      env: {
        DATABASE_URL: databaseUrl({
          ...scratch.config,
          database: "deskverse_test_does_not_exist",
        }),
      },
      log: () => {},
    })
    expect(report.status).toBe("error")
    expect(report.message).toMatch(/doesn't exist yet/)
  })
})

describe("a failing migration", () => {
  let scratch: ScratchDatabase
  let folder: string

  beforeAll(async () => {
    scratch = await createScratchDatabase("badmig")
    folder = await mkdtemp(path.join(os.tmpdir(), "deskverse-migrations-"))
    await cp(migrationsFolder(), folder, { recursive: true })
  })
  afterAll(async () => {
    await scratch?.drop()
    if (folder) await rm(folder, { recursive: true, force: true })
  })

  it("rolls back, leaves the schema unchanged and explains why", async () => {
    // A second migration whose first statement works and second fails.
    await writeFile(
      path.join(folder, "0001_broken.sql"),
      'CREATE TABLE "half_done" ("id" integer);\n--> statement-breakpoint\nSELECT * FROM "no_such_table";\n',
    )
    const journalFile = path.join(folder, "meta", "_journal.json")
    const broken: Journal & { entries: object[] } = JSON.parse(
      await readFile(journalFile, "utf8"),
    )
    const entry = {
      idx: 1,
      version: "7",
      when: LAST_WHEN + 1000,
      tag: "0001_broken",
      breakpoints: true,
    }
    broken.entries.push(entry)
    await writeFile(journalFile, JSON.stringify(broken))
    const brokenJournal: Journal = {
      entries: [...journal.entries, entry],
    }

    const pool = createPool(scratch.config)
    try {
      const error = await runMigrations(pool, brokenJournal, folder).catch(
        (e: unknown) => e,
      )
      expect(error).toBeInstanceOf(MigrationError)
      expect((error as MigrationError).message).toMatch(
        /Migration failed and was rolled back; the schema is unchanged. PostgreSQL said: relation "no_such_table" does not exist/,
      )
      expect((error as MigrationError).code).toBe("42P01")
      // All-or-nothing: none of the pending migrations was kept, nor the half-done table.
      const tables = await pool.query(
        "SELECT to_regclass('public.half_done') AS half, to_regclass('public.app_metadata') AS meta",
      )
      expect(tables.rows[0]).toEqual({ half: null, meta: null })
      expect((await migrationStatus(pool, brokenJournal)).applied).toBe(0)

      // The real migrations still apply cleanly afterwards.
      expect(await runMigrations(pool, journal, migrationsFolder())).toEqual(
        TAGS,
      )
    } finally {
      await pool.end()
    }
  })

  it("refuses to migrate a database that newer code already migrated", async () => {
    const pool = createPool(scratch.config)
    try {
      await pool.query(
        'INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
        ["future", LAST_WHEN + 10_000],
      )
      await expect(
        runMigrations(pool, journal, migrationsFolder()),
      ).rejects.toThrow(/newer code/)
      expect((await migrationStatus(pool, journal)).ahead).toBe(true)
      const report = await checkDatabaseHealth(journal, {
        env: { DATABASE_URL: databaseUrl(scratch.config) },
      })
      expect(report.schema).toBe("ahead")
    } finally {
      await pool.end()
    }
  })

  it("explains a missing migrations folder", async () => {
    const pool = createPool(scratch.config)
    try {
      await expect(
        runMigrations(pool, journal, path.join(folder, "nope")),
      ).rejects.toThrow(/missing its meta\/_journal.json/)
    } finally {
      await pool.end()
    }
  })
})
