import { ids, pool } from "@/server/orchestrator/http"
import { listRunScripts } from "@/server/quill/store"
import { handle, invalid, jsonResponse, notFound } from "@/server/tickets/http"

/**
 * GET /api/tickets/:ticketId/runs/:runId/scripts?limit=100 (DV-005B) →
 * { scripts }: the scripts written by that run (≤ 100). 404 unless the run
 * belongs to the ticket. Read-only.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/tickets/[ticketId]/runs/[runId]/scripts">,
) {
  return handle(request, async () => {
    const { ticketId, runId } = ids(await ctx.params)
    const query = new URL(request.url).searchParams
    for (const key of query.keys())
      if (key !== "limit") throw invalid([], "Only limit is accepted.")
    const raw = query.get("limit") ?? "100"
    if (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > 100)
      throw invalid([], "limit must be between 1 and 100.")
    const run = await pool().query(
      "SELECT 1 FROM campaign_runs WHERE id = $1 AND ticket_id = $2",
      [runId, ticketId],
    )
    if (!run.rowCount)
      throw notFound("That workflow run isn't part of this ticket.")
    return jsonResponse({
      scripts: await listRunScripts(pool(), ticketId, runId, Number(raw)),
    })
  })
}
