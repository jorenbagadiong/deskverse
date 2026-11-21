import pg from "pg"

import { parseDatabaseUrl, type DatabaseConfig } from "@/server/db/config"
import { readEnvFile } from "@/server/db/env-file"
import {
  assertTestDatabase,
  isScratchDatabaseName,
  scratchDatabaseName,
} from "@/server/db/test-guard"

/**
 * Guarded access to the test database (DV-004A).
 *
 * Read once per test worker, before any test:
 * - DATABASE_TEST_URL from the environment, else from .env.local.
 * - DATABASE_URL only to prove the test target is different; it is then
 *   deleted from process.env so no code under test can reach the owner's
 *   development database by accident.
 */
const fromFile = readEnvFile()
const testRaw = process.env.DATABASE_TEST_URL || fromFile.DATABASE_TEST_URL
const devRaw = process.env.DATABASE_URL || fromFile.DATABASE_URL
delete process.env.DATABASE_URL
delete process.env.DATABASE_TEST_URL

const devResult = parseDatabaseUrl(devRaw, "DATABASE_URL")
const development = devResult.ok ? devResult.config : null

export function testDatabase(): DatabaseConfig {
  const result = parseDatabaseUrl(testRaw, "DATABASE_TEST_URL")
  if (!result.ok)
    throw new Error(
      `${result.message} Run scripts/db/setup-local.sh. The database tests were NOT run.`,
    )
  assertTestDatabase(result.config, development)
  return result.config
}

/** The development database's name, for isolation checks (never its credentials). */
export const developmentDatabaseName = development?.database ?? "deskverse"

export function databaseUrl(config: DatabaseConfig) {
  return `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${config.database}`
}

export function client(config: DatabaseConfig) {
  const c = new pg.Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionTimeoutMillis: 5_000,
  })
  c.on("error", () => {})
  return c
}

export interface ScratchDatabase {
  config: DatabaseConfig
  drop(): Promise<void>
}

/**
 * Creates an empty, uniquely named scratch database owned by the test role.
 * drop() only ever drops names that pass isScratchDatabaseName.
 */
export async function createScratchDatabase(
  label: string,
): Promise<ScratchDatabase> {
  const base = testDatabase()
  const name = scratchDatabaseName(label)
  const admin = client(base)
  await admin.connect()
  try {
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)}`)
  } finally {
    await admin.end()
  }
  const config: DatabaseConfig = { ...base, database: name }
  assertTestDatabase(config, development)
  return {
    config,
    async drop() {
      if (!isScratchDatabaseName(name))
        throw new Error(`Refusing to drop ${name}: not a scratch database.`)
      const c = client(base)
      await c.connect()
      try {
        await c.query(
          `DROP DATABASE IF EXISTS ${c.escapeIdentifier(name)} WITH (FORCE)`,
        )
      } finally {
        await c.end()
      }
    },
  }
}
