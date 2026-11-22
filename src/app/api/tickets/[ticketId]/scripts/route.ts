import { ids, pool } from "@/server/orchestrator/http"
import { readQuillConfig } from "@/server/quill/ollama"
import { quillOverview } from "@/server/quill/store"
import { handle, jsonResponse, notFound } from "@/server/tickets/http"

/**
 * GET /api/tickets/:ticketId/scripts (DV-005B) → { availability, products,
 * latestRun, scripts }: per product the Scout reports Quill could write
 * from (verified? still current? enough eligible facts?), the latest Quill
 * run's task states, and every script version (newest first, ≤ 100).
 * Read-only.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/tickets/[ticketId]/scripts">,
) {
  return handle(request, async () => {
    const { ticketId } = ids(await ctx.params)
    const exists = await pool().query(
      "SELECT 1 FROM affiliate_tickets WHERE id = $1",
      [ticketId],
    )
    if (!exists.rowCount) throw notFound()
    const config = readQuillConfig()
    return jsonResponse({
      availability: {
        available: true,
        mode: config.generation,
        reason:
          config.generation === "ollama" && !config.ollama
            ? `Local AI wording is configured but unusable (${config.ollamaProblem}); scripts use templates.`
            : null,
      },
      ...(await quillOverview(pool(), ticketId)),
    })
  })
}
