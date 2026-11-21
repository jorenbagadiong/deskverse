import type { SensitiveTopic } from "@/lib/scout/types"

/**
 * Attribute names and claim topics (DV-005A).
 *
 * Different pages call the same thing different names ("Capacity",
 * "Water capacity", "Volume"); `attributeKey` maps known synonyms to one
 * key so values can be compared. Unknown labels keep their own slug and
 * only match the same label.
 */

const SYNONYMS: [string, string, RegExp][] = [
  [
    "capacity",
    "Capacity",
    /^(capacity|volume|water capacity|tank capacity|max(imum)? capacity|jug capacity|bowl capacity|liquid capacity)$/,
  ],
  [
    "power",
    "Power",
    /^(power|wattage|rated power|output power|max(imum)? power|power output|power consumption|motor power)$/,
  ],
  [
    "battery_life",
    "Battery life",
    /^(battery life|playtime|play time|runtime|run time|battery runtime|playback time|battery duration|battery)$/,
  ],
  [
    "battery_capacity",
    "Battery capacity",
    /^(battery capacity|cell capacity)$/,
  ],
  [
    "charging_time",
    "Charging time",
    /^(charging time|charge time|recharge time|time to full charge)$/,
  ],
  [
    "weight",
    "Weight",
    /^(weight|net weight|item weight|product weight|unit weight)$/,
  ],
  [
    "dimensions",
    "Dimensions",
    /^(dimensions|size|product dimensions|item dimensions|measurements|dimensions \(w x d x h\)|dimensions \(l x w x h\))$/,
  ],
  ["width", "Width", /^(width)$/],
  ["height", "Height", /^(height)$/],
  ["depth", "Depth", /^(depth|length)$/],
  ["color", "Colour", /^(colou?rs?|finish)$/],
  [
    "material",
    "Material",
    /^(materials?|body material|housing material|construction)$/,
  ],
  ["brand", "Brand", /^(brand|brand name)$/],
  // A page's "Manufacturer" may be a contract manufacturer, not the brand.
  ["manufacturer", "Manufacturer", /^(manufacturer|made by|maker)$/],
  [
    "model",
    "Model",
    /^(model|model number|model no|model name|item model number|mpn)$/,
  ],
  ["voltage", "Voltage", /^(voltage|rated voltage|input voltage)$/],
  ["frequency", "Frequency", /^(frequency|rated frequency)$/],
  ["storage", "Storage", /^(storage|internal storage|storage capacity)$/],
  ["memory", "Memory", /^(memory|ram)$/],
  ["screen_size", "Screen size", /^(screen size|display size|screen|display)$/],
  ["resolution", "Resolution", /^(resolution|display resolution)$/],
  [
    "connectivity",
    "Connectivity",
    /^(connectivity|connections|wireless connectivity)$/,
  ],
  ["noise", "Noise level", /^(noise level|noise|sound level)$/],
  ["speed", "Speed", /^(speed|max(imum)? speed|rpm)$/],
  ["warranty", "Warranty", /^(warranty|guarantee|warranty period)$/],
  ["gtin", "GTIN", /^(gtin|gtin8|gtin12|gtin13|gtin14|ean|upc|barcode)$/],
  ["sku", "SKU", /^(sku)$/],
  ["price", "Price", /^(price|list price|sale price|rrp|msrp)$/],
  ["availability", "Availability", /^(availability|stock|in stock)$/],
  ["rating", "Rating", /^(rating|customer rating|average rating|stars)$/],
]

const IDENTITY = new Set(["brand", "model", "gtin", "sku"])
const TIME_SENSITIVE = new Set(["price", "availability", "rating"])

