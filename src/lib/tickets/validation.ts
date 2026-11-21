import {
  MEDIA_RIGHTS,
  REFERENCE_KINDS,
  TICKET_LIMITS,
  TICKET_PLATFORMS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TEXT_LIMITS,
  TITLE_MIN_LENGTH,
  type MediaRights,
  type PublishingPreferences,
  type ReferenceKind,
  type TicketPlatform,
  type TicketPriority,
  type TicketStatus,
} from "@/lib/tickets/types"

/**
 * Affiliate Ticket validation (DV-004B). Pure and client-safe: the studio
 * uses it for instant feedback, and the server is the authority.
 *
 * Inputs are strict: unknown keys are refused, so a typo or a stale client
 * can never silently drop or smuggle data.
 */

export interface Issue {
  path: string
  message: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; issues: Issue[] }

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = (path: string, message: string): Result<never> => ({
  ok: false,
  issues: [{ path, message }],
})

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Control and invisible formatting characters (bidirectional overrides can
 * visually reorder text). Newlines and tabs are allowed in long text.
 */
const FORBIDDEN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]|\p{Cs}/u

export const codePoints = (text: string) => Array.from(text).length

/** Single-line text: NFC, whitespace collapsed, trimmed. */
export function normalizeLine(raw: string) {
  return raw.normalize("NFC").replace(/\s+/gu, " ").trim()
}

