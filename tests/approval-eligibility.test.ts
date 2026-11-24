import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  APPROVAL_POLICY,
  CHECKLIST,
  DECISION_FORMAT,
} from "@/lib/approvals/policy"
import { AWAITING_QA } from "@/lib/pixel/types"
import {
  VERA_FORMAT,
  VERA_RULESET,
  type VeraFinding,
  type VeraReview,
} from "@/lib/vera/types"
import { approvalEligibility } from "@/server/approvals/store"
import { currentProductSnapshots } from "@/server/orchestrator/store"
import { ticketRenderStorage } from "@/server/pixel/store"
import { LineageError, loadInputs } from "@/server/vera/inputs"
import { getReview } from "@/server/vera/store"
import { fileDigest } from "@/server/vera/video"

vi.mock("@/server/orchestrator/store", () => ({
  currentProductSnapshots: vi.fn(),
}))
vi.mock("@/server/pixel/store", () => ({ ticketRenderStorage: vi.fn() }))
vi.mock("@/server/vera/inputs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/vera/inputs")>()),
  loadInputs: vi.fn(),
}))
vi.mock("@/server/vera/store", () => ({ getReview: vi.fn() }))
vi.mock("@/server/vera/video", () => ({ fileDigest: vi.fn() }))

const artifact = "video-id"
const checksum = "exact-video-sha256"
const pin = {
  deliverableId: artifact,
  deliverableVersion: 1,
  sha256: checksum,
  rightsAcknowledged: true,
  mediaRights: "owned",
  mediaRightsNote: "",
}
const review = {
  id: "review-1",
  version: 1,
  checksum: "exact-review-checksum",
  integrity: "verified",
  document: {
    pin,
    format: VERA_FORMAT,
    ruleset: VERA_RULESET,
    verdict: "pass",
    findings: [{ outcome: "passed", severity: "info" }],
  },
} as VeraReview
const decision = {
  id: "decision-1",
  kind: "approved",
  contract: DECISION_FORMAT,
  policy: APPROVAL_POLICY,
  deliverable_sha256: checksum,
  review_id: review.id,
  review_version: 1,
  review_checksum: review.checksum,
  checklist: Object.fromEntries(
    Object.keys(CHECKLIST).map((item) => [item, true]),
  ),
}

const candidate = {
  id: artifact,
  ticket_id: "ticket-id",
  product_id: "product-id",
  sha256: checksum,
  deliverable_version: 1,
  status: AWAITING_QA,
  newest: true,
  ticket_status: "ready",
  byte_size: 999,
  review_id: review.id,
  snapshot_checksum: "snapshot",
  snapshot: { product: { affiliateUrl: "https://example.invalid/item" } },
}
function db(row = candidate, prior: Record<string, unknown> | null = decision) {
  return {
    async query(sql: string) {
      const rows = sql.includes("FROM pixel_deliverables d")
        ? [row]
        : prior
          ? [prior]
          : []
      return {
        rows,
        rowCount: rows.length,
        fields: [],
        command: "SELECT",
        oid: 0,
      }
    },
  }
}
const file = { path: "fixture.mp4", sizeBytes: 999 }

beforeEach(() => {
  vi.mocked(currentProductSnapshots).mockResolvedValue({
    snapshots: [
      { product: { id: candidate.product_id }, checksum: "snapshot" },
    ],
  } as Awaited<ReturnType<typeof currentProductSnapshots>>)
  // The fixtures provide only the fields read by the eligibility service.
  vi.mocked(loadInputs).mockResolvedValue({
    pin,
    script: { document: {} },
    report: { sources: [] },
  } as unknown as Awaited<ReturnType<typeof loadInputs>>)
  vi.mocked(getReview).mockResolvedValue(review)
  vi.mocked(ticketRenderStorage).mockReturnValue({
    resolveCompletedOutput: vi.fn().mockResolvedValue(file),
  } as unknown as ReturnType<typeof ticketRenderStorage>)
  vi.mocked(fileDigest).mockResolvedValue(checksum)
})

