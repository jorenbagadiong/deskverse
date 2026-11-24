import {
  approvalId,
  decisionInput,
  queryFields,
} from "@/server/approvals/input"
import { recordDecision } from "@/server/approvals/store"
import { pool } from "@/server/orchestrator/http"
import { dataRoot, handle, jsonBody, jsonResponse } from "@/server/tickets/http"

export async function POST(
  request: Request,
  context: RouteContext<"/api/approvals/[deliverableId]/decisions">,
) {
  return handle(request, async () => {
    queryFields(new URL(request.url).searchParams, [])
    const id = approvalId((await context.params).deliverableId)
    return jsonResponse(
      await recordDecision(
        pool(),
        id,
        decisionInput(await jsonBody(request)),
        dataRoot(),
      ),
    )
  })
}
