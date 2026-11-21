import type { NextRequest } from "next/server"

import { parseListQuery, validateNewTicket } from "@/lib/tickets/validation"
import {
  database,
  handle,
  invalid,
  jsonBody,
  jsonResponse,
} from "@/server/tickets/http"
import { createTicket, listTickets } from "@/server/tickets/repository"

/**
 * GET  /api/tickets?status=active|all|draft|ready|archived&q=&page=&pageSize=
 *      Paginated summaries (at most 50 per page), newest change first.
 * POST /api/tickets  { requestId, title, description?, instructions?,
 *      priority?, platform?, publishingPreferences? }
 *      201 with the new ticket; 200 with the same ticket if requestId was
 *      already used (a repeated submission never creates a second ticket).
 *
 * Local-only (loopback guard), never cached; the database is only touched
 * when a request arrives, never during `next build`.
 */
export async function GET(request: NextRequest) {
  return handle(request, async () => {
    const query = parseListQuery(request.nextUrl.searchParams)
    if (!query.ok) throw invalid(query.issues, query.issues[0].message)
    return jsonResponse(await listTickets(database(), query.value))
  })
}

export async function POST(request: Request) {
  return handle(request, async () => {
    const input = validateNewTicket(await jsonBody(request))
    if (!input.ok) throw invalid(input.issues)
    const { ticket, created } = await createTicket(database(), input.value)
    return jsonResponse({ ticket }, created ? 201 : 200)
  })
}
