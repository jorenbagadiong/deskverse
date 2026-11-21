/**
 * Measured quantities in product text (DV-005A): "1.7 L", "1,500 ml",
 * "2200W", "30 hours", "20 x 15 x 10 cm", "57 fl oz". Values are converted
 * to a base unit per dimension so equal amounts in different units match
 * (1.7 L = 1700 ml ≈ 57.5 fl oz) and different amounts conflict.
 *
 * Only well-known units are recognised; anything else is compared as text.
 */

export type Dimension =
  | "volume"
  | "mass"
  | "length"
  | "power"
  | "voltage"
  | "charge"
  | "energy"
  | "time"
  | "frequency"
  | "data"
  | "temperature"
  | "percent"
  | "speed"
  | "sound"

export interface Quantity {
  /** Base-unit values (one, or three for "a x b x c" dimensions). */
  values: number[]
  dimension: Dimension
  /** As written, e.g. "1.7 L". */
  text: string
}

const UNITS: [RegExp, Dimension, number][] = [
  [/^(fl\.?\s?oz|fluid ounces?)$/i, "volume", 0.0295735],
  [/^(ml|millilit(er|re)s?|mL)$/i, "volume", 0.001],
  [/^(cl|centilit(er|re)s?)$/i, "volume", 0.01],
  [/^(l|lit(er|re)s?|ltr)$/i, "volume", 1],
  [/^(gal|gallons?)$/i, "volume", 3.78541],
  [/^(mg|milligrams?)$/i, "mass", 0.000001],
  [/^(kg|kgs|kilograms?|kilos?)$/i, "mass", 1],
  [/^(g|grams?|gr)$/i, "mass", 0.001],
  [/^(lb|lbs|pounds?)$/i, "mass", 0.453592],
  [/^(oz|ounces?)$/i, "mass", 0.0283495],
  [/^(mm|millimet(er|re)s?)$/i, "length", 0.001],
  [/^(cm|centimet(er|re)s?)$/i, "length", 0.01],
  [/^(m|met(er|re)s?)$/i, "length", 1],
  [/^(in|inch|inches|")$/i, "length", 0.0254],
  [/^(ft|feet|foot)$/i, "length", 0.3048],
  [/^(kw|kilowatts?)$/i, "power", 1000],
  [/^(w|watts?)$/i, "power", 1],
  [/^(v|volts?)$/i, "voltage", 1],
  [/^(mah)$/i, "charge", 1],
  [/^(ah)$/i, "charge", 1000],
  [/^(wh)$/i, "energy", 1],
  [/^(kwh)$/i, "energy", 1000],
  [/^(h|hrs?|hours?)$/i, "time", 3600],
  [/^(min|mins|minutes?)$/i, "time", 60],
  [/^(s|secs?|seconds?)$/i, "time", 1],
  [/^(hz|hertz)$/i, "frequency", 1],
  [/^(khz)$/i, "frequency", 1e3],
  [/^(mhz)$/i, "frequency", 1e6],
  [/^(ghz)$/i, "frequency", 1e9],
  [/^(mb)$/i, "data", 0.001],
  [/^(gb)$/i, "data", 1],
  [/^(tb)$/i, "data", 1000],
  [/^(°c|℃|degrees? c(elsius)?)$/i, "temperature", 1],
  [/^(%|percent)$/i, "percent", 1],
  [/^(rpm)$/i, "speed", 1],
  [/^(db)$/i, "sound", 1],
]

const UNIT_PATTERN =
  'fl\\.?\\s?oz|fluid ounces?|millilit(?:er|re)s?|centilit(?:er|re)s?|lit(?:er|re)s?|ltr|gallons?|gal|milligrams?|kilograms?|kilos?|kgs?|grams?|gr|pounds?|lbs?|ounces?|oz|millimet(?:er|re)s?|centimet(?:er|re)s?|met(?:er|re)s?|inch(?:es)?|feet|foot|ft|kilowatts?|kwh|kw|watts?|wh|w|volts?|v|mah|ah|hours?|hrs?|h|minutes?|mins?|min|seconds?|secs?|s|khz|mhz|ghz|hz|hertz|mb|gb|tb|°c|℃|degrees? c(?:elsius)?|percent|%|rpm|db|ml|cl|mg|mm|cm|in|kg|g|l|m|"'

const NUMBER = "(\\d{1,3}(?:[,\\s]\\d{3})+(?:\\.\\d+)?|\\d+(?:[.,]\\d+)?)"

const SINGLE = new RegExp(`${NUMBER}\\s?(${UNIT_PATTERN})(?![a-z])`, "gi")
const TRIPLE = new RegExp(
  `${NUMBER}\\s?(?:${UNIT_PATTERN})?\\s?[x×*]\\s?${NUMBER}\\s?(?:${UNIT_PATTERN})?\\s?[x×*]\\s?${NUMBER}\\s?(${UNIT_PATTERN})(?![a-z])`,
  "gi",
)

function toNumber(raw: string) {
  // "1,500" (thousands) vs "1,5" (decimal comma).
  const t = raw.replace(/\s/g, "")
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ""))
  return Number(t.replace(",", "."))
}

function unitOf(raw: string): [Dimension, number] | null {
  const u = raw.trim()
  for (const [re, dim, factor] of UNITS) if (re.test(u)) return [dim, factor]
  return null
}

/** Every recognised quantity in a piece of text (at most 20). */
export function parseQuantities(text: string): Quantity[] {
  const out: Quantity[] = []
  const used: [number, number][] = []
  for (const m of text.matchAll(TRIPLE)) {
    const unit = unitOf(m[4])
    if (!unit) continue
    const [dim, factor] = unit
    out.push({
      values: [m[1], m[2], m[3]].map((n) => toNumber(n) * factor),
      dimension: dim,
      text: m[0].trim(),
    })
    used.push([m.index!, m.index! + m[0].length])
  }
  for (const m of text.matchAll(SINGLE)) {
    if (used.some(([a, b]) => m.index! >= a && m.index! < b)) continue
    const unit = unitOf(m[2])
    if (!unit) continue
    // "2 in 1", "3 in the box": a spaced "in" followed by a word isn't inches.
    if (
      /^in$/i.test(m[2]) &&
      /\s/.test(m[0]) &&
      /^\s+\w/.test(text.slice(m.index! + m[0].length))
    )
      continue
    out.push({
      values: [toNumber(m[1]) * unit[1]],
      dimension: unit[0],
      text: m[0].trim(),
    })
    if (out.length >= 20) break
  }
  return out
}

/** Equal within 2 % (rounding between units), per value. */
export function sameQuantity(a: Quantity, b: Quantity) {
  if (a.dimension !== b.dimension || a.values.length !== b.values.length)
    return false
  const x = [...a.values].sort((p, q) => p - q)
  const y = [...b.values].sort((p, q) => p - q)
  return x.every((v, i) => {
    const w = y[i]
    const scale = Math.max(Math.abs(v), Math.abs(w))
    return scale === 0 || Math.abs(v - w) / scale <= 0.02
  })
}

/** Compatible (same dimension and shape) but materially different. */
export function differentQuantity(a: Quantity, b: Quantity) {
  return (
    a.dimension === b.dimension &&
    a.values.length === b.values.length &&
    !sameQuantity(a, b)
  )
}
