import "server-only"

import { checkLocalRequest } from "@/server/http/local-request"

/**
 * Shared guard for Pixel Studio's local-only endpoints (capabilities, jobs,
 * uploads, render, status, video).
 *
 * Two layers:
 * 1. Rendering is switched off entirely when the app runs on a hosting
 *    platform (or DESKVERSE_DISABLE_LOCAL_RENDERING=1), so a deployed
 *    Deskverse site can never become a public upload or FFmpeg service.
 * 2. Every request must pass the loopback Host/Origin/Fetch-Metadata checks.
 *
 * Neither is authentication. The real boundary is binding the server to
 * loopback (`yarn dev -H 127.0.0.1`); see docs/video-architecture.md.
 */

/** Environment variables set by common hosting platforms. */
const HOSTING_MARKERS = [
  "VERCEL",
  "NETLIFY",
  "RENDER",
  "FLY_APP_NAME",
  "RAILWAY_ENVIRONMENT",
  "K_SERVICE", // Google Cloud Run
  "AWS_LAMBDA_FUNCTION_NAME",
  "DYNO", // Heroku
] as const

export function localRenderingDisabledReason(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (env.DESKVERSE_DISABLE_LOCAL_RENDERING === "1")
    return "Local rendering is turned off on this server (DESKVERSE_DISABLE_LOCAL_RENDERING)."
  if (HOSTING_MARKERS.some((key) => env[key]))
    return "Video rendering only runs on your own computer, so it's disabled on this hosted site."
  return null
}

const NO_STORE = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const

export function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE })
}

export function jsonError(status: number, error: string, message: string) {
  return jsonResponse({ error, message }, status)
}

/** Returns an error response when the request may not proceed, else null. */
export function guardLocalApi(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Response | null {
  const disabled = localRenderingDisabledReason(env)
  if (disabled) return jsonError(503, "local-rendering-disabled", disabled)
  const access = checkLocalRequest(request.headers)
  if (!access.ok)
    return jsonError(
      403,
      "forbidden",
      "Pixel Studio's rendering endpoints only answer a browser on this computer.",
    )
  return null
}

/**
 * Guard for Deskverse's local system endpoints (e.g. the database health
 * check): the same loopback checks as Pixel Studio's, and the same refusal
 * on hosting platforms, with wording that isn't about rendering.
 */
export function guardLocalSystemApi(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Response | null {
  if (
    env.DESKVERSE_DISABLE_LOCAL_RENDERING === "1" ||
    HOSTING_MARKERS.some((key) => env[key])
  )
    return jsonError(
      503,
      "local-services-disabled",
      "Local services only run on your own computer, so they're disabled on this server.",
    )
  if (!checkLocalRequest(request.headers).ok)
    return jsonError(
      403,
      "forbidden",
      "Deskverse's local system endpoints only answer a browser on this computer.",
    )
  return null
}

/**
 * Action endpoints (cancel, retry, delete, cleanup) take no input at all; a
 * body is refused rather than ignored.
 */
export async function requireNoBody(
  request: Request,
): Promise<Response | null> {
  const refuse = () =>
    jsonError(400, "unexpected-body", "This action takes no request body.")
  const length = request.headers.get("content-length")
  if (length !== null && length !== "0") return refuse()
  // Whatever the framing, any body bytes at all are refused.
  try {
    await readLimitedBody(request, 0)
  } catch {
    return refuse()
  }
  return null
}

/** Requires a JSON body; HTML forms can't send this type across sites. */
export function requireJson(request: Request): Response | null {
  const type = request.headers.get("content-type") ?? ""
  if (!/^application\/json(\s*;|$)/i.test(type))
    return jsonError(415, "unsupported-media-type", "Send JSON.")
  return null
}

export class BodyTooLargeError extends Error {}

/**
 * Reads a request body up to `maxBytes`. Refuses before reading when
 * Content-Length is already too large, and stops reading (cancelling the
 * stream) as soon as the limit is passed when the length is missing or false.
 */
export async function readLimitedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = request.headers.get("content-length")
  if (declared !== null && Number(declared) > maxBytes)
    throw new BodyTooLargeError()
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new BodyTooLargeError()
    }
    chunks.push(value)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/** Parses a JSON body of at most `maxBytes`; null when unreadable. */
export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    const bytes = await readLimitedBody(request, maxBytes)
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch (error) {
    if (error instanceof BodyTooLargeError)
      return {
        ok: false,
        response: jsonError(413, "too-large", "The request is too large."),
      }
    return {
      ok: false,
      response: jsonError(400, "invalid-json", "The request isn't valid JSON."),
    }
  }
}
