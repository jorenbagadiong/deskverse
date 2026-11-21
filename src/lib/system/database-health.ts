/**
 * The database health report the server sends to the browser (DV-004A).
 *
 * Deliberately holds no connection string, host, port, user name, database
 * name, file path, SQL or stack trace: only a status, a fixed message and
 * the schema state.
 */

export const DATABASE_HEALTH_ENDPOINT = "/api/system/database/health"

export type DatabaseHealthStatus =
  /** Connected and answering queries. */
  | "ready"
  /** DATABASE_URL is missing or invalid. */
  | "unconfigured"
  /** Nothing is listening (not installed, stopped) or it didn't answer in time. */
  | "offline"
  /** Reached PostgreSQL but it refused us (password, missing database, permissions…). */
  | "error"

export type DatabaseSchemaState =
  /** Every migration in this checkout is applied. */
  | "current"
  /** Some migrations still need `yarn db:migrate`. */
  | "pending"
  /** The database was migrated by newer code than this checkout. */
  | "ahead"

export interface DatabaseHealthReport {
  status: DatabaseHealthStatus
  message: string
  /** Only when status is "ready". */
  schema: DatabaseSchemaState | null
  /** ISO time of the check. */
  checkedAt: string
}

export const DATABASE_STATUS_LABEL: Record<DatabaseHealthStatus, string> = {
  ready: "Ready",
  unconfigured: "Not configured",
  offline: "Database not running",
  error: "Connection failed",
}

export function isDatabaseHealthReport(
  value: unknown,
): value is DatabaseHealthReport {
  if (typeof value !== "object" || value === null) return false
  const report = value as Record<string, unknown>
  return (
    typeof report.status === "string" &&
    report.status in DATABASE_STATUS_LABEL &&
    typeof report.message === "string" &&
    typeof report.checkedAt === "string" &&
    (report.schema === null ||
      report.schema === "current" ||
      report.schema === "pending" ||
      report.schema === "ahead")
  )
}
