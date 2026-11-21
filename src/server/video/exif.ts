import "server-only"

/**
 * EXIF orientation for JPEG photos (DV-003D2), read from the file's bytes.
 *
 * Phones usually store photos sideways and record how to turn them upright
 * in the EXIF `Orientation` tag (0x0112, values 1–8). FFmpeg 6.1's handling
 * of that tag for JPEG stills is inconsistent (mirrored and 90°/270° cases
 * come out wrong), so Deskverse never relies on it: the renderer decodes the
 * raw pixels with `-noautorotate` and applies the transform below exactly
 * once, while normalizing each photo in the private work directory.
 *
 * The parser is small and defensive: a bounded walk over the JPEG markers
 * before the image data, then IFD0 of the first `Exif` APP1 segment. Any
 * missing, truncated or malformed structure means "1" (as stored), never an
 * exception. No pixels are decoded here.
 */

export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

const ORIENTATION_TAG = 0x0112
const TYPE_SHORT = 3

/** Returns the JPEG's EXIF orientation, or 1 when there is none or it can't be read. */
export function readJpegOrientation(bytes: Uint8Array): ExifOrientation {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1
  let i = 2
  for (let steps = 0; steps < 10_000 && i + 4 <= bytes.length; steps++) {
    if (bytes[i] !== 0xff) return 1
    const marker = bytes[i + 1]
    if (marker === 0xff) {
      i++ // fill byte
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    // Start of scan / end of image: metadata comes before both.
    if (marker === 0xda || marker === 0xd9) return 1
    const length = (bytes[i + 2] << 8) | bytes[i + 3]
    if (length < 2 || i + 2 + length > bytes.length) return 1
    if (marker === 0xe1) {
      const segment = bytes.subarray(i + 4, i + 2 + length)
      if (isExifHeader(segment)) return readTiffOrientation(segment.subarray(6))
    }
    i += 2 + length
  }
  return 1
}

function isExifHeader(segment: Uint8Array) {
  // "Exif\0\0"
  return (
    segment.length >= 6 &&
    segment[0] === 0x45 &&
    segment[1] === 0x78 &&
    segment[2] === 0x69 &&
    segment[3] === 0x66 &&
    segment[4] === 0 &&
    segment[5] === 0
  )
}

function readTiffOrientation(tiff: Uint8Array): ExifOrientation {
  if (tiff.length < 8) return 1
  let little: boolean
  if (tiff[0] === 0x49 && tiff[1] === 0x49)
    little = true // "II"
  else if (tiff[0] === 0x4d && tiff[1] === 0x4d)
    little = false // "MM"
  else return 1
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
  if (view.getUint16(2, little) !== 42) return 1
  const ifd = view.getUint32(4, little)
  if (ifd < 8 || ifd + 2 > tiff.length) return 1
  const count = view.getUint16(ifd, little)
  for (let n = 0; n < count; n++) {
    const entry = ifd + 2 + n * 12
    if (entry + 12 > tiff.length) return 1
    if (view.getUint16(entry, little) !== ORIENTATION_TAG) continue
    if (
      view.getUint16(entry + 2, little) !== TYPE_SHORT ||
      view.getUint32(entry + 4, little) !== 1
    )
      return 1
    // A single SHORT sits in the first two bytes of the value field.
    const value = view.getUint16(entry + 8, little)
    return value >= 1 && value <= 8 ? (value as ExifOrientation) : 1
  }
  return 1
}

/** Orientations 5–8 turn the image by 90° or 270°: width and height swap. */
export function swapsDimensions(orientation: ExifOrientation) {
  return orientation >= 5
}

/** The upright (displayed) size of an image stored with this orientation. */
export function orientedDimensions(
  stored: { width: number; height: number },
  orientation: ExifOrientation,
) {
  return swapsDimensions(orientation)
    ? { width: stored.height, height: stored.width }
    : { width: stored.width, height: stored.height }
}

/**
 * The FFmpeg filters that turn raw (`-noautorotate`) pixels upright, per
 * EXIF orientation. Verified pixel by pixel against real FFmpeg 6.1.1 with
 * quadrant-colored fixtures for every value (tests/integration).
 */
export const ORIENTATION_FILTERS: Record<ExifOrientation, readonly string[]> = {
  1: [],
  2: ["hflip"],
  3: ["hflip", "vflip"],
  4: ["vflip"],
  5: ["transpose=cclock_flip"],
  6: ["transpose=clock"],
  7: ["transpose=clock_flip"],
  8: ["transpose=cclock"],
}
