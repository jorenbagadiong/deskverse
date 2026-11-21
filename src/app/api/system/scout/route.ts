import { guardLocalSystemApi, jsonResponse } from "@/server/http/local-api"
import { scoutDiagnostics } from "@/server/scout/http"

/**
 * GET /api/system/scout (DV-005A): read-only Scout diagnostics: whether
 * research is switched on, the extraction mode, the optional local model's
 * status (loopback only, checked at most every 15 s), whether a worker that
 * can run Scout checked in recently, and what configuration is missing.
 * Accepts no input; never cached; no passwords, headers, paths or page
 * contents. A configured model is not proof that research succeeded.
 */
export async function GET(request: Request) {
  const denied = guardLocalSystemApi(request)
  if (denied) return denied
  return jsonResponse(await scoutDiagnostics())
}
