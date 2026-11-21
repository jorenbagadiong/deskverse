import "server-only"

import type { ResearchAvailability, ScoutDiagnostics } from "@/lib/scout/types"
import { getPool } from "@/server/db/client"
import { readDatabaseConfig } from "@/server/db/config"
import {
  productionAvailable,
  createRegistry,
  MISSING_PRODUCTION_CAPABILITIES,
  RESEARCH_WORKFLOW,
} from "@/server/orchestrator/workflows"
import { readScoutConfig } from "@/server/scout/config"
import { ollamaStatus, type OllamaStatus } from "@/server/scout/ollama"

/**
 * Scout availability and read-only diagnostics for the app (DV-005A).
 * Nothing here fetches a source or runs research: the worker does that.
 * Responses never include passwords, request headers, file paths or
 * downloaded content.
 */

export function researchAvailability(): ResearchAvailability {
  const c = readScoutConfig()
  return {
    available: c.retrieval,
    retrieval: c.retrieval,
    extraction: c.extraction,
    reason: c.retrieval
      ? null
      : "Source retrieval is off, so Scout can't read reference pages. Set DESKVERSE_SCOUT_RETRIEVAL=on in .env.local, then restart the app and the worker.",
  }
}

let ollamaCache: { at: number; key: string; value: OllamaStatus } | null = null

/** The configured local model's status, checked at most every 15 s. */
async function cachedOllama(
  config: NonNullable<ReturnType<typeof readScoutConfig>["ollama"]>,
) {
  const key = `${config.url}|${config.model}`
  if (
    ollamaCache &&
    ollamaCache.key === key &&
    Date.now() - ollamaCache.at < 15_000
  )
    return ollamaCache.value
  const value = await ollamaStatus(config)
  ollamaCache = { at: Date.now(), key, value }
  return value
}

export async function scoutDiagnostics(): Promise<ScoutDiagnostics> {
  const c = readScoutConfig()
  const missing: string[] = []
  if (!c.retrieval)
    missing.push(
      "Source retrieval is off: set DESKVERSE_SCOUT_RETRIEVAL=on in .env.local and restart the app and the worker.",
    )
  let ollama: ScoutDiagnostics["extraction"]["ollama"] = {
    configured: false,
    endpoint: null,
    model: null,
    reachable: null,
    modelAvailable: null,
    version: null,
    problem: null,
  }
  if (c.extraction === "ollama") {
    if (!c.ollama) {
      ollama = { ...ollama, problem: c.ollamaProblem }
      missing.push(`Local model: ${c.ollamaProblem}`)
    } else {
      const status = await cachedOllama(c.ollama)
      const u = new URL(c.ollama.url)
      ollama = {
        configured: true,
        endpoint: `${u.hostname}:${u.port || "80"}`,
        model: c.ollama.model,
        reachable: status.reachable,
        modelAvailable: status.modelAvailable,
        version: status.version,
        problem: status.problem,
      }
      if (status.problem) missing.push(`Local model: ${status.problem}`)
    }
  }
  let worker: ScoutDiagnostics["worker"] = {
    status: "unknown",
    lastSeenSecondsAgo: null,
    handlesResearch: false,
  }
  if (readDatabaseConfig().ok)
    try {
      const { rows } = await getPool().query<{
        any: number | null
        scout: number | null
      }>(
        `SELECT extract(epoch FROM now() - max(last_seen_at))::int AS any,
                extract(epoch FROM now() - max(last_seen_at) FILTER (WHERE 'scout.research' = ANY(stages)))::int AS scout
           FROM orchestrator_workers`,
      )
      const ago = rows[0]?.scout ?? rows[0]?.any ?? null
      worker = {
        status: ago !== null && ago <= 15 ? "running" : "not_seen",
        lastSeenSecondsAgo: ago,
        handlesResearch:
          rows[0]?.scout !== null &&
          rows[0]?.scout !== undefined &&
          rows[0].scout <= 15,
      }
    } catch {
      worker = {
        status: "unknown",
        lastSeenSecondsAgo: null,
        handlesResearch: false,
      }
    }
  if (worker.status !== "running")
    missing.push(
      "No worker has checked in during the last 15 seconds: start one with yarn worker:start.",
    )
  else if (c.retrieval && !worker.handlesResearch)
    missing.push(
      "The running worker can't do research: restart it after turning on DESKVERSE_SCOUT_RETRIEVAL.",
    )
  return {
    handlerRegistered: c.retrieval,
    retrieval: {
      enabled: c.retrieval,
      maxSources: c.maxSources,
      maxPageKB: Math.round(c.maxPageBytes / 1024),
    },
    extraction: { mode: c.extraction, ollama },
    researchWorkflow: { id: RESEARCH_WORKFLOW.id, available: c.retrieval },
    fullCampaign: {
      available: productionAvailable(createRegistry({ verification: false })),
      missing: MISSING_PRODUCTION_CAPABILITIES.map(
        (m) => m.milestone.split(" ")[0],
      ),
    },
    worker,
    missingConfiguration: missing,
  }
}
