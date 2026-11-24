import {
  DECISIONS,
  REVISION_CATEGORIES,
  hasChecklist,
  type DecisionInput,
  type DecisionKind,
} from "@/lib/approvals/policy"
import { isUuid } from "@/lib/tickets/validation"
import { invalid } from "@/server/tickets/http"

function bad(message: string): never {
  throw invalid([], message)
}

function object(value: unknown, allowed: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    return bad("Unexpected decision fields.")
  return value as Record<string, unknown>
}

function text(value: unknown, max: number, required = false) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    value.includes("\0") ||
    (required && !value.trim())
  )
    return bad(
      `Enter ${required ? "a value" : "text"} of at most ${max} characters.`,
    )
  return value
}

export function approvalId(value: unknown) {
  if (typeof value !== "string" || !isUuid(value))
    return bad("Invalid approval identifier.")
  return value.toLowerCase()
}

export function decisionInput(value: unknown): DecisionInput {
  const b = object(value, [
    "requestId",
    "expectedDecisionId",
    "reviewId",
    "kind",
    "notes",
    "reason",
    "checklist",
    "revision",
  ])
  const kind = b.kind as DecisionKind
  if (!DECISIONS.includes(kind)) return bad("Select a decision.")
  if (kind === "approved" ? !hasChecklist(b.checklist) : b.checklist !== null)
    return bad("Confirm every checklist item before approving.")
  let revision: DecisionInput["revision"] = null
  if (kind === "revision_requested") {
    const r = object(b.revision, ["categories", "sceneIds", "correction"])
    if (
      !Array.isArray(r.categories) ||
      !r.categories.length ||
      r.categories.length > REVISION_CATEGORIES.length ||
      new Set(r.categories).size !== r.categories.length ||
      r.categories.some((entry) => !REVISION_CATEGORIES.includes(entry))
    )
      return bad("Select at least one valid revision category.")
    if (
      !Array.isArray(r.sceneIds) ||
      r.sceneIds.length > 30 ||
      new Set(r.sceneIds).size !== r.sceneIds.length ||
      r.sceneIds.some(
        (id) => typeof id !== "string" || !/^[\w-]{1,80}$/.test(id),
      )
    )
      return bad("Provide up to 30 valid scene identifiers.")
    revision = {
      categories: r.categories,
      sceneIds: r.sceneIds,
      correction: text(r.correction, 2000, true),
    }
  } else if (b.revision !== null)
    return bad("Revision fields require a revision request.")
  return {
    requestId: approvalId(b.requestId),
    expectedDecisionId:
      b.expectedDecisionId === null ? null : approvalId(b.expectedDecisionId),
    reviewId: approvalId(b.reviewId),
    kind,
    notes: text(b.notes, 2000),
    reason: text(b.reason, 2000, kind !== "approved"),
    checklist: b.checklist as DecisionInput["checklist"],
    revision,
  }
}

export function bulkInput(value: unknown) {
  const { items } = object(value, ["items"])
  if (!Array.isArray(items) || items.length < 1 || items.length > 10)
    return bad("Select between one and ten videos.")
  const parsed = items.map((item: unknown) => {
    const { deliverableId, decision } = object(item, [
      "deliverableId",
      "decision",
    ])
    const input = decisionInput(decision)
    if (input.kind !== "approved")
      return bad("Bulk review supports approvals only.")
    return { deliverableId: approvalId(deliverableId), input }
  })
  if (
    new Set(parsed.map((item) => item.deliverableId)).size !== parsed.length ||
    new Set(parsed.map((item) => item.input.requestId)).size !== parsed.length
  )
    return bad("Each video and request identifier must be unique in a batch.")
  return parsed
}

export function queryFields(params: URLSearchParams, keys: string[]) {
  for (const key of params.keys())
    if (!keys.includes(key) || params.getAll(key).length !== 1)
      bad("Unexpected or repeated query parameter.")
}

export function approvalOffset(params: URLSearchParams) {
  const value = params.get("offset") ?? "0"
  if (!/^\d{1,5}$/.test(value) || Number(value) > 10000)
    return bad("Choose an offset from 0 to 10000.")
  return Number(value)
}
