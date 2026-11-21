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

/**
 * POST /api/studio/pixel/jobs/:jobId/cancel (DV-003D1)
 *
 * A queued job is removed from the queue and never starts. A rendering job's
 * FFmpeg processes are stopped and awaited; the answer is sent once the
 * job's final state is stored ("cancelled", or "completed" if it had already
 * finished). Cancelling a cancelled job again is harmless.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/studio/pixel/jobs/[jobId]/cancel">,
) {
  const denied = guardLocalApi(request) ?? (await requireNoBody(request))
  if (denied) return denied
  const { jobId } = await ctx.params
  if (!isRenderJobId(jobId))
    return jsonError(404, "not-found", "That video job doesn't exist.")
  try {
    const { queue } = await getRenderService()
    const job = await queue.cancel(jobId)
    return jsonResponse(jobStatus(job, queue.progressOf(jobId)))
  } catch (error) {
    return renderErrorResponse(error)
  }
}
