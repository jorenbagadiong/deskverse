import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Reads named variables from one .env file without putting anything into
 * process.env (DV-004A). Database tests use it to read DATABASE_TEST_URL
 * from .env.local while keeping DATABASE_URL out of the test process
 * entirely. (Next.js's own loader skips .env.local when NODE_ENV is "test".)
 *
 * Supports the subset Deskverse writes: KEY=value, optional `export `, and
 * single or double quotes. No variable expansion.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    )
    if (!match) continue
    let value = match[2].trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote))
      value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, "")
    values[match[1]] = value
  }
  return values
}

export function readEnvFile(
  file = path.join(process.cwd(), ".env.local"),
): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(file, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
}
