import type { CleanupSummary } from "@/lib/video/render-api"
import {
  guardLocalApi,
  jsonResponse,
  requireNoBody,
} from "@/server/http/local-api"
import { renderErrorResponse } from "@/server/http/render-errors"
import { getRenderService } from "@/server/video/render-queue"

/** Drafts (uploads never rendered) untouched this long count as abandoned. */
const ABANDONED_DRAFT_MS = 60 * 60 * 1000

/**
 * POST /api/studio/pixel/storage/cleanup (DV-003D1): removes abandoned
 * temporary data only: scratch files of inactive jobs, interrupted temp
 * files, and drafts untouched for an hour. Completed videos, failed and
 * cancelled jobs, and anything queued or rendering are never touched.
 */
export async function POST(request: Request) {
  const denied = guardLocalApi(request) ?? (await requireNoBody(request))
  if (denied) return denied
  try {
    const { storage } = await getRenderService()
    const result: CleanupSummary = await storage.cleanupAbandoned({
      draftOlderThanMs: ABANDONED_DRAFT_MS,
    })
    return jsonResponse(result)
  } catch (error) {
    return renderErrorResponse(error)
  }
}
