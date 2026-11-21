import { controlBody, ids, pool } from "@/server/orchestrator/http"
import { getRun, resumeRun } from "@/server/orchestrator/store"
import { handle, jsonResponse } from "@/server/tickets/http"

/**
 * POST /api/tickets/:ticketId/runs/:runId/resume  { requestId }
 * Idempotent per requestId; 409 if the run's state doesn't allow it.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/tickets/[ticketId]/runs/[runId]/resume">,
) {
  return handle(request, async () => {
    const { ticketId, runId } = ids(await ctx.params)
    const requestId = await controlBody(request)
    await resumeRun(pool(), ticketId, runId, requestId)
    return jsonResponse(await getRun(pool(), ticketId, runId))
  })
}
