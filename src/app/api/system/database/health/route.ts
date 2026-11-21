import { guardLocalSystemApi, jsonResponse } from "@/server/http/local-api"
import { checkDatabaseHealth } from "@/server/db/health"
import { journal } from "@/server/db/journal"

/**
 * GET /api/system/database/health (DV-004A)
 *
 * Reports whether local PostgreSQL is ready: "ready", "unconfigured",
 * "offline" or "error", with a fixed, safe message. Read-only and bounded
 * (a 2.5 s check in a read-only session); accepts no input; never cached.
 *
 * Reading the request headers (the local-only guard) keeps this out of
 * build-time prerendering, so `next build` never connects.
 */
export async function GET(request: Request) {
  const denied = guardLocalSystemApi(request)
  if (denied) return denied
  return jsonResponse(await checkDatabaseHealth(journal))
}
