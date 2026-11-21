import "server-only"

import { jsonError } from "@/server/http/local-api"
import { QueueError } from "@/server/video/render-queue"
import { StorageError } from "@/server/video/storage"

/** Maps storage/queue errors to HTTP responses with their user-facing messages. */
export function renderErrorResponse(error: unknown): Response {
  if (error instanceof QueueError)
    return jsonError(
      error.code === "busy" ? 429 : error.code === "files-missing" ? 422 : 409,
      error.code,
      error.message,
    )
  if (error instanceof StorageError) {
    switch (error.code) {
      case "invalid-id":
      case "not-found":
        return jsonError(404, "not-found", "That video job doesn't exist.")
      case "invalid-state":
        return jsonError(409, "invalid-state", error.message)
      case "too-many-assets":
        return jsonError(409, "too-many-assets", error.message)
      case "invalid-upload":
        return jsonError(422, "invalid-upload", error.message)
      case "unsafe-path":
        return jsonError(403, "forbidden", "That file can't be served.")
      default:
        return jsonError(500, error.code, "Local storage couldn't be used.")
    }
  }
  console.error("[pixel] unexpected API error:", error)
  return jsonError(
    500,
    "internal",
    "Something went wrong on the server. Try again.",
  )
}
