import { ids, pool } from "@/server/orchestrator/http"
import { handle, invalid, jsonResponse, notFound } from "@/server/tickets/http"
import { veraOverview } from "@/server/vera/store"
import { veraTools } from "@/server/vera/tools"
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/tickets/[ticketId]/reviews">,
) {
  return handle(request, async () => {
    const { ticketId } = ids(await ctx.params)
    const search = new URL(request.url).searchParams
    if ([...search.keys()].some((k) => !["offset", "limit"].includes(k)))
      throw invalid([], "Only offset and limit are supported.")
    const offset = Number(search.get("offset") ?? 0),
      limit = Number(search.get("limit") ?? 20)
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 10000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw invalid([], "Use offset 0–10000 and limit 1–50.")
    if (
      !(
        await pool().query("SELECT 1 FROM affiliate_tickets WHERE id=$1", [
          ticketId,
        ])
      ).rowCount
    )
      throw notFound()
    const tools = await veraTools()
    return jsonResponse({
      availability: {
        available: Boolean(tools),
        reason: tools
          ? null
          : "Install local FFmpeg and FFprobe, then restart the worker.",
      },
      ...(await veraOverview(pool(), ticketId, offset, limit)),
    })
  })
}
