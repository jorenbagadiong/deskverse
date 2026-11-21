import { isUuid, validateProductPatch } from "@/lib/tickets/validation"
import { requireNoBody } from "@/server/http/local-api"
import {
  dataRoot,
  database,
  handle,
  invalid,
  jsonBody,
  jsonResponse,
  notFound,
} from "@/server/tickets/http"
import { deleteAssetFile } from "@/server/tickets/media"
import { removeProduct, updateProduct } from "@/server/tickets/repository"

type Ctx = RouteContext<"/api/tickets/[ticketId]/products/[productId]">

async function ids(ctx: Ctx) {
  const { ticketId, productId } = await ctx.params
  if (!isUuid(ticketId) || !isUuid(productId))
    throw notFound("That product isn't part of this ticket.")
  return { ticketId, productId }
}

/**
 * PATCH  …/products/:productId  { ...product fields, references?, position? }
 *        `references` replaces the product's whole list; `position` (0-based)
 *        moves the product. Only fields that actually change are recorded.
 * DELETE …/products/:productId  removes the product, its references and
 *        media (records first, then files). Refused for archived tickets.
 */
export async function PATCH(request: Request, ctx: Ctx) {
  return handle(request, async () => {
    const { ticketId, productId } = await ids(ctx)
    const { position, ...fields } = await jsonBody(request)
    if (
      position !== undefined &&
      (typeof position !== "number" ||
        !Number.isSafeInteger(position) ||
        position < 0)
    )
      throw invalid([
        {
          path: "position",
          message: "Position must be a whole number from 0.",
        },
      ])
    const product = validateProductPatch(fields)
    if (!product.ok) throw invalid(product.issues)
    return jsonResponse({
      ticket: await updateProduct(
        database(),
        ticketId,
        productId,
        product.value,
        position as number | undefined,
      ),
    })
  })
}

export async function DELETE(request: Request, ctx: Ctx) {
  return handle(request, async () => {
    const refused = await requireNoBody(request)
    if (refused) return refused
    const { ticketId, productId } = await ids(ctx)
    const { ticket, removedAssets } = await removeProduct(
      database(),
      ticketId,
      productId,
    )
    const root = dataRoot()
    for (const asset of removedAssets) await deleteAssetFile(root, asset)
    return jsonResponse({ ticket })
  })
}
