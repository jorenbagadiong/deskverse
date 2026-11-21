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
} from "@/server/orchestrator/workflows"
import { invalid, jsonBody, notFound } from "@/server/tickets/http"

/**
 * Shared plumbing for the workflow routes (DV-004C). The web app never runs
 * tasks: it only plans runs, changes their requested state and reads them.
 * Workers (`yarn worker:start`) do the work.
 */

export const pool = () => getPool()

export function availability(): WorkflowAvailability {
  const config = readDatabaseConfig()
  return {
    production: productionAvailable(createRegistry({ verification: false })),
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
