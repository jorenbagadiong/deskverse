import { approvalId, queryFields } from "@/server/approvals/input"
import { approvalEligibility } from "@/server/approvals/store"
import { pool } from "@/server/orchestrator/http"
import { dataRoot, handle, jsonResponse } from "@/server/tickets/http"

export async function GET(
  request: Request,
  context: RouteContext<"/api/approvals/[deliverableId]">,
) {
  return handle(request, async () => {
    queryFields(new URL(request.url).searchParams, [])
    return jsonResponse(
      await approvalEligibility(
        pool(),
        approvalId((await context.params).deliverableId),
        dataRoot(),
      ),
    )
  })
}
