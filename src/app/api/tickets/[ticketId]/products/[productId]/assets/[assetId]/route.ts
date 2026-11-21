import { createReadStream } from "node:fs"
import { Readable } from "node:stream"

import type { NextRequest } from "next/server"

import { isUuid } from "@/lib/tickets/validation"
import { requireNoBody } from "@/server/http/local-api"
import { downloadSlug, parseByteRange } from "@/server/http/range"
import {
  dataRoot,
  database,
  handle,
  jsonResponse,
  notFound,
} from "@/server/tickets/http"
import { deleteAssetFile, openAssetFile } from "@/server/tickets/media"
import { findAsset, removeAssetRecord } from "@/server/tickets/repository"

type Ctx =
  RouteContext<"/api/tickets/[ticketId]/products/[productId]/assets/[assetId]">

async function ids(ctx: Ctx) {
  const { ticketId, productId, assetId } = await ctx.params
  if (!isUuid(ticketId) || !isUuid(productId) || !isUuid(assetId))
    throw notFound("That file isn't attached to this product.")
  return { ticketId, productId, assetId }
}

/**
 * GET …/assets/:assetId[?download=1]  streams the file (byte ranges for
 * video seeking). Served only when the asset belongs to that product of
 * that ticket, and the file on disk is a regular file of the recorded size.
 * Sandboxed, never sniffed, never cached; the disk path is never revealed.
 */
export async function GET(request: NextRequest, ctx: Ctx) {
  return handle(request, async () => {
    const { ticketId, productId, assetId } = await ids(ctx)
    const asset = await findAsset(database(), ticketId, productId, assetId)
    if (!asset) throw notFound("That file isn't attached to this product.")
    const { file, size } = await openAssetFile(dataRoot(), asset)
    const download = request.nextUrl.searchParams.get("download") === "1"
    const name = `${downloadSlug(asset.originalName.replace(/\.[^.]*$/, ""), "ticket-media")}.${asset.extension}`
    const headers = new Headers({
      "Content-Type": asset.mimeType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
    })
    const range = parseByteRange(request.headers.get("range"), size)
    if (range === "unsatisfiable") {
      headers.set("Content-Range", `bytes */${size}`)
      return new Response(null, { status: 416, headers })
    }
    const start = range?.start ?? 0
    const end = range?.end ?? size - 1
    headers.set("Content-Length", String(end - start + 1))
    if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`)
    const stream = Readable.toWeb(
      createReadStream(file, { start, end }),
    ) as ReadableStream<Uint8Array>
    return new Response(stream, { status: range ? 206 : 200, headers })
  })
}

/** DELETE …/assets/:assetId  removes the record, then the file. */
export async function DELETE(request: Request, ctx: Ctx) {
  return handle(request, async () => {
    const refused = await requireNoBody(request)
    if (refused) return refused
    const { ticketId, productId, assetId } = await ids(ctx)
    const removed = await removeAssetRecord(
      database(),
      ticketId,
      productId,
      assetId,
    )
    await deleteAssetFile(dataRoot(), removed)
    return jsonResponse({ removed: assetId })
  })
}
