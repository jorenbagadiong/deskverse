import { ids, pool } from "@/server/orchestrator/http"
import { researchAvailability } from "@/server/scout/http"
import { listResearch } from "@/server/scout/store"
import { handle, jsonResponse, notFound } from "@/server/tickets/http"

/**
 * GET /api/tickets/:ticketId/research (DV-005A) → { availability,
 * latestRun, reports }: whether research can start, the latest research
 * run's per-product task states (with per-source problems when a product
 * needs input), and every research brief version for the ticket (newest
 * first, at most 100). Read-only.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/tickets/[ticketId]/research">,
) {
  return handle(request, async () => {
    const { ticketId } = ids(await ctx.params)
    const exists = await pool().query(
      "SELECT 1 FROM affiliate_tickets WHERE id = $1",
      [ticketId],
    )
    if (!exists.rowCount) throw notFound()
    return jsonResponse({
      availability: researchAvailability(),
      ...(await listResearch(pool(), ticketId)),
    })
  })
}
