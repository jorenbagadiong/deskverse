/**
 * Database connection settings (DV-004A). Pure: reads only the environment
 * object it is given, never connects.
 *
 * Deskverse's PostgreSQL is local-only. A URL is accepted only when:
 * - its scheme is postgres:// or postgresql://
 * - its host is loopback (127.0.0.1, ::1 or localhost)
 * - it names a user, a password and a database
 * - it has no query string (which could otherwise redirect `host`, change
 *   TLS or authentication, or point at a Unix socket)
 *
 * Validation messages never repeat the URL, the user name or the password.
 * The parsed settings are passed to `pg` as separate fields rather than a
 * connection string, so the driver can't reinterpret anything.
 */

export type DatabaseUrlVariable = "DATABASE_URL" | "DATABASE_TEST_URL"

export interface DatabaseConfig {
  /** Which environment variable this came from (safe to show). */
  variable: DatabaseUrlVariable
  host: string
  port: number
  database: string
  user: string
  password: string
}

export type DatabaseConfigResult =
  | { ok: true; config: DatabaseConfig }
  | { ok: false; reason: "unconfigured" | "invalid"; message: string }

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

/** PostgreSQL identifiers Deskverse uses: lowercase, unquoted-safe. */
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

const EXAMPLE = "postgresql://USER:PASSWORD@127.0.0.1:5432/DATABASE"

/** Hides values that should never reach a log line or a response. */
export const SECRET_PLACEHOLDER = "REPLACE_ME"

export function parseDatabaseUrl(
  raw: string | undefined,
  variable: DatabaseUrlVariable,
): DatabaseConfigResult {
  const value = raw?.trim()
  if (!value)
    return {
      ok: false,
      reason: "unconfigured",
      message: `${variable} isn't set. Add it to .env.local (see .env.example).`,
    }
  const invalid = (problem: string): DatabaseConfigResult => ({
    ok: false,
    reason: "invalid",
    message: `${variable} ${problem} Expected ${EXAMPLE}.`,
  })

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return invalid("isn't a valid URL.")
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:")
    return invalid("must start with postgresql://.")
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase()))
    return invalid(
      "must point at this computer (127.0.0.1); Deskverse never connects to another machine.",
    )
  if (url.search !== "" || url.hash !== "")
    return invalid("must not have ?options or a #fragment.")

  const port = url.port === "" ? 5432 : Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return invalid("has an invalid port.")

  let user: string
  let password: string
  let database: string
  try {
    user = decodeURIComponent(url.username)
    password = decodeURIComponent(url.password)
    database = decodeURIComponent(url.pathname.replace(/^\//, ""))
  } catch {
    return invalid("has invalid %-escapes.")
  }
  if (!IDENTIFIER.test(user))
    return invalid(
      "needs a user name (lowercase letters, digits and underscores).",
    )
  if (password === "") return invalid("needs a password.")
  if (password === SECRET_PLACEHOLDER)
    return invalid(
      "still has the REPLACE_ME placeholder password from .env.example.",
    )
  if (!IDENTIFIER.test(database))
    return invalid(
      "needs a database name (lowercase letters, digits and underscores).",
    )

  return {
    ok: true,
    config: {
      variable,
      // `pg` takes the bare address; URL keeps IPv6 in brackets.
      host: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
      port,
      database,
      user,
      password,
    },
  }
}

/** Development/runtime database: DATABASE_URL only. */
export function readDatabaseConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseConfigResult {
  return parseDatabaseUrl(env.DATABASE_URL, "DATABASE_URL")
}

/** A description that is safe for logs and CLI output (no user or password). */
export function describeDatabase(config: DatabaseConfig) {
  return `${config.database} on ${config.host}:${config.port}`
}

/**
 * Removes anything that looks like a connection URL or the given password
 * from a message before it is logged.
 */
export function redact(message: string, ...secrets: string[]) {
  let text = message.replace(
    /postgres(?:ql)?:\/\/[^\s'"]*/gi,
    "postgresql://[redacted]",
  )
  for (const secret of secrets)
    if (secret.length > 0) text = text.split(secret).join("[redacted]")
  return text
}
