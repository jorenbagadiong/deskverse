import type { PixelDeliverable } from "@/lib/pixel/types"
import type { RenderManifest } from "@/server/pixel/plan"

export const VERA_FORMAT = "vera-review/1"
export const VERA_RULESET = "vera-rules/1"
export const PLATFORM_CHECKLIST = "vera-platform-checklist/1"
export type Verdict = "pass" | "needs_revision" | "needs_owner_input" | "failed"
export const VERDICT_LABEL: Record<Verdict, string> = {
  pass: "Automated QA Passed",
  needs_revision: "Needs Revision",
  needs_owner_input: "Needs Owner Input",
  failed: "Failed QA",
}
export type Category =
  | "provenance"
  | "claims"
  | "disclosure"
  | "media_rights"
  | "captions"
  | "visual_composition"
  | "video_technical"
  | "audio"
  | "platform_preparation"
export type CheckOutcome =
  "passed" | "failed" | "warning" | "manual_review_required" | "not_evaluated"
export interface VeraFinding {
  ruleId: string
  ruleset: typeof VERA_RULESET
  category: Category
  severity: "info" | "warning" | "revision" | "owner" | "fatal"
  outcome: CheckOutcome
  expected: string
  observed: Record<string, unknown>
  deliverableId: string
  sceneId: string | null
  artifacts: string[]
  remediation: string | null
  checkedAt: string
}
export interface ReviewPin {
  ticketId: string
  productId: string
  deliverableId: string
  deliverableVersion: number
  sha256: string
  byteSize: number
  renderJobId: string
  manifestChecksum: string
  manifest: RenderManifest
  researchLocation: { runId: string; snapshotId: string }
  sourceSnapshotId: string
  mediaRightsNote: string
  mediaRights: string
  rightsAcknowledged: boolean
  ruleset: typeof VERA_RULESET
}
export interface VeraDocument {
  format: typeof VERA_FORMAT
  ruleset: typeof VERA_RULESET
  platformChecklist: typeof PLATFORM_CHECKLIST
  taskId: string
  runId: string
  pin: ReviewPin
  verdict: Verdict
  findings: VeraFinding[]
  revisionPolicy: { automaticContentRevisions: 0; executionMaxAttempts: number }
  completedAt: string
}
export interface VeraReview {
  id: string
  version: number
  checksum: string
  integrity: "verified" | "mismatch"
  current: boolean
  document: VeraDocument
}
export interface VeraOverview {
  availability: { available: boolean; reason: string | null }
  workerOnline: boolean
  deliverables: (PixelDeliverable & {
    current: boolean
    reviewProblem: string | null
    latestReview: { id: string; version: number; verdict: Verdict } | null
  })[]
  history: {
    id: string
    deliverableId: string
    deliverableVersion: number
    version: number
    verdict: Verdict
    createdAt: string
  }[]
  tasks: {
    id: string
    runId: string
    deliverableId: string
    status: string
    attempts: number
    maxAttempts: number
    message: string | null
  }[]
  offset: number
  limit: number
}
export const veraEndpoint = (ticketId: string) =>
  `/api/tickets/${encodeURIComponent(ticketId)}/reviews`
