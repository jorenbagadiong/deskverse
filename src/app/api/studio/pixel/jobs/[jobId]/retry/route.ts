import {
  missingEffectFilters,
  missingEffectsMessage,
  STATIC_EFFECTS,
} from "@/lib/video/effects"
import { isRenderJobId } from "@/lib/video/ids"
import {
  guardLocalApi,
  jsonError,
  jsonResponse,
  requireNoBody,
} from "@/server/http/local-api"
import { renderErrorResponse } from "@/server/http/render-errors"
import { getFfmpegCapabilities } from "@/server/video/ffmpeg-capabilities"
import { getRenderService } from "@/server/video/render-queue"
import { jobStatus } from "@/server/video/upload-verify"

/**
 * POST /api/studio/pixel/jobs/:jobId/retry (DV-003D1)
 *
 * Re-queues a failed or interrupted job with its stored uploads and
 * server-built project (no re-upload). Refused for completed, cancelled,
 * queued or rendering jobs, when files are missing, or when FFmpeg (or, for
 * audio projects, AAC) isn't ready.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/studio/pixel/jobs/[jobId]/retry">,
) {
  const denied = guardLocalApi(request) ?? (await requireNoBody(request))
  if (denied) return denied
  const { jobId } = await ctx.params
  if (!isRenderJobId(jobId))
    return jsonError(404, "not-found", "That video job doesn't exist.")
  try {
    const { storage, queue } = await getRenderService()
    const capabilities = await getFfmpegCapabilities({ refresh: true })
    if (capabilities.status !== "ready" || !capabilities.selectedH264Encoder)
      return jsonError(
        503,
        "ffmpeg-unavailable",
        capabilities.issues.find((i) => i.severity === "error")?.message ??
          "FFmpeg isn't ready to render on this computer.",
      )
    const job = await storage.readJob(jobId)
    if (job.state === "failed") {
      const project = await storage.readProject(jobId).catch(() => null)
      if (
        project?.audio &&
        project.audio.mode !== "none" &&
        !capabilities.audio.ready
      )
        return jsonError(
          503,
          "audio-unavailable",
          capabilities.audio.reason ??
            "Audio isn't available with this FFmpeg build.",
        )
      // Retries reuse the saved effects, so they need the same filters.
      const effects = project?.effects ?? STATIC_EFFECTS
      const missingEffects = missingEffectFilters(effects, capabilities)
      if (missingEffects.length > 0)
        return jsonError(
          503,
          "effects-unavailable",
          missingEffectsMessage(effects, missingEffects),
        )
    }
    const queued = await queue.retry(jobId)
    return jsonResponse(jobStatus(queued, queue.progressOf(jobId)), 202)
  } catch (error) {
    return renderErrorResponse(error)
  }
}
