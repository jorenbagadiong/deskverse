import { guardLocalApi, jsonResponse } from "@/server/http/local-api"
import { renderErrorResponse } from "@/server/http/render-errors"
import { getRenderService } from "@/server/video/render-queue"

/**
 * POST /api/studio/pixel/jobs: creates an empty draft job in local storage
 * and returns its generated ID. Takes no input.
 */
export async function POST(request: Request) {
  const denied = guardLocalApi(request)
  if (denied) return denied
  try {
    const { storage } = await getRenderService()
    const job = await storage.createJob()
    return jsonResponse({ jobId: job.id }, 201)
  } catch (error) {
    return renderErrorResponse(error)
  }
}
