import { controlBody, ids, pool } from "@/server/orchestrator/http"
import { getRun, retryTask } from "@/server/orchestrator/store"
import { handle, jsonResponse } from "@/server/tickets/http"

/**
 * POST /api/tickets/:ticketId/runs/:runId/tasks/:taskId/retry  { requestId }
 * Retries a failed or needs-input task (and unblocks what depended on it).
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/tickets/[ticketId]/runs/[runId]/tasks/[taskId]/retry">,
) {
  return handle(request, async () => {
    const { ticketId, runId, taskId } = ids(await ctx.params)
    const requestId = await controlBody(request)
    await retryTask(pool(), ticketId, runId, taskId, requestId)
    return jsonResponse(await getRun(pool(), ticketId, runId))
  })
}
