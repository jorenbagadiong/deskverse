import { ids, pool } from "@/server/orchestrator/http"
import { getRun } from "@/server/orchestrator/store"
import { handle, jsonResponse, notFound } from "@/server/tickets/http"

/** GET /api/tickets/:ticketId/runs/:runId → { run, products (with tasks), events }. Read-only. */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/tickets/[ticketId]/runs/[runId]">,
) {
  return handle(request, async () => {
    const { ticketId, runId } = ids(await ctx.params)
    const detail = await getRun(pool(), ticketId, runId)
    if (!detail) throw notFound("That workflow run isn't part of this ticket.")
    return jsonResponse(detail)
  })
}
