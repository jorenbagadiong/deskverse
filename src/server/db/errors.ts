/**
 * Turns driver errors into a fixed set of safe, actionable messages
 * (DV-004A). Raw PostgreSQL errors can include user names, database names,
 * host details or SQL; none of that is ever returned to a browser.
 */

export type DatabaseFailure =
  | "offline"
  | "timeout"
  | "authentication"
  | "missing-database"
  | "permission"
  | "schema"
  | "error"

export interface ClassifiedDatabaseError {
  failure: DatabaseFailure
  /** Safe for any audience: no names, paths, SQL or stack traces. */
  message: string
}

const MESSAGES: Record<DatabaseFailure, string> = {
  offline:
    "Local PostgreSQL isn't running. Start it with: sudo systemctl start postgresql",
  timeout:
    "Local PostgreSQL didn't answer in time. Check it with: sudo systemctl status postgresql",
  authentication:
    "Local PostgreSQL refused the password in .env.local. Run scripts/db/setup-local.sh again to reset it.",
  "missing-database":
    "The Deskverse database doesn't exist yet. Run scripts/db/setup-local.sh.",
  permission:
    "The Deskverse database role isn't allowed to do that. Run scripts/db/setup-local.sh to repair its permissions.",
  schema:
    "The Deskverse database schema is missing or out of date. Run: yarn db:migrate",
  error: "Local PostgreSQL reported an unexpected error.",
}

/** Connection-level errors from Node's socket layer. */
const OFFLINE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
])

/** PostgreSQL SQLSTATE codes (https://www.postgresql.org/docs/current/errcodes-appendix.html). */
const SQLSTATE: Record<string, DatabaseFailure> = {
  "28P01": "authentication", // invalid_password
  "28000": "authentication", // invalid_authorization_specification (no pg_hba rule)
  "3D000": "missing-database", // invalid_catalog_name
  "42501": "permission", // insufficient_privilege
  "42P01": "schema", // undefined_table
  "3F000": "schema", // invalid_schema_name
  "57P01": "offline", // admin_shutdown
  "57P02": "offline", // crash_shutdown
  "57P03": "offline", // cannot_connect_now (starting up / shutting down)
  "57014": "timeout", // query_canceled (statement_timeout)
}

export function classifyDatabaseError(error: unknown): ClassifiedDatabaseError {
  const failure = failureOf(error)
  return { failure, message: MESSAGES[failure] }
}

function failureOf(error: unknown): DatabaseFailure {
  if (typeof error !== "object" || error === null) return "error"
  // AggregateError (both 127.0.0.1 and ::1 refused) and wrapped causes.
  const nested =
    (error as { errors?: unknown[] }).errors?.[0] ??
    (error as { cause?: unknown }).cause
  const code = (error as { code?: unknown }).code
  if (typeof code === "string") {
    if (OFFLINE_CODES.has(code)) return "offline"
    if (code === "ETIMEDOUT") return "timeout"
    if (code in SQLSTATE) return SQLSTATE[code]
  }
  const message = String((error as { message?: unknown }).message ?? "")
  if (/timeout|timed out/i.test(message)) return "timeout"
  if (/Connection terminated/i.test(message)) return "offline"
  if (nested !== undefined && nested !== error) return failureOf(nested)
  return "error"
}

export function databaseFailureMessage(failure: DatabaseFailure) {
  return MESSAGES[failure]
}