/** Multi-line text: NFC, \r\n → \n, trailing spaces and outer blank lines removed. */
export function normalizeMultiline(raw: string) {
  return raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function text(
  raw: unknown,
  path: string,
  label: string,
  max: number,
  { multiline = false, min = 0 }: { multiline?: boolean; min?: number } = {},
): Result<string> {
  if (typeof raw !== "string") return fail(path, `${label} must be text.`)
  const value = multiline ? normalizeMultiline(raw) : normalizeLine(raw)
  if (FORBIDDEN.test(value))
    return fail(
      path,
      `${label} contains invisible or control characters. Retype it without them.`,
    )
  const length = codePoints(value)
  if (length > max)
    return fail(
      path,
      `${label} must be ${max} characters or fewer (currently ${length}).`,
    )
  if (length < min)
    return fail(
      path,
      min === 1
        ? `Enter ${label.toLowerCase()}.`
        : `${label} must be at least ${min} characters.`,
    )
  return ok(value)
}

// ---------------------------------------------------------------------------
// URLs (stored only; never fetched in DV-004B)
// ---------------------------------------------------------------------------

/**
 * Accepts only absolute http(s) URLs with a host, no user name or password,
 * no whitespace, at most 2048 characters. Returns the parsed, normalized form
 * (the WHATWG URL serialization), which is what is stored.
 */
export function validateWebUrl(
  raw: unknown,
  path: string,
  label: string,
): Result<string> {
  if (typeof raw !== "string") return fail(path, `${label} must be text.`)
  const value = raw.trim()
  if (value === "") return fail(path, `Enter ${label.toLowerCase()}.`)
  if (value.length > TICKET_TEXT_LIMITS.url)
    return fail(
      path,
      `${label} must be ${TICKET_TEXT_LIMITS.url} characters or fewer.`,
    )
  if (/[\s\u0000-\u001F\u007F]/.test(value) || FORBIDDEN.test(value))
    return fail(path, `${label} can't contain spaces or control characters.`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return fail(
      path,
      `${label} must be a full web address starting with https:// (or http://).`,
    )
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return fail(path, `${label} must start with https:// or http://.`)
  if (!url.hostname.includes(".") || url.hostname.endsWith("."))
    return fail(path, `${label} needs a website name, like example.com.`)
  if (url.username !== "" || url.password !== "")
    return fail(
      path,
      `${label} can't contain a user name or password. Remove the part before “@”.`,
    )
  const normalized = url.href
  if (normalized.length > TICKET_TEXT_LIMITS.url)
    return fail(
      path,
      `${label} must be ${TICKET_TEXT_LIMITS.url} characters or fewer.`,
    )
  return ok(normalized)
}

/** Affiliate links may be empty in a Draft (filled in later). */
function optionalUrl(
  raw: unknown,
  path: string,
  label: string,
): Result<string> {
  if (typeof raw === "string" && raw.trim() === "") return ok("")
  return validateWebUrl(raw, path, label)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function unknownKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  base: string,
): Issue[] {
  return Object.keys(input)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({
      path: base ? `${base}.${key}` : key,
      message: `“${key}” isn't a field that can be saved here.`,
    }))
}

function oneOf<T extends string>(
  raw: unknown,
  values: readonly T[],
  path: string,
  label: string,
): Result<T> {
  return typeof raw === "string" && (values as readonly string[]).includes(raw)
    ? ok(raw as T)
    : fail(path, `Choose a valid ${label.toLowerCase()}.`)
}

/** Collects field results into one object, or every issue found. */
function collect<T extends object>(
  entries: { [K in keyof T]?: Result<T[K]> },
  extra: Issue[] = [],
): Result<Partial<T>> {
  const issues = [...extra]
  const value: Partial<T> = {}
  for (const key of Object.keys(entries) as (keyof T)[]) {
    const result = entries[key]
    if (!result) continue
    if (result.ok) value[key] = result.value
    else issues.push(...result.issues)
  }
  return issues.length > 0 ? { ok: false, issues } : ok(value)
}

// ---------------------------------------------------------------------------
// Ticket
// ---------------------------------------------------------------------------

export interface TicketFields {
  title: string
  description: string
  instructions: string
  priority: TicketPriority
  platform: TicketPlatform
  publishingPreferences: PublishingPreferences
}

const TICKET_FIELD_KEYS = [
  "title",
  "description",
  "instructions",
  "priority",
  "platform",
  "publishingPreferences",
] as const

export function validateTitle(raw: unknown, path = "title"): Result<string> {
  const result = text(raw, path, "Title", TICKET_TEXT_LIMITS.title, { min: 1 })
  if (!result.ok) return result
  if (codePoints(result.value) < TITLE_MIN_LENGTH)
    return fail(
      path,
      `Give the ticket a meaningful title (at least ${TITLE_MIN_LENGTH} characters).`,
    )
  if (!/[\p{L}\p{N}]/u.test(result.value))
    return fail(path, "The title needs at least one letter or number.")
  return result
}

function validatePreferences(
  raw: unknown,
  path: string,
): Result<PublishingPreferences> {
  if (!isRecord(raw))
    return fail(path, "Publishing preferences must be an object.")
  const result = collect<{ schedule: string; notes: string }>(
    {
      schedule: text(
        raw.schedule ?? "",
        `${path}.schedule`,
        "Publishing schedule",
        TICKET_TEXT_LIMITS.schedule,
      ),
      notes: text(
        raw.notes ?? "",
        `${path}.notes`,
        "Publishing notes",
        TICKET_TEXT_LIMITS.publishingNotes,
        { multiline: true },
      ),
    },
    unknownKeys(raw, ["schedule", "notes"], path),
  )
  return result.ok
    ? ok({
        schedule: result.value.schedule ?? "",
        notes: result.value.notes ?? "",
      })
    : result
}

/**
 * New ticket: only the title is required; everything else has defaults.
 * `requestId` makes a repeated submission (double click, retry after a
 * timeout) return the same ticket instead of creating a second one.
 */
export interface NewTicket extends TicketFields {
  requestId: string
}

const REQUEST_ID = /^[A-Za-z0-9-]{16,64}$/

export function validateNewTicket(input: unknown): Result<NewTicket> {
  if (!isRecord(input)) return fail("", "Send the ticket as a JSON object.")
  const fields = validateTicketPatch(
    Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== "requestId"),
    ),
  )
  const issues = fields.ok ? [] : [...fields.issues]
  if (!("title" in input) && !issues.some((i) => i.path === "title"))
    issues.push({ path: "title", message: "Enter a title." })
  if (typeof input.requestId !== "string" || !REQUEST_ID.test(input.requestId))
    issues.push({
      path: "requestId",
      message: "Missing request identifier. Reload the page and try again.",
    })
  if (issues.length > 0 || !fields.ok) return { ok: false, issues }
  return ok({
    title: fields.value.title!,
    description: fields.value.description ?? "",
    instructions: fields.value.instructions ?? "",
    priority: fields.value.priority ?? "normal",
    platform: fields.value.platform ?? "tiktok",
    publishingPreferences: fields.value.publishingPreferences ?? {
      schedule: "",
      notes: "",
    },
    requestId: input.requestId as string,
  })
}

