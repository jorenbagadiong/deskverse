import { ids, pool } from "@/server/orchestrator/http"
import { getDeliverable } from "@/server/pixel/store"
import { handle, jsonResponse, notFound } from "@/server/tickets/http"

/**
 * GET /api/tickets/:ticketId/videos/:deliverableId (DV-005C) → one finished
 * video's technical facts (size, SHA-256, format, duration, disclosure
 * frame checks, script version). 404 unless it belongs to the ticket.
 * Never includes file paths.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/tickets/[ticketId]/videos/[deliverableId]">,
) {
  return handle(request, async () => {
    const { ticketId, deliverableId } = ids(await ctx.params)
    const found = await getDeliverable(pool(), ticketId, deliverableId)
    if (!found) throw notFound("That video isn't part of this ticket.")
    return jsonResponse(found.deliverable)
  })
}
