import { isUuid, validateProductPatch } from "@/lib/tickets/validation"
import {
  database,
  handle,
  invalid,
  jsonBody,
  jsonResponse,
  notFound,
} from "@/server/tickets/http"
import { addProduct } from "@/server/tickets/repository"

const REQUEST_ID = /^[A-Za-z0-9-]{16,64}$/

/**
 * POST /api/tickets/:ticketId/products  { requestId, ...product fields }
 * Adds a product at the end (fields may be empty in a Draft). A repeated
 * requestId returns the same product (200) instead of adding another.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/tickets/[ticketId]/products">,
) {
  return handle(request, async () => {
    const { ticketId } = await ctx.params
    if (!isUuid(ticketId)) throw notFound()
    const { requestId, ...fields } = await jsonBody(request)
    if (typeof requestId !== "string" || !REQUEST_ID.test(requestId))
      throw invalid([
        {
          path: "requestId",
          message: "Missing request identifier. Reload and try again.",
        },
      ])
    const product = validateProductPatch(fields)
    if (!product.ok) throw invalid(product.issues)
    const result = await addProduct(
      database(),
      ticketId,
      requestId,
      product.value,
    )
    return jsonResponse(
      { ticket: result.ticket, productId: result.productId },
      result.created ? 201 : 200,
    )
  })
}
