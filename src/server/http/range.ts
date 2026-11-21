import "server-only"

/**
 * Parses a single-range `Range: bytes=…` header (what <video> sends to seek).
 * Returns null for no/unsupported ranges (serve the whole file) and
 * "unsatisfiable" for ranges outside the file (416).
 */
export function parseByteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null // multiple or malformed ranges: send everything
  const [, rawStart, rawEnd] = match
  if (rawStart === "" && rawEnd === "") return null
  let start: number
  let end: number
  if (rawStart === "") {
    // Suffix range: the last N bytes.
    const length = Number(rawEnd)
    if (length === 0) return "unsatisfiable"
    start = Math.max(size - length, 0)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end))
    return "unsatisfiable"
  if (start >= size || start > end) return "unsatisfiable"
  return { start, end }
}

/** ASCII-only, lowercase download name: "trailblazer-travel-mug". */
export function downloadSlug(text: string, fallback = "pixel-video") {
  const slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "")
  return slug || fallback
}