/** Edit: any subset of the ticket fields. */
export function validateTicketPatch(
  input: unknown,
): Result<Partial<TicketFields>> {
  if (!isRecord(input)) return fail("", "Send the changes as a JSON object.")
  const L = TICKET_TEXT_LIMITS
  return collect<TicketFields>(
    {
      title: "title" in input ? validateTitle(input.title) : undefined,
      description:
        "description" in input
          ? text(
              input.description,
              "description",
              "Description",
              L.description,
              {
                multiline: true,
              },
            )
          : undefined,
      instructions:
        "instructions" in input
          ? text(
              input.instructions,
              "instructions",
              "Instructions",
              L.instructions,
              { multiline: true },
            )
          : undefined,
      priority:
        "priority" in input
          ? oneOf(input.priority, TICKET_PRIORITIES, "priority", "Priority")
          : undefined,
      platform:
        "platform" in input
          ? oneOf(input.platform, TICKET_PLATFORMS, "platform", "Platform")
          : undefined,
      publishingPreferences:
        "publishingPreferences" in input
          ? validatePreferences(
              input.publishingPreferences,
              "publishingPreferences",
            )
          : undefined,
    },
    unknownKeys(input, TICKET_FIELD_KEYS, ""),
  )
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

export interface ReferenceInput {
  kind: ReferenceKind
  url: string
  label: string
}

export interface ProductFields {
  name: string
  affiliateUrl: string
  description: string
  specifications: string
  notes: string
  source: string
  mediaRights: MediaRights
  mediaRightsNote: string
  references: ReferenceInput[]
}

const PRODUCT_FIELD_KEYS = [
  "name",
  "affiliateUrl",
  "description",
  "specifications",
  "notes",
  "source",
  "mediaRights",
  "mediaRightsNote",
  "references",
] as const

export function validateReferences(
  raw: unknown,
  path = "references",
): Result<ReferenceInput[]> {
  if (!Array.isArray(raw)) return fail(path, "References must be a list.")
  if (raw.length > TICKET_LIMITS.referencesPerProduct)
    return fail(
      path,
      `A product can have at most ${TICKET_LIMITS.referencesPerProduct} reference links.`,
    )
  const issues: Issue[] = []
  const references: ReferenceInput[] = []
  const seen = new Set<string>()
  raw.forEach((item, index) => {
    const base = `${path}.${index}`
    if (!isRecord(item)) {
      issues.push({ path: base, message: "Each reference must be an object." })
      return
    }
    const result = collect<ReferenceInput>(
      {
        kind: oneOf(
          item.kind,
          REFERENCE_KINDS,
          `${base}.kind`,
          "Reference type",
        ),
        url: validateWebUrl(item.url, `${base}.url`, "Reference link"),
        label: text(
          item.label ?? "",
          `${base}.label`,
          "Reference label",
          TICKET_TEXT_LIMITS.referenceLabel,
        ),
      },
      unknownKeys(item, ["kind", "url", "label"], base),
    )
    if (!result.ok) {
      issues.push(...result.issues)
      return
    }
    const reference = {
      kind: result.value.kind!,
      url: result.value.url!,
      label: result.value.label ?? "",
    }
    if (seen.has(reference.url)) {
      issues.push({
        path: `${base}.url`,
        message: "This link is already in the list.",
      })
      return
    }
    seen.add(reference.url)
    references.push(reference)
  })
  return issues.length > 0 ? { ok: false, issues } : ok(references)
}

/** New or edited product: every field optional (Drafts may be incomplete). */
export function validateProductPatch(
  input: unknown,
): Result<Partial<ProductFields>> {
  if (!isRecord(input)) return fail("", "Send the product as a JSON object.")
  const L = TICKET_TEXT_LIMITS
  const long = (key: keyof typeof input, label: string) =>
    key in input
      ? text(input[key as string], String(key), label, L.productText, {
          multiline: true,
        })
      : undefined
  return collect<ProductFields>(
    {
      name:
        "name" in input
          ? text(input.name, "name", "Product name", L.productName)
          : undefined,
      affiliateUrl:
        "affiliateUrl" in input
          ? optionalUrl(input.affiliateUrl, "affiliateUrl", "Affiliate link")
          : undefined,
      description: long("description", "Description"),
      specifications: long("specifications", "Specifications and facts"),
      notes: long("notes", "Notes"),
      source:
        "source" in input
          ? text(input.source, "source", "Source", L.source, {
              multiline: true,
            })
          : undefined,
      mediaRights:
        "mediaRights" in input
          ? oneOf(
              input.mediaRights,
              MEDIA_RIGHTS,
              "mediaRights",
              "Media rights",
            )
          : undefined,
      mediaRightsNote:
        "mediaRightsNote" in input
          ? text(
              input.mediaRightsNote,
              "mediaRightsNote",
              "Media rights note",
              L.mediaRightsNote,
              { multiline: true },
            )
          : undefined,
      references:
        "references" in input
          ? validateReferences(input.references)
          : undefined,
    },
    unknownKeys(input, PRODUCT_FIELD_KEYS, ""),
  )
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 *   draft ──mark ready──▶ ready
 *     ▲ ◀──return / edit──┘
 *     │
 *   restore            draft, ready ──archive──▶ archived
 *     └──────────────────────────────────────────┘
 */
const TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  draft: ["ready", "archived"],
  ready: ["draft", "archived"],
  archived: ["draft"],
}

export function canTransition(from: TicketStatus, to: TicketStatus) {
  return TRANSITIONS[from].includes(to)
}

export function isTicketStatus(value: unknown): value is TicketStatus {
  return (
    typeof value === "string" &&
    (TICKET_STATUSES as readonly string[]).includes(value)
  )
}

export interface ReadinessInput {
  title: string
  products: { name: string; affiliateUrl: string }[]
}

/**
 * What stops a ticket being marked Ready: a valid title and at least one
 * product with a name and a valid affiliate link. Media isn't required
 * here; Pixel (DV-005C) checks its own render requirements.
 */
export function readinessIssues(ticket: ReadinessInput): Issue[] {
  const issues: Issue[] = []
  const title = validateTitle(ticket.title)
  if (!title.ok) issues.push(...title.issues)
  const complete = ticket.products.filter(
    (product) =>
      normalizeLine(product.name) !== "" &&
      validateWebUrl(product.affiliateUrl, "x", "x").ok,
  )
  if (complete.length === 0)
    issues.push({
      path: "products",
      message:
        ticket.products.length === 0
          ? "Add at least one product."
          : "At least one product needs a name and a valid affiliate link.",
    })
  return issues
}

export interface MediaCompleteness {
  images: number
  videos: number
  /** Pixel Studio's current render needs 3–6 images (DV-005C enforces it). */
  pixelReady: boolean
}

export function mediaCompleteness(
  assets: { kind: "image" | "video" }[],
): MediaCompleteness {
  const images = assets.filter((a) => a.kind === "image").length
  return {
    images,
    videos: assets.length - images,
    pixelReady: images >= 3,
  }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface ListQuery {
  status: TicketStatus | "active" | "all"
  search: string
  /** Set when the search is a ticket number ("AFT-0007", "7"). */
  number: number | null
  page: number
  pageSize: number
}

export function parseListQuery(params: URLSearchParams): Result<ListQuery> {
  const statusRaw = params.get("status") ?? "active"
  if (
    statusRaw !== "active" &&
    statusRaw !== "all" &&
    !isTicketStatus(statusRaw)
  )
    return fail("status", "Unknown status filter.")
  const search = normalizeLine(params.get("q") ?? "").slice(
    0,
    TICKET_TEXT_LIMITS.search,
  )
  const pageRaw = params.get("page") ?? "1"
  const sizeRaw = params.get("pageSize") ?? String(TICKET_LIMITS.pageSize)
  if (!/^\d{1,6}$/.test(pageRaw) || Number(pageRaw) < 1)
    return fail("page", "Page must be a positive whole number.")
  if (
    !/^\d{1,3}$/.test(sizeRaw) ||
    Number(sizeRaw) < 1 ||
    Number(sizeRaw) > TICKET_LIMITS.maxPageSize
  )
    return fail(
      "pageSize",
      `Page size must be between 1 and ${TICKET_LIMITS.maxPageSize}.`,
    )
  const numberMatch = /^(?:aft-?)?0*(\d{1,9})$/i.exec(search)
  return ok({
    status: statusRaw as ListQuery["status"],
    search,
    number: numberMatch ? Number(numberMatch[1]) : null,
    page: Number(pageRaw),
    pageSize: Number(sizeRaw),
  })
}

/** Escapes LIKE wildcards so a search for "50%" matches literally. */
export function likePattern(search: string) {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** Generated IDs (PostgreSQL gen_random_uuid): lowercase v4 UUIDs. */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value)
