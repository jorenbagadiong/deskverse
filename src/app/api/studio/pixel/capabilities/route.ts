import type { NextRequest } from "next/server"

import { guardLocalApi, jsonError, jsonResponse } from "@/server/http/local-api"
import { getFfmpegCapabilities } from "@/server/video/ffmpeg-capabilities"

/**
 * GET /api/studio/pixel/capabilities
 *
 * Reports whether this computer's FFmpeg/FFprobe can render Pixel Studio
 * videos. Read-only: it runs fixed `-version` / `-encoders` / `-filters`
 * commands plus a tiny test encode, and accepts no input except
 * `?refresh=1` to skip the 30 s cache.
 *
 * Runs on the Node.js runtime (the only runtime with Cache Components, which
 * is why there is no `export const runtime`). Reading the request headers
 * keeps it out of build-time prerendering, so detection always happens on
 * the machine that serves the request.
 */

export async function GET(request: NextRequest) {
  const denied = guardLocalApi(request)
  if (denied) return denied

  const refresh = request.nextUrl.searchParams.get("refresh") === "1"
  try {
    const report = await getFfmpegCapabilities({ refresh })
    return jsonResponse(report)
  } catch {
    return jsonError(
      500,
      "detection-failed",
      "Couldn't check FFmpeg. Try again.",
    )
  }
}
