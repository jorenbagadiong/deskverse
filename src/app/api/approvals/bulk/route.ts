import { bulkInput, queryFields } from "@/server/approvals/input"
import { recordBulkDecisions } from "@/server/approvals/store"
import { pool } from "@/server/orchestrator/http"
import { dataRoot, handle, jsonBody, jsonResponse } from "@/server/tickets/http"

export async function POST(request: Request) {
  return handle(request, async () => {
    queryFields(new URL(request.url).searchParams, [])
    const items = bulkInput(await jsonBody(request))
    const db = pool()
    const root = dataRoot()
    return jsonResponse({ results: await recordBulkDecisions(db, items, root) })
  })
}
