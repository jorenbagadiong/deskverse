import "server-only"

import type { Issue } from "@/lib/tickets/validation"
import { TICKET_LIMITS } from "@/lib/tickets/types"
import { DatabaseUnavailableError, getDatabase } from "@/server/db/client"
import { classifyDatabaseError } from "@/server/db/errors"
import type { DeskverseDatabase } from "@/server/db/pool"
import {
  guardLocalSystemApi,
  jsonResponse,
  readJsonBody,
  requireJson,
} from "@/server/http/local-api"
import { createRunner } from "@/server/process/run-executable"
import { MediaRejected } from "@/server/tickets/media-verify"
import type { MediaTools } from "@/server/tickets/media-verify"
import { TicketMediaError } from "@/server/tickets/media"
import { OrchestratorError } from "@/server/orchestrator/store"
import { TicketError } from "@/server/tickets/repository"
import {
  getFfmpegCapabilities,
  resolveExecutable,
} from "@/server/video/ffmpeg-capabilities"
import { resolveDataRoot } from "@/server/video/storage"

/**
 * Shared plumbing for /api/tickets (DV-004B): the local-only guard, the
 * database handle, JSON bodies and one error mapping. Responses never carry
 * SQL, driver messages, credentials or file paths.
 */

export { guardLocalSystemApi as guard, jsonResponse }

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: Issue[] = [],
  ) {
    super(message)
  }
}

export function invalid(
  issues: Issue[],
  message = "Some fields need attention.",
) {
  return new HttpError(400, "invalid", message, issues)
}

export function notFound(message = "That Affiliate Ticket doesn't exist.") {
  return new HttpError(404, "not-found", message)
}

export function database(): DeskverseDatabase {
  return getDatabase()
}

export function dataRoot() {
  return resolveDataRoot()
}

/** Parses a JSON object body (≤ 128 KiB). */
export async function jsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const type = requireJson(request)
  if (type) throw new HttpError(415, "unsupported-media-type", "Send JSON.")
  const body = await readJsonBody(request, TICKET_LIMITS.maxJsonBytes)
  if (!body.ok) {
    const parsed = (await body.response.json()) as {
      error: string
      message: string
    }
    throw new HttpError(body.response.status, parsed.error, parsed.message)
  }
  if (
    typeof body.value !== "object" ||
    body.value === null ||
    Array.isArray(body.value)
  )
    throw invalid([], "Send a JSON object.")
  return body.value as Record<string, unknown>
}

export function requireVersion(body: Record<string, unknown>) {
  const version = body.version
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    throw invalid(
      [
        {
          path: "version",
          message: "Missing ticket version. Reload the page and try again.",
        },
      ],
      "Missing ticket version.",
    )
  return version
}

/** FFmpeg/FFprobe for upload checks, or a 503 explaining what to install. */
export async function mediaTools(): Promise<MediaTools> {
  const ffmpeg = resolveExecutable("ffmpeg", process.env.DESKVERSE_FFMPEG_PATH)
  const ffprobe = resolveExecutable(
    "ffprobe",
    process.env.DESKVERSE_FFPROBE_PATH,
  )
  const capabilities = await getFfmpegCapabilities()
  if (!ffmpeg.ok || !ffprobe.ok || capabilities.status === "missing")
    throw new HttpError(
      503,
      "media-checks-unavailable",
      "Uploads are checked with FFmpeg and FFprobe, which aren't available. Install them (sudo apt install ffmpeg), then try again. Nothing was saved.",
    )
  return {
    run: createRunner({ timeoutMs: 60_000, maxOutputBytes: 4 * 1024 * 1024 }),
    // A five-minute clip can take longer than a probe. Give only the full
    // decode a larger wall-clock budget, with a small progress/error buffer.
    runVideoDecode: createRunner({
      timeoutMs: 180_000,
      maxOutputBytes: 256 * 1024,
    }),
    ffmpeg: ffmpeg.command,
    ffprobe: ffprobe.command,
  }
}

const TICKET_STATUS: Record<TicketError["code"], number> = {
  "not-found": 404,
  conflict: 409,
  archived: 409,
  "not-ready": 409,
  "invalid-transition": 409,
  limit: 409,
  "in-use": 409,
}

/** Maps any error to a safe JSON response. */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError)
    return body(error.status, error.code, error.message, error.issues)
  if (error instanceof TicketError)
    return body(
      TICKET_STATUS[error.code],
      error.code,
      error.message,
      error.issues,
    )
  if (error instanceof OrchestratorError)
    return body(
      error.code === "not-found"
        ? 404
        : error.code === "unavailable"
          ? 503
          : error.code === "invalid"
            ? 400
            : 409,
      error.code === "unavailable" ? "capability-unavailable" : error.code,
      error.message,
    )
  if (error instanceof MediaRejected)
    return body(400, "invalid-media", `${error.message} Nothing was saved.`)
  if (error instanceof TicketMediaError) {
    const status =
      error.code === "too-large" ? 413 : error.code === "missing" ? 410 : 400
    return body(status, error.code, error.message)
  }
  if (error instanceof DatabaseUnavailableError)
    return body(
      503,
      "database-unconfigured",
      "Affiliate Tickets need local PostgreSQL, which isn't configured (DATABASE_URL). Nothing was saved.",
    )
  const { failure, message } = classifyDatabaseError(error)
  if (failure === "offline" || failure === "timeout")
    return body(
      503,
      "database-unavailable",
      `${message} Nothing was saved; your changes are still on this page.`,
    )
  if (failure !== "error")
    return body(503, "database-unavailable", `${message} Nothing was saved.`)
  const code = (error as { code?: unknown })?.code
  if (typeof code === "string" && /^23/.test(code))
    // Integrity constraint: validation should have caught it first.
    return body(
      400,
      "invalid",
      "That change isn't valid. Reload the page and try again.",
    )
  console.warn("[deskverse] ticket request failed unexpectedly")
  return body(
    500,
    "internal",
    "Something went wrong. Nothing was saved. Try again.",
  )
}

function body(
  status: number,
  error: string,
  message: string,
  issues: Issue[] = [],
) {
  return jsonResponse(
    issues.length > 0 ? { error, message, issues } : { error, message },
    status,
  )
}

/** Runs a route body: local-only guard, then the handler, then error mapping. */
export async function handle(
  request: Request,
  run: () => Promise<Response>,
): Promise<Response> {
  const denied = guardLocalSystemApi(request)
  if (denied) return denied
  try {
    return await run()
  } catch (error) {
    return errorResponse(error)
  }
}
