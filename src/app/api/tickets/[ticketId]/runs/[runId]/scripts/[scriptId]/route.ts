import { ids, pool } from "@/server/orchestrator/http"
import { getScript } from "@/server/quill/store"
import { handle, jsonResponse, notFound } from "@/server/tickets/http"

/**
 * GET /api/tickets/:ticketId/runs/:runId/scripts/:scriptId (DV-005B) → the
 * full script: scenes, captions, narration, visual directions, claim and
 * evidence links, disclosure, Pixel checks, findings, and an integrity
 * check (the checksum is recomputed from the stored rows). 404 unless the
 * script belongs to the run and the run to the ticket. Plain text only;
 * the page renders it escaped.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/tickets/[ticketId]/runs/[runId]/scripts/[scriptId]">,
) {
  return handle(request, async () => {
    const { ticketId, runId, scriptId } = ids(await ctx.params)
    const script = await getScript(pool(), ticketId, runId, scriptId)
    if (!script) throw notFound("There's no such script in this run.")
    return jsonResponse(script)
  })
}
