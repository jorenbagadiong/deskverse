/**
 * JSON-LD Product data (schema.org) from <script type="application/ld+json">
 * blocks (DV-005A). Parsed as JSON only, never executed. Bounded: at most
 * 30 blocks of 256 KB, 8 levels deep, 500 nodes.
 *
 * Every extracted fact keeps a compact re-serialisation of the JSON it came
 * from as its evidence passage, so a claim can be traced to the exact
 * structured data on the page.
 */

export interface StructuredFact {
  label: string
  value: string
  /** e.g. "JSON-LD Product.additionalProperty “Capacity”". */
  location: string
  /** The JSON fragment, re-serialised (≤ 400 characters). */
  passage: string
  /** Time-sensitive values (offers, ratings) are flagged. */
  timeSensitive: boolean
}

export interface JsonLdProduct {
  name: string | null
  facts: StructuredFact[]
}

export interface JsonLdResult {
  products: JsonLdProduct[]
  blocks: number
  invalidBlocks: number
  /** schema.org isAccessibleForFree: false somewhere on the page. */
  paywalled: boolean
}

const MAX_BLOCKS = 30
const MAX_BLOCK_CHARS = 256 * 1024
const MAX_DEPTH = 8
const MAX_NODES = 500

const PRODUCT_TYPES = new Set([
  "product",
  "productmodel",
  "individualproduct",
  "productgroup",
  "someproducts",
])

const UNIT_CODES: Record<string, string> = {
  LTR: "L",
  MLT: "ml",
  KGM: "kg",
  GRM: "g",
  LBR: "lb",
  ONZ: "oz",
  CMT: "cm",
  MMT: "mm",
  MTR: "m",
  INH: "in",
  FOT: "ft",
  WTT: "W",
  KWT: "kW",
  VLT: "V",
  HUR: "h",
  MIN: "min",
  SEC: "s",
  AMH: "Ah",
  HTZ: "Hz",
  E34: "GB",
  E35: "TB",
  P1: "%",
}

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s

function typesOf(node: Record<string, unknown>) {
  const t = node["@type"]
  const list = Array.isArray(t) ? t : [t]
  return list
    .filter((x): x is string => typeof x === "string")
    .map((x) =>
      x.replace(/^(https?:\/\/schema\.org\/|schema:)/i, "").toLowerCase(),
    )
}

function text(value: unknown): string | null {
  if (typeof value === "string") {
    const v = value.replace(/\s+/g, " ").trim()
    return v ? clip(v, 300) : null
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>
    return text(o.name) ?? text(o["@value"]) ?? null
  }
  return null
}

function quantity(value: unknown): string | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>
    const v = text(o.value)
    if (!v) return null
    const unit =
      text(o.unitText) ??
      (typeof o.unitCode === "string"
        ? (UNIT_CODES[o.unitCode] ?? o.unitCode)
        : null)
    return unit ? `${v} ${unit}` : v
  }
  return text(value)
}

const fragment = (value: unknown) => {
  try {
    return clip(JSON.stringify(value), 400)
  } catch {
    return ""
  }
}

