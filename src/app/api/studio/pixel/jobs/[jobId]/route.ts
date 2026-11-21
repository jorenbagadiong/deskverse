import { isRenderJobId } from "@/lib/video/ids"
import {
  guardLocalApi,
  jsonError,
  jsonResponse,
  requireNoBody,
} from "@/server/http/local-api"
import { renderErrorResponse } from "@/server/http/render-errors"
import { getRenderService } from "@/server/video/render-queue"
import { jobStatus } from "@/server/video/upload-verify"

/** GET /api/studio/pixel/jobs/:jobId: state, real progress and verified output. */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/studio/pixel/jobs/[jobId]">,
) {
  const denied = guardLocalApi(request)
  if (denied) return denied
  const { jobId } = await ctx.params
  if (!isRenderJobId(jobId))
    return jsonError(404, "not-found", "That video job doesn't exist.")
  try {
    const { storage, queue } = await getRenderService()
    const job = await storage.readJob(jobId)
    return jsonResponse(jobStatus(job, queue.progressOf(jobId)))
  } catch (error) {
    return renderErrorResponse(error)
  }
}

/**
 * DELETE /api/studio/pixel/jobs/:jobId (DV-003D1): deletes the job and
 * everything it owns (uploads, project, scratch files, video, metadata).
 * Refused (409) while it is queued or rendering: cancel it first.
 */
export async function DELETE(
  request: Request,
  ctx: RouteContext<"/api/studio/pixel/jobs/[jobId]">,
) {
  const denied = guardLocalApi(request) ?? (await requireNoBody(request))
  if (denied) return denied
  const { jobId } = await ctx.params
  if (!isRenderJobId(jobId))
    return jsonError(404, "not-found", "That video job doesn't exist.")
  try {
    const { queue } = await getRenderService()
    await queue.delete(jobId)
    return jsonResponse({ deleted: true })
  } catch (error) {
    return renderErrorResponse(error)
  }
}
