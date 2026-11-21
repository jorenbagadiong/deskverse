import { isRenderJobId } from "@/lib/video/ids"
import {
  guardLocalApi,
  jsonError,
  jsonResponse,
  readJsonBody,
  requireJson,
} from "@/server/http/local-api"
import { renderErrorResponse } from "@/server/http/render-errors"
import { getFfmpegCapabilities } from "@/server/video/ffmpeg-capabilities"
import { loadVideoFont } from "@/server/video/font-metrics"
import { buildTrustedProject } from "@/server/video/project"
import { getRenderService } from "@/server/video/render-queue"
import { jobStatus } from "@/server/video/upload-verify"

/**
 * POST /api/studio/pixel/jobs/:jobId/render with `{ product, assetIds, audio? }`.
 *
 * Rebuilds the storyboard on the server from validated text and this job's
 * own uploads, stores it, and queues the render. Answers immediately with the
 * job status; the browser then polls GET /jobs/:jobId.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/studio/pixel/jobs/[jobId]/render">,
) {
  const denied = guardLocalApi(request) ?? requireJson(request)
  if (denied) return denied
  const { jobId } = await ctx.params
  if (!isRenderJobId(jobId))
    return jsonError(404, "not-found", "That video job doesn't exist.")

  const body = await readJsonBody(request, 32 * 1024)
  if (!body.ok) return body.response

  const capabilities = await getFfmpegCapabilities()
  if (capabilities.status !== "ready" || !capabilities.selectedH264Encoder)
    return jsonError(
      503,
      "ffmpeg-unavailable",
      capabilities.issues.find((i) => i.severity === "error")?.message ??
        "FFmpeg isn't ready to render on this computer.",
    )

  try {
    const { storage, queue } = await getRenderService()
    const job = await storage.readJob(jobId)
    if (job.state !== "draft")
      return jsonError(
        409,
        "invalid-state",
        "This video has already been sent for rendering.",
      )
    const project = buildTrustedProject(job, body.value, {
      bold: loadVideoFont("bold"),
      medium: loadVideoFont("medium"),
    })
    if (!project.ok)
      return jsonResponse(
        {
          error: "invalid-project",
          message: project.issues[0].message,
          issues: project.issues,
        },
        422,
      )
    if (
      project.value.audio &&
      project.value.audio.mode !== "none" &&
      !capabilities.audio.ready
    )
      return jsonError(
        503,
        "audio-unavailable",
        capabilities.audio.reason ??
          "Audio isn't available with this FFmpeg build. Choose No audio.",
      )
    await storage.writeProject(jobId, project.value)
    const queued = await queue.enqueue(jobId)
    return jsonResponse(jobStatus(queued, queue.progressOf(jobId)), 202)
  } catch (error) {
    return renderErrorResponse(error)
  }
}
