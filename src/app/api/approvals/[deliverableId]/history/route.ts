import {
  approvalId,
  approvalOffset,
  queryFields,
} from "@/server/approvals/input"
import { approvalHistory } from "@/server/approvals/store"
import { pool } from "@/server/orchestrator/http"
import { handle, jsonResponse, notFound } from "@/server/tickets/http"

export async function GET(
  request: Request,
  context: RouteContext<"/api/approvals/[deliverableId]/history">,
) {
  return handle(request, async () => {
    const params = new URL(request.url).searchParams
    queryFields(params, ["offset"])
    const id = approvalId((await context.params).deliverableId)
    const db = pool()
    if (
      !(await db.query("SELECT 1 FROM pixel_deliverables WHERE id=$1", [id]))
        .rowCount
    )
      throw notFound("This video version does not exist.")
    const history = await approvalHistory(db, id, approvalOffset(params))
    return jsonResponse({
      items: history.slice(0, 20),
      hasMore: history.length > 20,
    })
  })
}
