import type { NextRequest } from "next/server"

import { isRenderJobId } from "@/lib/video/ids"
import { FILE_NAME_HEADER, type UploadedAudio } from "@/lib/video/render-api"
import { AUDIO_ROLES, type AudioRole } from "@/lib/video/types"
import {
  AUDIO_LIMITS,
  formatBytes,
  isAudioMimeType,
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
import { createAudioInspector } from "@/server/video/upload-verify"

/**
 * POST /api/studio/pixel/jobs/:jobId/audio?role=voiceover|music (DV-003C)
 *
 * Uploads one voiceover or music file as the raw request body. The browser's
 * type is only a hint (it must be an audio type); the server identifies the
 * container by its bytes, confirms it with FFprobe (one audio stream, no
 * video, cover art or other streams, accepted codec), decodes it fully, and
 * checks duration, channels and sample rate before storing it privately
 * under a generated name.
 */
export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/studio/pixel/jobs/[jobId]/audio">,
) {
  const denied = guardLocalApi(request)
  if (denied) return denied
  const { jobId } = await ctx.params
  if (!isRenderJobId(jobId))
    return jsonError(404, "not-found", "That video job doesn't exist.")

  const role = request.nextUrl.searchParams.get("role")
  if (!(AUDIO_ROLES as readonly (string | null)[]).includes(role))
    return jsonError(
      400,
      "invalid-role",
      "Say whether this is the voiceover or the music.",
    )

  const declaredType = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase()
  if (!isAudioMimeType(declaredType))
    return jsonError(
      415,
      "unsupported-media-type",
      "Upload MP3, WAV or M4A audio only.",
    )

  let bytes: Uint8Array
  try {
    bytes = await readLimitedBody(request, AUDIO_LIMITS.maxBytes)
  } catch (error) {
    if (error instanceof BodyTooLargeError)
      return jsonError(
        413,
        "too-large",
        `Audio files must be ${formatBytes(AUDIO_LIMITS.maxBytes)} or smaller.`,
      )
    return jsonError(400, "unreadable", "The upload couldn't be read.")
  }

  let fileName = "audio"
  try {
    fileName = decodeURIComponent(
      request.headers.get(FILE_NAME_HEADER) ?? "audio",
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
      "FFmpeg and FFprobe are needed to check audio. Install them first (sudo apt install ffmpeg).",
    )
  if (!capabilities.audio.ready)
    return jsonError(
      503,
      "audio-unavailable",
      capabilities.audio.reason ??
        "Audio isn't available with this FFmpeg build.",
    )

  try {
    const { storage } = await getRenderService()
    const asset = await storage.addAudioAsset(
      jobId,
      { bytes, declaredType, fileName, role: role as AudioRole },
      {
        inspect: createAudioInspector(createRunner({ timeoutMs: 30_000 }), {
          ffmpeg: ffmpeg.command,
          ffprobe: ffprobe.command,
        }),
      },
    )
    const body: UploadedAudio = {
      id: asset.id,
      role: asset.role,
      displayName: asset.displayName,
      container: asset.container,
      sizeBytes: asset.sizeBytes,
      durationSeconds: asset.durationSeconds,
      sampleRate: asset.sampleRate,
      channels: asset.channels,
    }
    return jsonResponse({ audio: body }, 201)
  } catch (error) {
    return renderErrorResponse(error)
  }
}