function productFacts(node: Record<string, unknown>): JsonLdProduct {
  const facts: StructuredFact[] = []
  const add = (
    label: string,
    value: string | null,
    source: unknown,
    location: string,
    timeSensitive = false,
  ) => {
    if (!value || facts.length >= 120) return
    facts.push({
      label,
      value: clip(value, 200),
      location: `JSON-LD Product.${location}`,
      passage: fragment({ [location.split(" ")[0]]: source }),
      timeSensitive,
    })
  }
  const name = text(node.name)
  add("Name", name, node.name, "name")
  add("Brand", text(node.brand), node.brand, "brand")
  add(
    "Manufacturer",
    text(node.manufacturer),
    node.manufacturer,
    "manufacturer",
  )
  add("Model", text(node.model), node.model, "model")
  for (const key of [
    "mpn",
    "sku",
    "gtin",
    "gtin8",
    "gtin12",
    "gtin13",
    "gtin14",
  ])
    add(key.toUpperCase(), text(node[key]), node[key], key)
  add("Color", text(node.color), node.color, "color")
  add("Material", text(node.material), node.material, "material")
  for (const key of ["weight", "width", "height", "depth"])
    add(
      key[0].toUpperCase() + key.slice(1),
      quantity(node[key]),
      node[key],
      key,
    )
  const description = text(node.description)
  if (description)
    facts.push({
      label: "Description",
      value: clip(description, 200),
      location: "JSON-LD Product.description",
      passage: fragment({ description: clip(String(node.description), 380) }),
      timeSensitive: false,
    })
  const props = Array.isArray(node.additionalProperty)
    ? node.additionalProperty
    : node.additionalProperty
      ? [node.additionalProperty]
      : []
  for (const p of props.slice(0, 60)) {
    if (!p || typeof p !== "object") continue
    const o = p as Record<string, unknown>
    const label = text(o.name) ?? text(o.propertyID)
    const value = quantity(o)
    if (label && value)
      add(label, value, p, `additionalProperty “${clip(label, 40)}”`)
  }
  const offers = Array.isArray(node.offers)
    ? node.offers
    : node.offers
      ? [node.offers]
      : []
  for (const offer of offers.slice(0, 3)) {
    if (!offer || typeof offer !== "object") continue
    const o = offer as Record<string, unknown>
    const currency = text(o.priceCurrency) ?? ""
    const price = text(o.price) ?? text(o.lowPrice)
    if (price)
      add("Price", `${price} ${currency}`.trim(), offer, "offers.price", true)
    const availability = text(o.availability)
    if (availability)
      add(
        "Availability",
        availability.replace(/^https?:\/\/schema\.org\//i, ""),
        o.availability,
        "offers.availability",
        true,
      )
  }
  const rating = node.aggregateRating as Record<string, unknown> | undefined
  if (rating && typeof rating === "object") {
    const value = text(rating.ratingValue)
    if (value)
      add(
        "Rating",
        `${value}${text(rating.bestRating) ? ` of ${text(rating.bestRating)}` : ""}${(text(rating.reviewCount) ?? text(rating.ratingCount)) ? ` (${text(rating.reviewCount) ?? text(rating.ratingCount)} ratings)` : ""}`,
        rating,
        "aggregateRating",
        true,
      )
  }
  return { name, facts }
}

export function extractJsonLd(blocks: string[]): JsonLdResult {
  const result: JsonLdResult = {
    products: [],
    blocks: 0,
    invalidBlocks: 0,
    paywalled: false,
  }
  let nodes = 0
  const visit = (value: unknown, depth: number) => {
    if (depth > MAX_DEPTH || nodes > MAX_NODES || value === null) return
    if (Array.isArray(value)) {
      for (const v of value.slice(0, 100)) visit(v, depth + 1)
      return
    }
    if (typeof value !== "object") return
    nodes++
    const node = value as Record<string, unknown>
    if (
      node.isAccessibleForFree === false ||
      node.isAccessibleForFree === "False"
    )
      result.paywalled = true
    if (typeTest(node)) {
      if (result.products.length < 10) result.products.push(productFacts(node))
      return
    }
    for (const key of [
      "@graph",
      "mainEntity",
      "mainEntityOfPage",
      "itemListElement",
      "item",
      "hasVariant",
    ])
      if (key in node) visit(node[key], depth + 1)
  }
  for (const raw of blocks.slice(0, MAX_BLOCKS)) {
    result.blocks++
    if (raw.length > MAX_BLOCK_CHARS) {
      result.invalidBlocks++
      continue
    }
    try {
      visit(JSON.parse(raw), 0)
    } catch {
      result.invalidBlocks++
    }
  }
  return result
}

function typeTest(node: Record<string, unknown>) {
  return typesOf(node).some((t) => PRODUCT_TYPES.has(t))
}
