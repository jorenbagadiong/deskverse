/**
 * Scout research contract (DV-005A), shared by the server and the browser.
 *
 * Vocabulary:
 * - supported: a retrieved source passage states it. "Source-supported",
 *   not a guarantee that it is objectively true.
 * - conflicting: retrieved sources (or a source and the owner) give
 *   materially incompatible values.
 * - unverified: the owner stated it, but no retrieved source supports it.
 * - insufficient_evidence: no usable source was available to check it.
 */

export const CLAIM_STATUSES = [
  "supported",
  "conflicting",
  "unverified",
  "insufficient_evidence",
] as const
export type ClaimStatus = (typeof CLAIM_STATUSES)[number]

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  supported: "Supported by a source",
  conflicting: "Conflicting",
  unverified: "Unverified",
  insufficient_evidence: "Insufficient evidence",
}

export const SOURCE_OUTCOMES = [
  "ok",
  "invalid_url",
  "blocked_address",
  "dns_failed",
  "robots_disallowed",
  "robots_unavailable",
  "redirect_refused",
  "too_many_redirects",
  "login_required",
  "paywall",
  "captcha",
  "forbidden",
  "not_found",
  "rate_limited",
  "server_error",
  "http_error",
  "timeout",
  "network_error",
  "unsupported_type",
  "too_large",
  "javascript_required",
  "product_mismatch",
  "no_content",
  "affiliate_link_skipped",
  "not_attempted",
] as const
export type SourceOutcome = (typeof SOURCE_OUTCOMES)[number]

export const SOURCE_OUTCOME_LABEL: Record<SourceOutcome, string> = {
  ok: "Read",
  invalid_url: "Not a usable address",
  blocked_address: "Blocked address (not public)",
  dns_failed: "Site not found",
  robots_disallowed: "Not allowed by robots.txt",
  robots_unavailable: "Permission couldn't be confirmed",
  redirect_refused: "Unsafe redirect refused",
  too_many_redirects: "Too many redirects",
  login_required: "Login required",
  paywall: "Paywall",
  captcha: "CAPTCHA or bot check",
  forbidden: "Access refused (HTTP 403)",
  not_found: "Page not found",
  rate_limited: "Rate limited (HTTP 429)",
  server_error: "Site error",
  http_error: "Unexpected response",
  timeout: "Timed out",
  network_error: "Couldn't connect",
  unsupported_type: "Unsupported format",
  too_large: "Too large",
  javascript_required: "Needs JavaScript",
  product_mismatch: "Couldn't confirm it's this product",
  no_content: "No readable content",
  affiliate_link_skipped: "Affiliate link (not visited)",
  not_attempted: "Not attempted (limit)",
}

export type ReferenceKind =
  "listing" | "manufacturer" | "review" | "demo_video" | "other"

/**
 * How much weight a source carries. "manufacturer" means the OWNER
 * labelled it a manufacturer page and Scout matched the product on it;
 * Scout never decides a page is official from its title or a model.
 */
export type SourceTrust =
  "manufacturer" | "seller_listing" | "independent_review" | "unknown"

export const SOURCE_TRUST_LABEL: Record<SourceTrust, string> = {
  manufacturer: "Manufacturer page (as labelled by you)",
  seller_listing: "Seller or product listing",
  independent_review: "Review or demonstration",
  unknown: "Other source",
}

export type EvidenceMethod =
  | "json-ld"
  | "html-meta"
  | "html-table"
  | "html-list"
  | "html-text"
  | "text-plain"
  | "ollama"

export type EvidenceRelationship = "supports" | "contradicts" | "context"

/** Owner claims about these topics are flagged; Scout never invents them. */
export const SENSITIVE_TOPICS = [
  "price",
  "discount",
  "commission",
  "rating",
  "performance",
  "health",
  "certification",
  "warranty",
  "delivery",
  "stock",
  "superiority",
] as const
export type SensitiveTopic = (typeof SENSITIVE_TOPICS)[number]

export interface ResearchSource {
  key: string
  position: number
  referenceKind: ReferenceKind
  label: string
  requestedUrl: string
  finalUrl: string | null
  title: string | null
  outcome: SourceOutcome
  httpStatus: number | null
  contentType: string | null
  byteCount: number
  contentSha256: string | null
  retrievedAt: string | null
  trust: SourceTrust
  identified: boolean
  transport: "https" | "http" | null
  detail: string | null
}

