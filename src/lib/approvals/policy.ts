export const APPROVAL_POLICY = "approval-policy/1"
export const DECISION_FORMAT = "approval-decision/1"

export const CHECKLIST = {
  watched:
    "I watched the entire video or inspected the downloaded MP4 in a compatible player.",
  imagery:
    "The images match the intended product and do not show obviously misleading representations.",
  presentation:
    "The captions and visuals are acceptable. I checked for clipping, readability and timing issues.",
  claims:
    "I checked the factual claims, including text visible in photos, against the available evidence and confirmed the video makes no unsupported promises.",
  disclosure:
    "I verified that the disclosure is noticeable, considered platform overlays and understand additional platform settings may be required.",
  rights:
    "I reviewed the rights declaration and supporting description and confirm the selected media can be used for this promotion.",
  affiliate:
    "I checked that the pinned affiliate URL is the intended destination for the product.",
} as const

export type ChecklistKey = keyof typeof CHECKLIST
export type Checklist = Record<ChecklistKey, true>
export const REVISION_CATEGORIES = [
  "Product claim",
  "Caption",
  "Disclosure",
  "Media rights",
  "Wrong imagery",
  "Video quality",
  "Timing",
  "Other",
] as const
export const DECISIONS = [
  "approved",
  "revision_requested",
  "rejected",
  "withdrawn",
] as const
export type DecisionKind = (typeof DECISIONS)[number]
export const DECISION_LABEL = {
  approved: "Human Approved — Not Scheduled",
  revision_requested: "Revision Requested",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  pending: "Pending",
} as const

export interface DecisionInput {
  requestId: string
  expectedDecisionId: string | null
  reviewId: string
  kind: DecisionKind
  notes: string
  reason: string
  checklist: Checklist | null
  revision: {
    categories: string[]
    sceneIds: string[]
    correction: string
  } | null
}

export function hasChecklist(value: unknown): value is Checklist {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const keys = Object.keys(CHECKLIST) as ChecklistKey[]
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => (value as Checklist)[key] === true)
  )
}

export function decisionTransition(
  prior: DecisionKind | null,
  next: DecisionKind,
  sameReview: boolean,
) {
  if (next === "withdrawn") return prior === "approved"
  if (prior === "revision_requested") return false
  if (prior === "approved" && sameReview) return false
  return prior !== next || (next === "approved" && !sameReview)
}

export function safeExternalUrl(value: string) {
  try {
    const url = new URL(value)
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}

export const APPROVAL_REASONS = {
  archived: "Restore the archived ticket and review its current inputs.",
  superseded: "Review the newest Pixel video for this product.",
  inputs_changed:
    "Produce a video and Vera review from the current product and campaign inputs.",
  lineage:
    "The pinned Scout, Quill and Pixel records failed integrity verification.",
  missing_review: "Run Vera on this exact video version.",
  review_integrity: "The Vera report does not verify against this video.",
  qa_blocked: "Resolve Vera's findings and obtain a passing review.",
  media_integrity:
    "The MP4 is missing or its checksum differs from the recorded video.",
  rights:
    "Record a commercial media-rights basis with supporting details for licenses, permissions or affiliate terms. Confirm the selected images when starting the Pixel render.",
  affiliate:
    "Save a valid affiliate destination and produce a video from the updated inputs.",
} as const
export type ApprovalReason = keyof typeof APPROVAL_REASONS

export function hasRightsBasis(rights: string, note: string) {
  return (
    rights === "owned" ||
    (["licensed", "permission", "affiliate_program"].includes(rights) &&
      note.trim().split(/\s+/).length >= 3 &&
      note.trim().length >= 15)
  )
}
