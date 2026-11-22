import { ids, pool } from "@/server/orchestrator/http"
import { handle, jsonResponse, notFound } from "@/server/tickets/http"
import { getReview } from "@/server/vera/store"
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/tickets/[ticketId]/reviews/[reviewId]">,
) {
  return handle(request, async () => {
    const { ticketId, reviewId } = ids(await ctx.params)
    const review = await getReview(pool(), ticketId, reviewId)
    if (!review)
      throw notFound("That Vera review does not belong to this ticket.")
    return jsonResponse(review)
  })
}
