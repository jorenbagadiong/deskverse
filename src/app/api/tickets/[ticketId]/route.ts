import {
  isTicketStatus,
  isUuid,
  validateTicketPatch,
} from "@/lib/tickets/validation"
import {
  database,
  handle,
  invalid,
  jsonBody,
  jsonResponse,
  notFound,
  requireVersion,
} from "@/server/tickets/http"
import {
  changeStatus,
  getTicket,
  listEvents,
  updateTicket,
} from "@/server/tickets/repository"

/**
 * GET   /api/tickets/:ticketId  → { ticket, events }
 * PATCH /api/tickets/:ticketId  { version, fields: {...} }   edit (Draft/Ready)
 *                               { version, status: "draft"|"ready"|"archived" }
 * A stale `version` is refused with 409 (changed in another tab). Editing a
 * Ready ticket returns it to Draft. Archived tickets are read-only until
 * restored. There is deliberately no DELETE: archive instead.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/tickets/[ticketId]">,
) {
  return handle(request, async () => {
    const { ticketId } = await ctx.params
    if (!isUuid(ticketId)) throw notFound()
    const db = database()
    const ticket = await getTicket(db, ticketId)
    if (!ticket) throw notFound()
    return jsonResponse({ ticket, events: await listEvents(db, ticketId) })
  })
}

export async function PATCH(
  request: Request,
  ctx: RouteContext<"/api/tickets/[ticketId]">,
) {
  return handle(request, async () => {
    const { ticketId } = await ctx.params
    if (!isUuid(ticketId)) throw notFound()
    const body = await jsonBody(request)
    const version = requireVersion(body)
    const keys = Object.keys(body).filter((key) => key !== "version")
    const db = database()
    if (keys.length === 1 && keys[0] === "status") {
      if (!isTicketStatus(body.status))
        throw invalid([{ path: "status", message: "Unknown status." }])
      return jsonResponse({
        ticket: await changeStatus(db, ticketId, version, body.status),
      })
    }
    if (keys.length === 1 && keys[0] === "fields") {
      const patch = validateTicketPatch(body.fields)
      if (!patch.ok) throw invalid(patch.issues)
      return jsonResponse({
        ticket: await updateTicket(db, ticketId, version, patch.value),
      })
    }
    throw invalid([], "Send { version, fields } or { version, status }.")
  })
}
