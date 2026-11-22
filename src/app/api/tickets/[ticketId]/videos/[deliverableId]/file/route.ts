import { createReadStream } from "node:fs"
import { Readable } from "node:stream"

import type { NextRequest } from "next/server"

import { isUuid } from "@/lib/tickets/validation"
import { guardLocalApi, jsonError } from "@/server/http/local-api"
import { downloadSlug, parseByteRange } from "@/server/http/range"
import { pool } from "@/server/orchestrator/http"
import { getDeliverable, ticketRenderStorage } from "@/server/pixel/store"
import { errorResponse } from "@/server/tickets/http"
import { resolveDataRoot } from "@/server/video/storage"

/**
 * GET /api/tickets/:ticketId/videos/:deliverableId/file[?download=1]
 * (DV-005C). Streams a committed ticket video: only through its own
 * ticket, only a regular file inside the private ticket-render storage of
 * exactly its recorded size. Byte ranges for seeking; never a path.
 */
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/tickets/[ticketId]/videos/[deliverableId]/file">,
) {
  const denied = guardLocalApi(request)
  if (denied) return denied
  const { ticketId, deliverableId } = await ctx.params
  if (!isUuid(ticketId) || !isUuid(deliverableId))
    return jsonError(404, "not-found", "That video doesn't exist.")
  for (const key of request.nextUrl.searchParams.keys())
    if (key !== "download")
      return jsonError(400, "invalid", "Only download=1 is accepted.")
  try {
    const found = await getDeliverable(pool(), ticketId, deliverableId)
    if (!found)
      return jsonError(
        404,
        "not-found",
        "That video isn't part of this ticket.",
      )
    const output = await ticketRenderStorage(
      resolveDataRoot(),
    ).resolveCompletedOutput(found.pixelJobId as never)
    if (!output || output.sizeBytes !== found.deliverable.byteSize)
      return jsonError(
        410,
        "missing",
        "This video's file is missing or changed. Run yarn pixel:reconcile, or restore a backup.",
      )
    const download = request.nextUrl.searchParams.get("download") === "1"
    const name = `${downloadSlug(found.deliverable.productName)}-v${found.deliverable.version}`
    const headers = new Headers({
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}.mp4"`,
    })
    const range = parseByteRange(request.headers.get("range"), output.sizeBytes)
    if (range === "unsatisfiable") {
      headers.set("Content-Range", `bytes */${output.sizeBytes}`)
      return new Response(null, { status: 416, headers })
    }
    const start = range?.start ?? 0
    const end = range?.end ?? output.sizeBytes - 1
    headers.set("Content-Length", String(end - start + 1))
    if (range)
      headers.set("Content-Range", `bytes ${start}-${end}/${output.sizeBytes}`)
    const stream = Readable.toWeb(
      createReadStream(output.path, { start, end }),
    ) as ReadableStream<Uint8Array>
    return new Response(stream, { status: range ? 206 : 200, headers })
  } catch (error) {
    return errorResponse(error)
  }
}
