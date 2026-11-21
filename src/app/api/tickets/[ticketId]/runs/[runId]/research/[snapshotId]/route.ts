import { ids, pool } from "@/server/orchestrator/http"
import { getResearchReport } from "@/server/scout/store"
import { handle, invalid, jsonResponse, notFound } from "@/server/tickets/http"

/**
 * GET /api/tickets/:ticketId/runs/:runId/research/:snapshotId (DV-005A)
 *   ?evidenceOffset=0&evidenceLimit=100
 * → the research brief for that product snapshot of that run: sources,
 * claims (with evidence keys), a page of evidence passages (≤ 100) and an
 * integrity check (the checksum is recomputed from the stored rows).
 * 404 unless the snapshot belongs to the run and the run to the ticket.
 * Read-only. Passages are plain text; the page must render them escaped.
 */
const COUNT = /^(0|[1-9][0-9]{0,4})$/

export async function GET(
  request: Request,
  ctx: RouteContext<"/api/tickets/[ticketId]/runs/[runId]/research/[snapshotId]">,
) {
  return handle(request, async () => {
    const { ticketId, runId, snapshotId } = ids(await ctx.params)
    const query = new URL(request.url).searchParams
    for (const key of query.keys())
      if (key !== "evidenceOffset" && key !== "evidenceLimit")
        throw invalid([], "Only evidenceOffset and evidenceLimit are accepted.")
    const offset = query.get("evidenceOffset") ?? "0"
    const limit = query.get("evidenceLimit") ?? "100"
    if (
      !COUNT.test(offset) ||
      !COUNT.test(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 100
    )
      throw invalid(
        [],
        "evidenceOffset must be 0 or more and evidenceLimit between 1 and 100.",
      )
    const report = await getResearchReport(
      pool(),
      ticketId,
      runId,
      snapshotId,
      {
        offset: Number(offset),
        limit: Number(limit),
      },
    )
    if (!report)
      throw notFound("There's no research brief for that product in this run.")
    return jsonResponse(report)
  })
}