export interface ResearchEvidence {
  key: string
  sourceKey: string
  method: EvidenceMethod
  location: string
  passage: string
  statement: string
  attribute: string | null
  value: string | null
  model: string | null
}

export interface ResearchClaim {
  key: string
  origin: "owner" | "source"
  kind: "attribute" | "statement" | "identity"
  attribute: string | null
  value: string | null
  statement: string
  status: ClaimStatus
  reason: string
  topic: SensitiveTopic | null
  timeSensitive: boolean
  evidence: { key: string; relationship: EvidenceRelationship }[]
}

/** The versioned brief ("scout-brief/1"). Sections reference claim/evidence keys. */
export interface ResearchBrief {
  format: "scout-brief/1"
  status: "complete" | "insufficient_evidence"
  product: {
    name: string
    identification: "identified" | "not_identified"
    identifiedAs: string | null
    identifiers: { label: string; value: string; evidence: string[] }[]
  }
  supportedFacts: string[]
  unverifiedOwnerClaims: string[]
  conflicts: string[]
  insufficient: string[]
  features: string[]
  sellingPoints: { text: string; claims: string[]; basis: string }[]
  timeSensitive: { claim: string; retrievedAt: string }[]
  limitations: string[]
  ownerActions: string[]
  extraction: {
    mode: "deterministic" | "deterministic+ollama"
    model: {
      name: string
      digest: string | null
      ollamaVersion: string | null
    } | null
    modelClaimsAccepted: number
    modelClaimsRejected: number
    note: string | null
  }
  generatedAt: string
}

export interface ResearchReport {
  id: string
  runId: string
  taskId: string
  snapshotId: string
  productId: string
  productName: string
  reportVersion: number
  schemaVersion: number
  status: ResearchBrief["status"]
  createdAt: string
  checksum: string
  snapshotChecksum: string
  /** Recomputed from the stored rows on every read. */
  integrity: "verified" | "mismatch"
  brief: ResearchBrief
  sources: ResearchSource[]
  claims: ResearchClaim[]
  evidence: {
    items: ResearchEvidence[]
    total: number
    offset: number
    limit: number
  }
}

export interface ResearchReportSummary {
  id: string
  runId: string
  snapshotId: string
  productId: string
  productName: string
  reportVersion: number
  status: ResearchBrief["status"]
  createdAt: string
  counts: Record<ClaimStatus, number>
  sources: { read: number; total: number }
}

export interface ResearchTaskState {
  snapshotId: string
  productId: string
  productName: string
  taskId: string
  status: string
  attempts: number
  failureMessage: string | null
  /** Per-source problems recorded when the task needed input or failed. */
  sourceProblems: { host: string; outcome: SourceOutcome }[]
  reportId: string | null
}

export interface ResearchOverview {
  availability: ResearchAvailability
  latestRun: {
    id: string
    status: string
    ticketVersion: number
    createdAt: string
    tasks: ResearchTaskState[]
  } | null
  reports: ResearchReportSummary[]
}

export interface ResearchAvailability {
  /** A research-only run can be planned (Scout registered and retrieval on). */
  available: boolean
  retrieval: boolean
  extraction: "deterministic" | "ollama"
  reason: string | null
}

export interface ScoutDiagnostics {
  handlerRegistered: boolean
  retrieval: { enabled: boolean; maxSources: number; maxPageKB: number }
  extraction: {
    mode: "deterministic" | "ollama"
    ollama: {
      configured: boolean
      endpoint: string | null
      model: string | null
      reachable: boolean | null
      modelAvailable: boolean | null
      version: string | null
      problem: string | null
    }
  }
  researchWorkflow: { id: string; available: boolean }
  fullCampaign: { available: boolean; missing: string[] }
  worker: {
    status: "running" | "not_seen" | "unknown"
    lastSeenSecondsAgo: number | null
    handlesResearch: boolean
  }
  missingConfiguration: string[]
}

export const researchEndpoint = (ticketId: string) =>
  `/api/tickets/${encodeURIComponent(ticketId)}/research`
export const reportEndpoint = (
  ticketId: string,
  runId: string,
  snapshotId: string,
) =>
  `/api/tickets/${encodeURIComponent(ticketId)}/runs/${encodeURIComponent(runId)}/research/${encodeURIComponent(snapshotId)}`
export const SCOUT_DIAGNOSTICS_ENDPOINT = "/api/system/scout"
