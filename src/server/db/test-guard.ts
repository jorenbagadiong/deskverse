import { randomBytes } from "node:crypto"

import type { DatabaseConfig } from "@/server/db/config"

/**
 * Guards for anything that creates, empties or drops a database in tests
 * (DV-004A). Tests run against DATABASE_TEST_URL only, never DATABASE_URL,
 * and every destructive helper re-checks the target here first.
 *
 * Accepted test targets:
 * - the variable is DATABASE_TEST_URL
 * - the host is loopback (config.ts already insists)
 * - the database is `deskverse_test` or a scratch `deskverse_test_*`
 * - the user name contains "test"
 * - neither the user nor the database matches the development DATABASE_URL
 */

export const TEST_DATABASE = "deskverse_test"
const SCRATCH = /^deskverse_test_[a-z0-9_]{1,40}$/

export class UnsafeTestDatabaseError extends Error {
  constructor(message: string) {
    super(`Refusing to use this database for tests: ${message}`)
    this.name = "UnsafeTestDatabaseError"
  }
}

export function assertTestDatabase(
  test: DatabaseConfig,
  development?: DatabaseConfig | null,
) {
  if (test.variable !== "DATABASE_TEST_URL")
    throw new UnsafeTestDatabaseError(
      "tests only ever use DATABASE_TEST_URL, never DATABASE_URL.",
    )
  if (test.database !== TEST_DATABASE && !SCRATCH.test(test.database))
    throw new UnsafeTestDatabaseError(
      `the database must be "${TEST_DATABASE}" or start with "${TEST_DATABASE}_".`,
    )
  if (!test.user.includes("test"))
    throw new UnsafeTestDatabaseError(
      'the user name must contain "test" (a dedicated test role).',
    )
  if (development) {
    if (development.database === test.database)
      throw new UnsafeTestDatabaseError(
        "DATABASE_TEST_URL names the same database as DATABASE_URL.",
      )
    if (development.user === test.user)
      throw new UnsafeTestDatabaseError(
        "DATABASE_TEST_URL uses the same role as DATABASE_URL.",
      )
  }
}

/** True only for disposable scratch databases (never the base test database). */
export function isScratchDatabaseName(name: string) {
  return SCRATCH.test(name)
}

/**
 * A unique scratch database name, safe for parallel runs:
 * deskverse_test_<label>_<pid>_<random>.
 */
export function scratchDatabaseName(label: string, pid = process.pid) {
  const clean = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 16)
  const name = `${TEST_DATABASE}_${clean || "db"}_${pid}_${randomBytes(4).toString("hex")}`
  if (!isScratchDatabaseName(name))
    throw new UnsafeTestDatabaseError(`"${name}" isn't a scratch name.`)
  return name
}
