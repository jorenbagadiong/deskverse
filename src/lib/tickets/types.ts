/**
 * Affiliate Ticket contract (DV-004B), shared by the browser and the server.
 * Client-safe: no Node APIs, no database or file-system details.
 *
 * Everything in a ticket, its products, references and media is the
 * owner's own input. Future workers (Scout, Quill…) will write their output
 * to separate deliverable tables and never overwrite these records.
 */

export const TICKET_STATUSES = ["draft", "ready", "archived"] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

export const TICKET_PRIORITIES = ["low", "normal", "high"] as const
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]

export const TICKET_PLATFORMS = [
  "tiktok",
  "instagram_reels",
  "youtube_shorts",
  "other",
] as const
export type TicketPlatform = (typeof TICKET_PLATFORMS)[number]

export const REFERENCE_KINDS = [
  "listing",
  "manufacturer",
  "review",
  "demo_video",
  "other",
] as const
export type ReferenceKind = (typeof REFERENCE_KINDS)[number]

export const MEDIA_RIGHTS = [
  "unspecified",
  "owned",
  "licensed",
  "permission",
  "affiliate_program",
] as const
export type MediaRights = (typeof MEDIA_RIGHTS)[number]

export const ASSET_KINDS = ["image", "video"] as const
export type TicketAssetKind = (typeof ASSET_KINDS)[number]

export const TICKET_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const
export const TICKET_VIDEO_TYPES = ["video/mp4"] as const
export type TicketAssetMimeType =
  (typeof TICKET_IMAGE_TYPES)[number] | (typeof TICKET_VIDEO_TYPES)[number]

export const STATUS_LABEL: Record<TicketStatus, string> = {
  draft: "Draft",
  ready: "Ready",
  archived: "Archived",
}
export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
}
export const PLATFORM_LABEL: Record<TicketPlatform, string> = {
  tiktok: "TikTok",
  instagram_reels: "Instagram Reels",
  youtube_shorts: "YouTube Shorts",
  other: "Other",
}
export const REFERENCE_LABEL: Record<ReferenceKind, string> = {
  listing: "Product listing",
  manufacturer: "Manufacturer / specifications",
  review: "Review",
  demo_video: "Demonstration video",
  other: "Other",
}
export const MEDIA_RIGHTS_LABEL: Record<MediaRights, string> = {
  unspecified: "Not declared yet",
  owned: "I created this media",
  licensed: "Licensed for this use",
  permission: "Used with the owner's permission",
  affiliate_program: "Supplied by the affiliate program for promotion",
}

/** Text limits, in Unicode code points. */
export const TICKET_TEXT_LIMITS = {
  title: 120,
  description: 5000,
  instructions: 5000,
  schedule: 200,
  publishingNotes: 1000,
  productName: 120,
  productText: 5000,
  source: 500,
  mediaRightsNote: 500,
  referenceLabel: 200,
  url: 2048,
  search: 100,
} as const

export const TITLE_MIN_LENGTH = 3

/** Structural limits. Generous for batches; documented in docs/affiliate-tickets.md. */
export const TICKET_LIMITS = {
  productsPerTicket: 100,
  referencesPerProduct: 20,
  imagesPerProduct: 20,
  videosPerProduct: 5,
  /** JSON request bodies (ticket and product edits). */
  maxJsonBytes: 128 * 1024,
  pageSize: 20,
  maxPageSize: 50,
} as const

export interface PublishingPreferences {
  /** Free text, saved only, e.g. "One video per day, weekday evenings". */
  schedule: string
  notes: string
}

export interface TicketReference {
  id: string
  kind: ReferenceKind
  url: string
  label: string
}

export interface TicketAsset {
  id: string
  kind: TicketAssetKind
  mimeType: TicketAssetMimeType
  sizeBytes: number
  width: number
  height: number
  /** Videos only. */
  durationSeconds: number | null
  /** The uploaded file's name, for display only. */
  displayName: string
  sha256: string
  createdAt: string
  /** Same-origin URL for preview (inline) and `?download=1`. */
  url: string
}

export interface TicketProduct {
  id: string
  position: number
  name: string
  affiliateUrl: string
  description: string
  specifications: string
  notes: string
  source: string
  mediaRights: MediaRights
  mediaRightsNote: string
  references: TicketReference[]
  assets: TicketAsset[]
  createdAt: string
  updatedAt: string
}

export interface TicketSummary {
  id: string
  number: number
  /** "AFT-0001" */
  displayNumber: string
  title: string
  status: TicketStatus
  priority: TicketPriority
  platform: TicketPlatform
  productCount: number
  createdAt: string
  updatedAt: string
}

export interface TicketDetail extends TicketSummary {
  description: string
  instructions: string
  publishingPreferences: PublishingPreferences
  /** Increases with every change; PATCH requests send it back (409 if stale). */
  version: number
  readyAt: string | null
  archivedAt: string | null
  products: TicketProduct[]
}

export const TICKET_EVENT_TYPES = [
  "ticket_created",
  "ticket_edited",
  "product_added",
  "product_updated",
  "product_moved",
  "product_removed",
  "asset_uploaded",
  "asset_removed",
  "marked_ready",
  "returned_to_draft",
  "archived",
  "restored",
] as const
export type TicketEventType = (typeof TICKET_EVENT_TYPES)[number]

export interface TicketEvent {
  id: number
  type: TicketEventType
  productId: string | null
  assetId: string | null
  /** Small, non-sensitive facts: changed field names, statuses, counts. */
  details: Record<string, unknown>
  createdAt: string
}

export interface TicketList {
  tickets: TicketSummary[]
  total: number
  page: number
  pageSize: number
}

export interface ApiError {
  error: string
  message: string
  /** Field-level problems, keyed by path such as "title" or "products.0.affiliateUrl". */
  issues?: { path: string; message: string }[]
}

export const TICKETS_ENDPOINT = "/api/tickets"
export const ticketEndpoint = (ticketId: string) =>
  `${TICKETS_ENDPOINT}/${encodeURIComponent(ticketId)}`
export const productEndpoint = (ticketId: string, productId: string) =>
  `${ticketEndpoint(ticketId)}/products/${encodeURIComponent(productId)}`
export const assetEndpoint = (
  ticketId: string,
  productId: string,
  assetId: string,
) =>
  `${productEndpoint(ticketId, productId)}/assets/${encodeURIComponent(assetId)}`

/** Header carrying the upload's original file name (URI-encoded), display only. */
export const TICKET_FILE_NAME_HEADER = "x-file-name"

/** "AFT-0001"; numbers past 9999 simply grow ("AFT-12345"). */
export function formatTicketNumber(number: number) {
  return `AFT-${String(number).padStart(4, "0")}`
}
