import { TICKET_PLATFORMS, type TicketPlatform } from "@/lib/tickets/types"
import { approvalOffset, queryFields } from "@/server/approvals/input"
import { listApprovals } from "@/server/approvals/store"
import { pool } from "@/server/orchestrator/http"
import { handle, invalid, jsonResponse } from "@/server/tickets/http"

export async function GET(request: Request) {
  return handle(request, async () => {
    const params = new URL(request.url).searchParams
    queryFields(params, ["offset", "status", "platform", "search"])
    const status = params.get("status") ?? ""
    const platform = params.get("platform") ?? ""
    const search = params.get("search")?.trim() ?? ""
    if (
      ![
        "",
        "pending",
        "approved",
        "revision_requested",
        "rejected",
        "withdrawn",
        "needs_owner_input",
        "failed",
        "historical",
      ].includes(status) ||
      (platform && !TICKET_PLATFORMS.includes(platform as TicketPlatform)) ||
      search.length > 120 ||
      search.includes("\0")
    )
      throw invalid([], "Choose valid inbox filters.")
    return jsonResponse(
      await listApprovals(pool(), {
        offset: approvalOffset(params),
        status,
        platform,
        search,
      }),
    )
  })
}
