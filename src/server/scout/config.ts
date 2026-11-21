import type { DatabaseConfig } from "@/server/db/config"
import { isLoopbackUrl, type OllamaConfig } from "@/server/scout/ollama"

/**
 * Scout settings (DV-005A), from the environment (.env.local). Every
 * number is bounded; out-of-range values fall back to the default.
 *
 *   DESKVERSE_SCOUT_RETRIEVAL         "on" lets Scout fetch the reference
 *                                     URLs you add to products. Off by
 *                                     default: nothing leaves this computer
 *                                     until you turn it on.
 *   DESKVERSE_SCOUT_MAX_SOURCES       1–5        references read per product (5)
 *   DESKVERSE_SCOUT_MAX_PAGE_KB       64–5120    accepted bytes per page (2048)
 *   DESKVERSE_SCOUT_MAX_PRODUCT_KB    256–20480  bytes per product, all pages (8192)
 *   DESKVERSE_SCOUT_REQUEST_TIMEOUT_MS 1000–30000 per request (15 000)
 *   DESKVERSE_SCOUT_PRODUCT_TIMEOUT_MS 5000–300000 per product (120 000)
 *   DESKVERSE_SCOUT_HOST_INTERVAL_MS  0–60000    gap between requests to one host (1 000)
 *   DESKVERSE_SCOUT_EXTRACTION        "deterministic" (default) or "ollama"
 *   DESKVERSE_SCOUT_OLLAMA_URL        e.g. http://127.0.0.1:11434 (loopback only)
 *   DESKVERSE_SCOUT_OLLAMA_MODEL      an installed model name (never downloaded)
 *   DESKVERSE_SCOUT_OLLAMA_TIMEOUT_MS 1000–300000 (60 000)
 *
 * Test only (refused unless the database is a guarded test database):
 *   DESKVERSE_SCOUT_TEST_NETWORK      JSON describing fixture sites; see
 *                                     scripts/scout/fixture-sites.ts.
 */

type Env = Readonly<Record<string, string | undefined>>

function int(
  env: Env,
  name: string,
  min: number,
  max: number,
  fallback: number,
) {
  const raw = env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  return /^\d+$/.test(raw) && value >= min && value <= max ? value : fallback
}

export interface ScoutConfig {
  retrieval: boolean
  maxSources: number
  maxPageBytes: number
  maxProductBytes: number
  requestTimeoutMs: number
  productTimeoutMs: number
  hostIntervalMs: number
  extraction: "deterministic" | "ollama"
  ollama: OllamaConfig | null
  /** Why the Ollama settings were ignored, if they were. */
  ollamaProblem: string | null
}

export function readScoutConfig(env: Env = process.env): ScoutConfig {
  const extraction =
    env.DESKVERSE_SCOUT_EXTRACTION === "ollama" ? "ollama" : "deterministic"
  let ollama: OllamaConfig | null = null
  let ollamaProblem: string | null = null
  if (extraction === "ollama") {
    const url = env.DESKVERSE_SCOUT_OLLAMA_URL ?? ""
    const model = (env.DESKVERSE_SCOUT_OLLAMA_MODEL ?? "").trim()
    if (!url) ollamaProblem = "DESKVERSE_SCOUT_OLLAMA_URL isn't set."
    else if (!isLoopbackUrl(url))
      ollamaProblem =
        "DESKVERSE_SCOUT_OLLAMA_URL must be a plain http address on this computer (127.0.0.1, ::1 or localhost); Scout never uses a remote model."
    else if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(model))
      ollamaProblem = "DESKVERSE_SCOUT_OLLAMA_MODEL isn't set to a model name."
    else
      ollama = {
        url,
        model,
        timeoutMs: int(
          env,
          "DESKVERSE_SCOUT_OLLAMA_TIMEOUT_MS",
          1_000,
          300_000,
          60_000,
        ),
        maxPromptChars: 24_000,
        maxOutputTokens: 1_024,
      }
  }
  return {
    retrieval: env.DESKVERSE_SCOUT_RETRIEVAL === "on",
    maxSources: int(env, "DESKVERSE_SCOUT_MAX_SOURCES", 1, 5, 5),
    maxPageBytes:
      int(env, "DESKVERSE_SCOUT_MAX_PAGE_KB", 64, 5_120, 2_048) * 1024,
    maxProductBytes:
      int(env, "DESKVERSE_SCOUT_MAX_PRODUCT_KB", 256, 20_480, 8_192) * 1024,
    requestTimeoutMs: int(
      env,
      "DESKVERSE_SCOUT_REQUEST_TIMEOUT_MS",
      1_000,
      30_000,
      15_000,
    ),
    productTimeoutMs: int(
      env,
      "DESKVERSE_SCOUT_PRODUCT_TIMEOUT_MS",
      5_000,
      300_000,
      120_000,
    ),
    hostIntervalMs: int(
      env,
      "DESKVERSE_SCOUT_HOST_INTERVAL_MS",
      0,
      60_000,
      1_000,
    ),
    extraction,
    ollama,
    ollamaProblem,
  }
}

const TEST_DATABASE = /^deskverse_test(_[a-z0-9_]{1,40})?$/

/** The fixture network may only be used on a guarded test database. */
export function testNetworkAllowed(env: Env, database: DatabaseConfig | null) {
  return (
    Boolean(env.DESKVERSE_SCOUT_TEST_NETWORK) &&
    database !== null &&
    TEST_DATABASE.test(database.database) &&
    database.user.includes("test")
  )
}
