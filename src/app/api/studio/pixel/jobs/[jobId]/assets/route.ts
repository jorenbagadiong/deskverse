import { isRenderJobId } from "@/lib/video/ids"
import { FILE_NAME_HEADER, type UploadedAsset } from "@/lib/video/render-api"
import {
  formatBytes,
  isImageMimeType,
  MEDIA_LIMITS,
} from "@/lib/video/validation"
import {
  BodyTooLargeError,
  guardLocalApi,
  jsonError,
  jsonResponse,
  readLimitedBody,
} from "@/server/http/local-api"
import { renderErrorResponse } from "@/server/http/render-errors"
import { createRunner } from "@/server/process/run-executable"
import {
  getFfmpegCapabilities,
  resolveExecutable,
} from "@/server/video/ffmpeg-capabilities"
import { getRenderService } from "@/server/video/render-queue"
import { createUploadVerifier } from "@/server/video/upload-verify"

/**
 * POST /api/studio/pixel/jobs/:jobId/assets: uploads one image as the raw
 * request body (Content-Type: image/jpeg|png|webp, display name in
 * X-File-Name). The bytes are size-limited while streaming, identified by
 * their contents, re-checked with FFprobe and a test decode, and stored
 * privately under a generated name. Client paths are never accepted.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/studio/pixel/jobs/[jobId]/assets">,
) {
  const denied = guardLocalApi(request)
  if (denied) return denied
  const { jobId } = await ctx.params
  if (!isRenderJobId(jobId))
    return jsonError(404, "not-found", "That video job doesn't exist.")

  const declaredType = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase()
  if (!isImageMimeType(declaredType))
    return jsonError(
      415,
      "unsupported-media-type",
      "Upload JPEG, PNG or WebP images only.",
    )

  let bytes: Uint8Array
  try {
    bytes = await readLimitedBody(request, MEDIA_LIMITS.maxBytes)
  } catch (error) {
    if (error instanceof BodyTooLargeError)
      return jsonError(
        413,
        "too-large",
        `Images must be ${formatBytes(MEDIA_LIMITS.maxBytes)} or smaller.`,
      )
    return jsonError(400, "unreadable", "The upload couldn't be read.")
  }

  let fileName = "image"
  try {
    fileName = decodeURIComponent(
      request.headers.get(FILE_NAME_HEADER) ?? "image",
    )
  } catch {
    // Keep the generic name; it is only ever displayed.
  }

  const ffmpeg = resolveExecutable("ffmpeg", process.env.DESKVERSE_FFMPEG_PATH)
  const ffprobe = resolveExecutable(
    "ffprobe",
    process.env.DESKVERSE_FFPROBE_PATH,
  )
  const capabilities = await getFfmpegCapabilities()
  if (!ffmpeg.ok || !ffprobe.ok || capabilities.status === "missing")
    return jsonError(
      503,
      "ffmpeg-unavailable",
      "FFmpeg and FFprobe are needed to check uploads. Install them first (sudo apt install ffmpeg).",
    )

  try {
    const { storage } = await getRenderService()
    const asset = await storage.addImageAsset(
      jobId,
      { bytes, declaredType, fileName },
      {
        verify: createUploadVerifier(createRunner({ timeoutMs: 15_000 }), {
          ffmpeg: ffmpeg.command,
          ffprobe: ffprobe.command,
        }),
      },
    )
    const body: UploadedAsset = {
      id: asset.id,
      displayName: asset.displayName,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      width: asset.width,
      height: asset.height,
    }
    return jsonResponse({ asset: body }, 201)
  } catch (error) {
    return renderErrorResponse(error)
  }
}
