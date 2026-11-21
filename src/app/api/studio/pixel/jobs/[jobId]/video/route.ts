import { createReadStream } from "node:fs"
import { Readable } from "node:stream"

import type { NextRequest } from "next/server"

import { isRenderJobId } from "@/lib/video/ids"
import { guardLocalApi, jsonError } from "@/server/http/local-api"
import { downloadSlug, parseByteRange } from "@/server/http/range"
import { renderErrorResponse } from "@/server/http/render-errors"
import { getRenderService } from "@/server/video/render-queue"

/**
 * GET /api/studio/pixel/jobs/:jobId/video[?download=1]
 *
 * Streams a finished video only when the job is "completed", which the queue
 * sets only after FFprobe verified the file. Partial, failed or unverified
 * renders are never served. Supports byte ranges for seeking. The file's
 * location on disk is never revealed.
 */
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/studio/pixel/jobs/[jobId]/video">,
) {
  const denied = guardLocalApi(request)
  if (denied) return denied
  const { jobId } = await ctx.params
  if (!isRenderJobId(jobId))
    return jsonError(404, "not-found", "That video doesn't exist.")

  try {
    const { storage } = await getRenderService()
    const output = await storage.resolveCompletedOutput(jobId)
    if (!output)
      return jsonError(
        404,
        "not-ready",
        "This video isn't finished, or it didn't pass verification.",
      )

    let name = "pixel-video"
    try {
      name = downloadSlug((await storage.readProject(jobId)).product.name)
    } catch {
      // Fall back to the generic name.
    }
    const download = request.nextUrl.searchParams.get("download") === "1"
    const headers = new Headers({
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}-${jobId.slice(4, 12)}.mp4"`,
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
    return renderErrorResponse(error)
  }
}
