import type { ApiError } from "@/lib/tickets/types"

/**
 * Browser calls to /api/tickets (DV-004B). Every call resolves (never
 * throws) to data or an ApiError with a message that can be shown as is.
 * PostgreSQL is the source of truth: nothing is kept in localStorage.
 */

export type ApiResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; error: ApiError; status: number }

const UNREACHABLE: ApiError = {
  error: "unreachable",
  message:
    "The Deskverse server didn't respond. Check it's still running, then try again. Your changes are still on this page.",
}

function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ApiError).error === "string" &&
    typeof (value as ApiError).message === "string"
  )
}

export async function api<T>(
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetch(url, {
      method: init.method ?? "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(init.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
  } catch {
    return { ok: false, error: UNREACHABLE, status: 0 }
  }
  const body: unknown = await response.json().catch(() => null)
  if (response.ok && body !== null)
    return { ok: true, data: body as T, status: response.status }
  return {
    ok: false,
    status: response.status,
    error: isApiError(body)
      ? body
      : {
          error: "unexpected",
          message: `The server answered with status ${response.status}.`,
        },
  }
}

/**
 * Uploads one file as the raw request body, reporting progress (fetch
 * can't report upload progress, so this uses XMLHttpRequest).
 */
export function uploadFile<T>(
  url: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<ApiResult<T>> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", url)
    xhr.setRequestHeader(
      "Content-Type",
      file.type || "application/octet-stream",
    )
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name))
    xhr.setRequestHeader("Accept", "application/json")
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total)
    }
    const finish = () => {
      let body: unknown = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        // Not JSON.
      }
      if (xhr.status >= 200 && xhr.status < 300 && body !== null)
        resolve({ ok: true, data: body as T, status: xhr.status })
      else
        resolve({
          ok: false,
          status: xhr.status,
          error: isApiError(body)
            ? body
            : xhr.status === 0
              ? UNREACHABLE
              : {
                  error: "unexpected",
                  message: `The upload failed (status ${xhr.status}).`,
                },
        })
    }
    xhr.onload = finish
    xhr.onerror = () => resolve({ ok: false, status: 0, error: UNREACHABLE })
    xhr.onabort = () =>
      resolve({
        ok: false,
        status: 0,
        error: { error: "aborted", message: "Upload cancelled." },
      })
    signal?.addEventListener("abort", () => xhr.abort())
    xhr.send(file)
  })
}

/** A request ID for idempotent creates (one per form, reused on retry). */
export function newRequestId() {
  return crypto.randomUUID()
}

/** Field errors by path, for showing next to each input. */
export function issuesByPath(error: ApiError | null): Record<string, string> {
  const map: Record<string, string> = {}
  for (const issue of error?.issues ?? [])
    if (!(issue.path in map)) map[issue.path] = issue.message
  return map
}
