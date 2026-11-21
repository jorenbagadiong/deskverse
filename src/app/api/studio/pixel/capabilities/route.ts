import type { NextRequest } from "next/server"

import { checkLocalRequest } from "@/server/http/local-request"
import { getFfmpegCapabilities } from "@/server/video/ffmpeg-capabilities"

/**
 * GET /api/studio/pixel/capabilities
 *
 * Reports whether this computer's FFmpeg/FFprobe can render Pixel Studio
 * videos. Read-only: it runs fixed `-version` / `-encoders` / `-filters`
 * commands and accepts no input except `?refresh=1` to skip the 30 s cache.
 *
 * Runs on the Node.js runtime (the only runtime with Cache Components, which
 * is why there is no `export const runtime`). Reading the request headers
 * keeps it out of build-time prerendering, so detection always happens on
 * the machine that serves the request.
 */

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const

export async function GET(request: NextRequest) {
  const access = checkLocalRequest(request.headers)
  if (!access.ok)
    return Response.json(
      {
        error: "forbidden",
        message:
          "FFmpeg status is only available to a browser on this computer.",
      },
      { status: 403, headers: HEADERS },
    )

  const refresh = request.nextUrl.searchParams.get("refresh") === "1"
  try {
    const report = await getFfmpegCapabilities({ refresh })
    return Response.json(report, { headers: HEADERS })
  } catch {
    return Response.json(
      {
        error: "detection-failed",
        message: "Couldn't check FFmpeg. Try again.",
      },
      { status: 500, headers: HEADERS },
    )
  }
}
