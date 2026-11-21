import "server-only"

import type { ImageMimeType } from "@/lib/video/types"

/**
 * Identifies images by their bytes, not by the name or MIME type a client
 * claims. Only JPEG, PNG and WebP are recognised; everything else (SVG, HTML,
 * GIF, executables, archives…) is rejected. Dimensions are read from the
 * headers without decoding pixels, so a malformed file can't trigger a
 * decoder bug here. DV-003B re-checks with ffprobe before rendering.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function startsWith(
  bytes: Uint8Array,
  signature: readonly number[],
  offset = 0,
) {
  return signature.every((b, i) => bytes[offset + i] === b)
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

export function sniffImageType(bytes: Uint8Array): ImageMimeType | null {
  if (bytes.length >= 8 && startsWith(bytes, PNG_SIGNATURE)) return "image/png"
  if (bytes.length >= 3 && startsWith(bytes, [0xff, 0xd8, 0xff]))
    return "image/jpeg"
  if (
    bytes.length >= 16 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  )
    return "image/webp"
  return null
}

export interface ImageDimensions {
  width: number
  height: number
}

export function readImageDimensions(
  bytes: Uint8Array,
  type: ImageMimeType,
): ImageDimensions | null {
  switch (type) {
    case "image/png":
      return readPng(bytes)
    case "image/jpeg":
      return readJpeg(bytes)
    case "image/webp":
      return readWebp(bytes)
  }
}

function readPng(b: Uint8Array): ImageDimensions | null {
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return valid(view.getUint32(16), view.getUint32(20))
}

/** Start-of-frame markers that carry dimensions (baseline, progressive, lossless…). */
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

function readJpeg(b: Uint8Array): ImageDimensions | null {
  let i = 2
  // Bounded walk over marker segments; gives up on anything malformed.
  for (let steps = 0; steps < 10_000 && i + 4 <= b.length; steps++) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xff) {
      i++ // fill byte
      continue
    }
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null // end of image / scan data before a frame header
    const length = (b[i + 2] << 8) | b[i + 3]
    if (length < 2) return null
    if (JPEG_SOF.has(marker)) {
      if (i + 9 > b.length) return null
      const height = (b[i + 5] << 8) | b[i + 6]
      const width = (b[i + 7] << 8) | b[i + 8]
      return valid(width, height)
    }
    i += 2 + length
  }
  return null
}

function readWebp(b: Uint8Array): ImageDimensions | null {
  if (b.length < 30) return null
  const chunk = ascii(b, 12, 4)
  if (chunk === "VP8 ") {
    if (!startsWith(b, [0x9d, 0x01, 0x2a], 23)) return null
    return valid(
      ((b[27] << 8) | b[26]) & 0x3fff,
      ((b[29] << 8) | b[28]) & 0x3fff,
    )
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null
    const [b1, b2, b3, b4] = [b[21], b[22], b[23], b[24]]
    return valid(
      1 + (b1 | ((b2 & 0x3f) << 8)),
      1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
    )
  }
  if (chunk === "VP8X") {
    return valid(
      1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
      1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
    )
  }
  return null
}

function valid(width: number, height: number): ImageDimensions | null {
  return width > 0 && height > 0 ? { width, height } : null
}
