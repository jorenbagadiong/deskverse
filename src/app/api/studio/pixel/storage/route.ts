import { guardLocalApi, jsonResponse } from "@/server/http/local-api"
import { renderErrorResponse } from "@/server/http/render-errors"
import { storageSummary } from "@/server/video/job-summary"
import { getRenderService } from "@/server/video/render-queue"

/**
 * GET /api/studio/pixel/storage (DV-003D1): space used by Pixel Studio's
 * private storage and job counts. Real files only; no paths.
 */
export async function GET(request: Request) {
  const denied = guardLocalApi(request)
  if (denied) return denied
  try {
    const { storage } = await getRenderService()
    return jsonResponse(storageSummary(await storage.usage()))
  } catch (error) {
    return renderErrorResponse(error)
  }
}
