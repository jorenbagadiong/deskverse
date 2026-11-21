import "server-only"

import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Just enough TrueType parsing to lay out captions: which characters the font
 * can draw (cmap) and how wide each one is (hmtx). FFmpeg's drawtext doesn't
 * wrap text, so the server wraps it using the real glyph widths of the font
 * it will render with, keeping every line inside the safe area.
 */

export interface FontMetrics {
  unitsPerEm: number
  /** Ascender and descender in font units (from hhea), for line spacing. */
  ascender: number
  descender: number
  hasGlyph(codePoint: number): boolean
  /** Advance width in font units; missing glyphs use the .notdef width. */
  advance(codePoint: number): number
}

export class FontParseError extends Error {}

export function parseFont(bytes: Uint8Array): FontMetrics {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fail = (why: string): never => {
    throw new FontParseError(`Not a usable TrueType/OpenType font: ${why}.`)
  }
  if (bytes.byteLength < 12) fail("too short")
  const version = view.getUint32(0)
  if (version !== 0x00010000 && version !== 0x4f54544f /* OTTO */)
    fail("unknown signature")

  const tables = new Map<string, { offset: number; length: number }>()
  const numTables = view.getUint16(4)
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16
    if (record + 16 > bytes.byteLength) fail("truncated table directory")
    const tag = String.fromCharCode(...bytes.subarray(record, record + 4))
    const offset = view.getUint32(record + 8)
    const length = view.getUint32(record + 12)
    if (offset + length > bytes.byteLength) fail(`table ${tag} out of range`)
    tables.set(tag, { offset, length })
  }
  const table = (tag: string) => tables.get(tag) ?? fail(`missing ${tag}`)

  const head = table("head")
  const unitsPerEm = view.getUint16(head.offset + 18)
  if (unitsPerEm < 16) fail("bad unitsPerEm")

  const hhea = table("hhea")
  const ascender = view.getInt16(hhea.offset + 4)
  const descender = view.getInt16(hhea.offset + 6)
  const numberOfHMetrics = view.getUint16(hhea.offset + 34)

  const hmtx = table("hmtx")
  if (numberOfHMetrics === 0 || numberOfHMetrics * 4 > hmtx.length)
    fail("bad hmtx")
  const advanceOfGlyph = (glyph: number) =>
    view.getUint16(hmtx.offset + Math.min(glyph, numberOfHMetrics - 1) * 4)

  const glyphOf = parseCmap(view, table("cmap"), fail)

  return {
    unitsPerEm,
    ascender,
    descender,
    hasGlyph: (codePoint) => glyphOf(codePoint) !== 0,
    advance: (codePoint) => advanceOfGlyph(glyphOf(codePoint)),
  }
}

/** Returns a code point → glyph lookup from the best Unicode subtable. */
function parseCmap(
  view: DataView,
  cmap: { offset: number; length: number },
  fail: (why: string) => never,
): (codePoint: number) => number {
  const count = view.getUint16(cmap.offset + 2)
  let format4: number | null = null
  let format12: number | null = null
  for (let i = 0; i < count; i++) {
    const record = cmap.offset + 4 + i * 8
    const platform = view.getUint16(record)
    const encoding = view.getUint16(record + 2)
    const sub = cmap.offset + view.getUint32(record + 4)
    const format = view.getUint16(sub)
    const unicode =
      platform === 0 || (platform === 3 && [1, 10].includes(encoding))
    if (!unicode) continue
    if (format === 12) format12 ??= sub
    if (format === 4) format4 ??= sub
  }

  if (format12 !== null) {
    const groups = view.getUint32(format12 + 12)
    const base = format12 + 16
    return (cp) => {
      let lo = 0
      let hi = groups - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const start = view.getUint32(base + mid * 12)
        const end = view.getUint32(base + mid * 12 + 4)
        if (cp < start) hi = mid - 1
        else if (cp > end) lo = mid + 1
        else return view.getUint32(base + mid * 12 + 8) + (cp - start)
      }
      return 0
    }
  }

  if (format4 !== null) {
    const sub = format4
    const segCount = view.getUint16(sub + 6) / 2
    const ends = sub + 14
    const starts = ends + segCount * 2 + 2
    const deltas = starts + segCount * 2
    const rangeOffsets = deltas + segCount * 2
    return (cp) => {
      if (cp > 0xffff) return 0
      for (let i = 0; i < segCount; i++) {
        if (cp > view.getUint16(ends + i * 2)) continue
        const start = view.getUint16(starts + i * 2)
        if (cp < start) return 0
        const delta = view.getInt16(deltas + i * 2)
        const rangeOffset = view.getUint16(rangeOffsets + i * 2)
        if (rangeOffset === 0) return (cp + delta) & 0xffff
        const glyphAt = rangeOffsets + i * 2 + rangeOffset + (cp - start) * 2
        const glyph = view.getUint16(glyphAt)
        return glyph === 0 ? 0 : (glyph + delta) & 0xffff
      }
      return 0
    }
  }

  return fail("no Unicode cmap")
}

// ---------------------------------------------------------------------------
// Bundled fonts
// ---------------------------------------------------------------------------

/** Inter 4.1 (SIL OFL 1.1), vendored in assets/fonts/inter. */
export const VIDEO_FONTS = {
  bold: "Inter-Bold.ttf",
  medium: "Inter-Medium.ttf",
} as const

export type VideoFontWeight = keyof typeof VIDEO_FONTS

export function fontDirectory() {
  return path.join(process.cwd(), "assets", "fonts", "inter")
}

const cache = new Map<string, FontMetrics>()

export function loadVideoFont(weight: VideoFontWeight): FontMetrics {
  const file = path.join(fontDirectory(), VIDEO_FONTS[weight])
  let font = cache.get(file)
  if (!font) {
    font = parseFont(readFileSync(file))
    cache.set(file, font)
  }
  return font
}

/** Characters in `text` the font can't draw (spaces always count as drawable). */
export function missingGlyphs(font: FontMetrics, text: string): string[] {
  const missing = new Set<string>()
  for (const char of text) {
    const cp = char.codePointAt(0)!
    // Joiners and variation selectors have no glyph of their own.
    if (cp === 0x20 || cp === 0x200d || cp === 0x200c) continue
    if (cp >= 0xfe00 && cp <= 0xfe0f) continue
    if (!font.hasGlyph(cp)) missing.add(char)
  }
  return [...missing]
}

/** Width of `text` in pixels at `fontSize` (no kerning, so slightly generous). */
export function measureText(font: FontMetrics, text: string, fontSize: number) {
  let units = 0
  for (const char of text) units += font.advance(char.codePointAt(0)!)
  return (units * fontSize) / font.unitsPerEm
}
