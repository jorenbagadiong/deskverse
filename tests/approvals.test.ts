import { describe, expect, it } from "vitest"
import {
  CHECKLIST,
  decisionTransition,
  hasChecklist,
  hasRightsBasis,
  safeExternalUrl,
} from "@/lib/approvals/policy"
import { bulkInput, decisionInput } from "@/server/approvals/input"

const checklist = Object.fromEntries(
  Object.keys(CHECKLIST).map((key) => [key, true]),
)
const requestId = "8142b9db-8fe3-4da4-b153-0fc50a944ef0"
const reviewId = "cff10b20-bdfb-4cbd-bfd6-30dcacc9d361"
const deliverableId = "6e378c9e-0fa1-40f5-83cf-6aaa1c8e6676"
const approval = {
  requestId,
  reviewId,
  kind: "approved",
  checklist,
  notes: "",
  reason: "",
  revision: null,
  expectedDecisionId: null,
}

describe("human decision policy", () => {
  it("requires every explicit checklist item and rejects additional ones", () => {
    expect(hasChecklist(checklist)).toBe(true)
    expect(hasChecklist({ ...checklist, watched: false })).toBe(false)
    expect(hasChecklist({ ...checklist, watched: "true" })).toBe(false)
    expect(hasChecklist({ ...checklist, bypass: true })).toBe(false)
    expect(() => decisionInput({ ...approval, extra: true })).toThrow()
  })

  it("supports pending, withdrawal, reassessment and explicit reconsideration", () => {
    expect(decisionTransition(null, "approved", false)).toBe(true)
    expect(decisionTransition(null, "revision_requested", false)).toBe(true)
    expect(decisionTransition(null, "rejected", false)).toBe(true)
    expect(decisionTransition(null, "withdrawn", false)).toBe(false)
    expect(decisionTransition("approved", "withdrawn", true)).toBe(true)
    expect(decisionTransition("approved", "rejected", true)).toBe(false)
    expect(decisionTransition("approved", "approved", false)).toBe(true)
    expect(decisionTransition("rejected", "approved", true)).toBe(true)
    expect(decisionTransition("revision_requested", "approved", false)).toBe(
      false,
    )
  })

  it("requires rights support and accepts only safe, explicit affiliate links", () => {
    expect(hasRightsBasis("owned", "")).toBe(true)
    expect(
      hasRightsBasis("unspecified", "Written usage rights confirmed"),
    ).toBe(false)
    expect(hasRightsBasis("permission", "yes")).toBe(false)
    expect(
      hasRightsBasis("licensed", "License covers commercial promotional use."),
    ).toBe(true)
    expect(safeExternalUrl("javascript:alert(1)")).toBeUndefined()
    expect(safeExternalUrl("https://user:pass@example.com/")).toBeUndefined()
    expect(safeExternalUrl("https://example.com/?product=123")).toBe(
      "https://example.com/?product=123",
    )
  })

  it("requires a reason, correction and allowed categories for revision", () => {
    const revision = {
      ...approval,
      kind: "revision_requested",
      checklist: null,
      reason: "Unreadable",
      revision: {
        correction: "Increase caption contrast.",
        categories: ["Caption"],
        sceneIds: ["scene-1"],
      },
    }
    expect(decisionInput(revision).revision).toEqual(revision.revision)
    expect(() => decisionInput({ ...revision, reason: "" })).toThrow()
    expect(() =>
      decisionInput({
        ...revision,
        revision: { ...revision.revision, categories: [] },
      }),
    ).toThrow()
    expect(() =>
      decisionInput({
        ...revision,
        revision: { ...revision.revision, correction: "" },
      }),
    ).toThrow()
    expect(() =>
      decisionInput({ ...approval, kind: "rejected", checklist: null }),
    ).toThrow()
    expect(() =>
      decisionInput({ ...approval, kind: "withdrawn", checklist: null }),
    ).toThrow()
  })

  it("bounds and validates each batch item independently before execution", () => {
    const item = { deliverableId, decision: approval }
    expect(bulkInput({ items: [item] })[0].input.kind).toBe("approved")
    expect(() => bulkInput({ items: [item, item] })).toThrow()
    expect(() => bulkInput({ items: Array(11).fill(item) })).toThrow()
    expect(() =>
      bulkInput({
        items: [{ ...item, decision: { ...approval, checklist: null } }],
      }),
    ).toThrow()
  })
})