describe("current approval eligibility", () => {
  it("requires a persisted explicit approval for the exact verified pins", async () => {
    const pending = await approvalEligibility(db(candidate, null), artifact, "")
    expect(pending.eligibility).toMatchObject({
      eligible: false,
      canApprove: true,
    })
    const current = await approvalEligibility(db(), artifact, "")
    expect(current.eligibility).toMatchObject({
      eligible: true,
      canApprove: false,
      approvedDeliverableId: artifact,
      approvedReviewId: review.id,
    })
    const withdrawn = await approvalEligibility(
      db(candidate, { ...decision, kind: "withdrawn" }),
      artifact,
      "",
    )
    expect(withdrawn.eligibility.eligible).toBe(false)
  })

  it.each(["needs_revision", "needs_owner_input", "failed"] as const)(
    "blocks Vera verdict %s",
    async (verdict) => {
      vi.mocked(getReview).mockResolvedValue({
        ...review,
        document: { ...review.document, verdict },
      })
      const { eligibility } = await approvalEligibility(db(), artifact, "")
      expect(eligibility).toMatchObject({
        eligible: false,
        canApprove: false,
        reasons: ["qa_blocked"],
      })
    },
  )

  it("blocks verified documents with blocking findings or a different Pixel pin", async () => {
    vi.mocked(getReview)
      .mockResolvedValueOnce({
        ...review,
        document: {
          ...review.document,
          findings: [{ severity: "fatal", outcome: "failed" } as VeraFinding],
        },
      })
      .mockResolvedValueOnce({
        ...review,
        document: {
          ...review.document,
          pin: { ...review.document.pin, deliverableId: "another-video" },
        },
      })
    expect(
      (await approvalEligibility(db(), artifact, "")).eligibility.reasons,
    ).toEqual(["qa_blocked"])
    expect(
      (await approvalEligibility(db(), artifact, "")).eligibility.reasons,
    ).toEqual(["review_integrity"])
  })

  it("keeps history and requires a deliberate new decision for a newer passing review", async () => {
    const latest = {
      ...review,
      id: "review-2",
      version: 2,
      checksum: "new-review-checksum",
    }
    vi.mocked(getReview).mockResolvedValue(latest)
    const result = await approvalEligibility(
      db({ ...candidate, review_id: latest.id }),
      artifact,
      "",
    )
    expect(result.decision?.id).toBe(decision.id)
    expect(result.eligibility).toMatchObject({
      eligible: false,
      canApprove: true,
      approvedReviewId: null,
    })
  })

  it("marks superseded videos, archived tickets and changed inputs historical", async () => {
    for (const [row, reason] of [
      [{ ...candidate, newest: false }, "superseded"],
      [{ ...candidate, ticket_status: "archived" }, "archived"],
      [{ ...candidate, snapshot_checksum: "old" }, "inputs_changed"],
    ] as const) {
      const { eligibility } = await approvalEligibility(db(row), artifact, "")
      expect(eligibility).toMatchObject({
        eligible: false,
        canApprove: false,
        historical: true,
        reasons: [reason],
      })
    }
  })

  it("blocks missing or altered MP4 bytes and broken source lineage", async () => {
    vi.mocked(fileDigest).mockResolvedValueOnce("tampered")
    expect(
      (await approvalEligibility(db(), artifact, "")).eligibility.reasons,
    ).toEqual(["media_integrity"])
    vi.mocked(ticketRenderStorage).mockReturnValueOnce({
      resolveCompletedOutput: vi.fn().mockResolvedValue(null),
    } as unknown as ReturnType<typeof ticketRenderStorage>)
    expect(
      (await approvalEligibility(db(), artifact, "")).eligibility.reasons,
    ).toEqual(["media_integrity"])
    vi.mocked(loadInputs).mockRejectedValueOnce(
      new LineageError("fixture mismatch"),
    )
    expect(
      (await approvalEligibility(db(), artifact, "")).eligibility,
    ).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["lineage"]),
    })
  })
})
