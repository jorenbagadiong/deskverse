import { TICKET_FILE_NAME_HEADER } from "@/lib/tickets/types"
import { isUuid } from "@/lib/tickets/validation"
import {
  dataRoot,
  database,
  handle,
  jsonResponse,
  mediaTools,
  notFound,
} from "@/server/tickets/http"
import { readMediaLimits, storeUpload } from "@/server/tickets/media"
import { getTicket } from "@/server/tickets/repository"

/**
 * POST …/products/:productId/assets  raw file body
 *   Content-Type: image/jpeg | image/png | image/webp | video/mp4
 *   X-File-Name: <URI-encoded original name> (display only)
 *
 * The body is streamed to a private staging file with the size limit
 * enforced as it arrives, identified by its bytes, verified with
 * FFprobe/FFmpeg, then committed (see src/server/tickets/media.ts).
 * Responds 201 with the stored asset. Client paths are never accepted.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/tickets/[ticketId]/products/[productId]/assets">,
) {
  return handle(request, async () => {
    const { ticketId, productId } = await ctx.params
    if (!isUuid(ticketId) || !isUuid(productId))
      throw notFound("That product isn't part of this ticket.")
    const db = database()
    // Cheap check before reading any bytes; enforced again under the lock.
    const ticket = await getTicket(db, ticketId)
    if (!ticket) throw notFound()
    if (!ticket.products.some((p) => p.id === productId))
      throw notFound("That product isn't part of this ticket.")
    if (ticket.status === "archived")
      return jsonResponse(
        {
          error: "archived",
          message: "This ticket is archived. Restore it to Draft to add files.",
        },
        409,
      )
    const tools = await mediaTools()
    let fileName = ""
    try {
      fileName = decodeURIComponent(
        request.headers.get(TICKET_FILE_NAME_HEADER) ?? "",
      )
    } catch {
      // Display only; keep the generic name.
    }
    const length = request.headers.get("content-length")
    const asset = await storeUpload({
      db,
      dataRoot: dataRoot(),
      ticketId,
      productId,
      body: request.body,
      declaredLength:
        length !== null && /^\d+$/.test(length) ? Number(length) : null,
      declaredType: (request.headers.get("content-type") ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase(),
      fileName,
      limits: readMediaLimits(),
      tools,
    })
    return jsonResponse({ asset }, 201)
  })
}
