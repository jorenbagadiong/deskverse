import type { NextRequest } from "next/server"

import { HISTORY_LIMIT, type JobHistory } from "@/lib/video/render-api"
import {
  guardLocalApi,
  jsonError,
  jsonResponse,
  requireNoBody,
} from "@/server/http/local-api"
import { renderErrorResponse } from "@/server/http/render-errors"
import { jobSummary } from "@/server/video/job-summary"
import { getRenderService } from "@/server/video/render-queue"

/**
 * GET /api/studio/pixel/jobs[?limit=N]: the local render history, newest
 * first, at most `limit` jobs (default 30, max 100). Summaries only: no
 * paths and no stored asset metadata.
 */
export async function GET(request: NextRequest) {
  const denied = guardLocalApi(request)
  if (denied) return denied
  const raw = request.nextUrl.searchParams.get("limit")
  let limit: number = HISTORY_LIMIT.default
  if (raw !== null) {
    if (
      !/^\d{1,3}$/.test(raw) ||
      Number(raw) < 1 ||
      Number(raw) > HISTORY_LIMIT.max
    )
      return jsonError(
        400,
        "invalid-limit",
        `limit must be a whole number from 1 to ${HISTORY_LIMIT.max}.`,
      )
    limit = Number(raw)
  }
  try {
    const { storage, queue } = await getRenderService()
    const { records, total } = await storage.listJobRecords(limit)
    const body: JobHistory = {
      jobs: records.map((record) =>
        jobSummary(record, queue.progressOf(record.job.id)),
      ),
      total,
      limit,
    }
    return jsonResponse(body)
  } catch (error) {
    return renderErrorResponse(error)
  }
}

/**
 * POST /api/studio/pixel/jobs: creates an empty draft job in local storage
 * and returns its generated ID. Takes no input.
 */
export async function POST(request: Request) {
  const denied = guardLocalApi(request) ?? (await requireNoBody(request))
  if (denied) return denied
  try {
    const { storage } = await getRenderService()
    const job = await storage.createJob()
    return jsonResponse({ jobId: job.id }, 201)
  } catch (error) {
    return renderErrorResponse(error)
  }
}
