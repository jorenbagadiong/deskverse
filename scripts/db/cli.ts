import "../load-env"

import {
  describeDatabase,
  parseDatabaseUrl,
  readDatabaseConfig,
  redact,
  type DatabaseConfig,
  type DatabaseUrlVariable,
} from "@/server/db/config"

/** Shared helpers for the yarn db:* commands. */

export function fail(message: string): never {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

export function requireDatabase(
  variable: DatabaseUrlVariable = "DATABASE_URL",
): DatabaseConfig {
  const result =
    variable === "DATABASE_URL"
      ? readDatabaseConfig()
      : parseDatabaseUrl(process.env[variable], variable)
  if (!result.ok) fail(result.message)
  return result.config
}

/** Runs a command's main function; errors print without stack traces or secrets. */
export function run(main: () => Promise<void>, ...secrets: string[]) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    fail(redact(message, ...secrets))
  })
}

export { describeDatabase }