export function attributeKey(label: string): { key: string; label: string } {
  const l = label
    .toLowerCase()
    .replace(/[:：]\s*$/, "")
    .replace(/[_*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  for (const [key, nice, re] of SYNONYMS)
    if (re.test(l)) return { key, label: nice }
  const slug = l
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60)
  const nice = label
    .replace(/[:：]\s*$/, "")
    .trim()
    .slice(0, 60)
  return { key: slug || "unknown", label: nice || "Unknown" }
}

export const isIdentity = (key: string) => IDENTITY.has(key)
export const isTimeSensitive = (key: string) => TIME_SENSITIVE.has(key)

/** Words that let a text passage mention an attribute (for text matching). */
export function attributeWords(key: string, label: string): string[] {
  const entry = SYNONYMS.find(([k]) => k === key)
  if (!entry) return [label.toLowerCase()]
  return entry[2].source
    .replace(/^\^\(|\)\$$/g, "")
    .split("|")
    .filter((w) => !/[()?\\[]/.test(w))
    .map((w) => w.toLowerCase())
}

const TOPICS: [SensitiveTopic, RegExp][] = [
  ["commission", /\bcommissions?\b|\baffiliate (fee|payout|rate)\b/i],
  [
    "discount",
    /\b(\d{1,3}\s?% off|discount(ed)?|on sale|sale price|coupon|promo(tion)? code|deal of the day|save \$?\d)/i,
  ],
  [
    "price",
    /(\$|€|£|¥|\bUSD\b|\bEUR\b|\bGBP\b|\bPHP\b|₱)\s?\d|\b\d+(\.\d+)?\s?(dollars|euros|pounds|pesos)\b|\b(price[sd]?|costs?|cheap(est)?|affordable|budget)\b/i,
  ],
  [
    "rating",
    /\b\d(\.\d)?\s?(\/\s?5|out of 5|stars?)\b|\b(rated|ratings?|reviews?|best-?seller|testimonials?)\b/i,
  ],
  [
    "health",
    /\b(cures?|heals?|treats?|treatment|medical(ly)?|clinical(ly)?|doctors?|therap(y|eutic)|immun(e|ity)|detox|weight loss|lose weight|anxiety|pain relief|disease|health(y|ier)? benefits?|boosts? (your )?health)\b/i,
  ],
  [
    "certification",
    /\b(certified|certification|fda|ce marked|ce mark|ul listed|iso \d+|approved by|bpa[- ]free|organic certified|tested by)\b/i,
  ],
  ["warranty", /\b(warrant(y|ies|ied)|guarantee[sd]?|money[- ]back)\b/i],
  [
    "delivery",
    /\b(free shipping|ships? (in|within|today)|delivery|delivered|arrives?|next[- ]day|same[- ]day)\b/i,
  ],
  [
    "stock",
    /\b(in stock|out of stock|limited stock|only \d+ left|sold out|selling fast|while stocks? last)\b/i,
  ],
  [
    "superiority",
    /\b(best|#1|number one|no\.? ?1|better than|leading|unbeatable|unmatched|superior|world'?s (most|first|best)|top[- ]rated|the most)\b/i,
  ],
  [
    "performance",
    /\b(\d+\s?x (faster|more|longer)|faster than|lasts? longer|more powerful than|saves? \d+\s?%)\b/i,
  ],
]

/** The first sensitive topic a claim touches, if any. */
export function claimTopic(text: string, key?: string): SensitiveTopic | null {
  if (key === "price") return "price"
  if (key === "rating") return "rating"
  if (key === "availability") return "stock"
  if (key === "warranty") return "warranty"
  for (const [topic, re] of TOPICS) if (re.test(text)) return topic
  return null
}

const STOP = new Set(
  "a an and are as at be by for from has have in is it its of on or our that the this to with your you will can it's very new".split(
    " ",
  ),
)

/** Significant lower-case word tokens (for identification and statement matching). */
export function tokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .match(/[a-z0-9]+(?:[.-][a-z0-9]+)*/g) ?? []
  )
    .map((t) =>
      t.length > 3 && t.endsWith("s") && !/\d/.test(t) ? t.slice(0, -1) : t,
    )
    .filter((t) => t.length >= 2 && !STOP.has(t))
}
