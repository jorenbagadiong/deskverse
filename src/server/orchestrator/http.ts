import "server-only"

import type { WorkflowAvailability } from "@/lib/orchestrator/types"
import { isUuid } from "@/lib/tickets/validation"
import { getPool } from "@/server/db/client"
import { readDatabaseConfig } from "@/server/db/config"
import { verificationAllowed } from "@/server/orchestrator/config"
import {
  createRegistry,
  MISSING_PRODUCTION_CAPABILITIES,
  productionAvailable,
  PIXEL_WORKFLOW,
  QUILL_WORKFLOW,
  RESEARCH_WORKFLOW,
} from "@/server/orchestrator/workflows"
import { readScoutConfig } from "@/server/scout/config"
import { invalid, jsonBody, notFound } from "@/server/tickets/http"

/**
 * Shared plumbing for the workflow routes (DV-004C). The web app never runs
 * tasks: it only plans runs, changes their requested state and reads them.
 * Workers (`yarn worker:start`) do the work.
 */

export const pool = () => getPool()

/**
 * Production workflows this installation can run (DV-005A). The app never
 * executes them; it mirrors the worker's registration rule: Scout is
 * registered when source retrieval is switched on.
 */
export function availableWorkflows(): string[] {
  // Quill (DV-005B) needs no network or model: always available.
  return [
    ...(readScoutConfig().retrieval ? [RESEARCH_WORKFLOW.id] : []),
    QUILL_WORKFLOW.id,
    // Pixel (DV-005C): the worker registers it whenever FFmpeg is installed.
    PIXEL_WORKFLOW.id,
  ]
}

export function availability(): WorkflowAvailability {
  const config = readDatabaseConfig()
  return {
    production: productionAvailable(createRegistry({ verification: false })),
    research: availableWorkflows().includes(RESEARCH_WORKFLOW.id),
    missing: MISSING_PRODUCTION_CAPABILITIES.map((c) => ({
      stage: c.stage,
      milestone: c.milestone,
    })),
    verification: verificationAllowed(
      process.env,
      config.ok ? config.config : null,
    ),
  }
}

const REQUEST_ID = /^[A-Za-z0-9-]{16,64}$/

/** `{ requestId }` and nothing else (control actions). */
export async function controlBody(request: Request) {
  const body = await jsonBody(request)
  const extra = Object.keys(body).filter((k) => k !== "requestId")
  if (
    typeof body.requestId !== "string" ||
    !REQUEST_ID.test(body.requestId) ||
    extra.length > 0
  )
    throw invalid(
      [{ path: "requestId", message: "Send { requestId } only." }],
      "Send { requestId } only.",
    )
  return body.requestId
}

export function ids<T extends Record<string, string>>(params: T): T {
  for (const value of Object.values(params))
    if (!isUuid(value)) throw notFound("That workflow run doesn't exist.")
  return params
}
