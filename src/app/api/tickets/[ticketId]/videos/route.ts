import { ids, pool } from "@/server/orchestrator/http"
import { pixelOverview } from "@/server/pixel/store"
import { handle, jsonResponse, notFound } from "@/server/tickets/http"
import { getFfmpegCapabilities } from "@/server/video/ffmpeg-capabilities"

/**
 * GET /api/tickets/:ticketId/videos (DV-005C) → { availability, products,
 * latestRun, deliverables }: FFmpeg readiness, per product its images and
 * the Quill scripts Pixel could render (verified? still current? Pixel
 * text compatible?), the latest video run's persisted render states (real
 * progress from FFmpeg, only while a task runs), and every finished video
 * (newest first, ≤ 100). Read-only.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/tickets/[ticketId]/videos">,
) {
  return handle(request, async () => {
    const { ticketId } = ids(await ctx.params)
    const exists = await pool().query(
      "SELECT 1 FROM affiliate_tickets WHERE id = $1",
      [ticketId],
    )
    if (!exists.rowCount) throw notFound()
    const capabilities = await getFfmpegCapabilities().catch(() => null)
    const problem =
      !capabilities ||
      capabilities.status !== "ready" ||
      !capabilities.selectedH264Encoder
        ? (capabilities?.issues.find((i) => i.severity === "error")?.message ??
          "FFmpeg isn't ready to render on this computer.")
        : null
    return jsonResponse({
      availability: {
        ffmpeg: {
          ready: problem === null,
          encoder: capabilities?.selectedH264Encoder ?? null,
          problem,
        },
      },
      ...(await pixelOverview(pool(), ticketId)),
    })
  })
}
