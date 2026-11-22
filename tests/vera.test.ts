import { describe, expect, it } from "vitest"
import type { ResearchReport } from "@/lib/scout/types"
import { VERA_RULESET, type ReviewPin } from "@/lib/vera/types"
import { buildStoryboard } from "@/lib/video/storyboard"
import { DEFAULT_VIDEO_SETTINGS } from "@/lib/video/validation"
import type { VideoProject } from "@/lib/video/types"
import { composeScript } from "@/server/quill/compose"
import { selectFacts } from "@/server/quill/select"
import { aggregateVerdict, contentChecks, finding } from "@/server/vera/rules"
import { sampleTimes, timestampCheck } from "@/server/vera/video"

const pin = {
  deliverableId: "video",
  mediaRights: "owned",
  rightsAcknowledged: false,
  manifest: { script: { id: "script" }, report: { id: "report" }, assets: [] },
} as unknown as ReviewPin
const f = (
  outcome: Parameters<typeof finding>[3],
  severity: Parameters<typeof finding>[4],
) => finding(pin, "test", "provenance", outcome, severity, "expected", {})
function fixture() {
  const report = {
    id: "report",
    productId: "p",
    productName: "Kettle",
    reportVersion: 1,
    checksum: "a".repeat(64),
    brief: { sellingPoints: [] },
    claims: ["Capacity", "Power"].map((attribute, i) => ({
      key: `c${i + 1}`,
      statement: `${attribute}: ${i + 1} L`,
      kind: "attribute",
      attribute,
      value: `${i + 1} L`,
      status: "supported",
      topic: null,
      timeSensitive: false,
      evidence: [{ key: `e${i + 1}`, relationship: "supports" }],
    })),
    sources: [
      {
        key: "s1",
        outcome: "ok",
        identified: true,
        finalUrl: "https://example.test/kettle",
        retrievedAt: null,
      },
    ],
    evidence: {
      items: [1, 2].map((i) => ({
        key: `e${i}`,
        sourceKey: "s1",
        passage: `Capacity ${i} L`,
      })),
    },
  } as unknown as ResearchReport
  const { eligible, excluded } = selectFacts(report)
  const doc = composeScript({
    report,
    snapshot: {
      checksum: "b".repeat(64),
      data: {
        ticket: { platform: "tiktok" },
        product: {
          id: "p",
          name: "Kettle",
          assets: [{ kind: "image" }, { kind: "image" }, { kind: "image" }],
        },
      },
    },
    ticketId: "t",
    eligible,
    excluded,
    now: new Date(),
  })
  const project: VideoProject = {
    product: doc.pixel.product,
    assets: [],
    scenes: buildStoryboard(doc.pixel.product, []),
    settings: DEFAULT_VIDEO_SETTINGS,
  }
  return { report, doc, project }
}
describe("Vera rules/1", () => {
  it.each([
    ["passed", "info", "pass"],
    ["warning", "warning", "pass"],
    ["failed", "revision", "needs_revision"],
    ["manual_review_required", "owner", "needs_owner_input"],
    ["failed", "fatal", "failed"],
    ["not_evaluated", "info", "needs_owner_input"],
  ] as const)("aggregates %s/%s as %s", (outcome, severity, verdict) =>
    expect(aggregateVerdict([f(outcome, severity)])).toBe(verdict),
  )
  it("fails closed for empty/unclassified failures and prioritizes unusable lineage", () => {
    expect(aggregateVerdict([])).toBe("failed")
    expect(aggregateVerdict([f("failed", "warning")])).toBe("failed")
    expect(
      aggregateVerdict([f("failed", "fatal"), f("failed", "revision")]),
    ).toBe("failed")
  })
  it("records version, timestamp and affected artifact without arbitrary scores", () => {
    expect(f("passed", "info")).toMatchObject({
      ruleset: VERA_RULESET,
      deliverableId: "video",
      artifacts: ["video"],
      sceneId: null,
    })
    expect(Date.parse(f("passed", "info").checkedAt)).toBeGreaterThan(0)
  })
  it("reuses Quill eligibility and exact evidence mapping", () => {
    const { report, doc, project } = fixture()
    expect(
      contentChecks(pin, doc, report, project)
        .filter((f) => f.category === "claims")
        .every((f) => f.outcome === "passed"),
    ).toBe(true)
    report.claims[0].status = "conflicting"
    expect(
      contentChecks(pin, doc, report, project).find(
        (f) => f.ruleId === "claims.quill-eligibility",
      )?.outcome,
    ).toBe("failed")
  })
  it("rejects substituted passages, statements and sensitive claims", () => {
    const { report, doc, project } = fixture()
    doc.scenes[1].claims[0].statement = "Unrelated"
    expect(
      contentChecks(pin, doc, report, project).find(
        (f) => f.ruleId === "claims.exact-evidence",
      )?.outcome,
    ).toBe("failed")
    report.claims[0].topic = "health"
    expect(
      contentChecks(pin, doc, report, project).find(
        (f) => f.ruleId === "claims.quill-eligibility",
      )?.outcome,
    ).toBe("failed")
  })
  it("flags unsupported advertising text using Quill's validation", () => {
    const { report, doc, project } = fixture()
    doc.scenes[1].caption = "I tested this: guaranteed health results for $1"
    expect(
      contentChecks(pin, doc, report, project).find(
        (f) => f.ruleId === "claims.quill-eligibility",
      )?.outcome,
    ).toBe("failed")
  })
  it("detects project caption and duration mismatch with actionable revision", () => {
    const { report, doc, project } = fixture()
    project.scenes[1].caption.text = "wrong"
    const result = contentChecks(pin, doc, report, project).find(
      (f) => f.ruleId === "captions.project-fidelity",
    )!
    expect(result).toMatchObject({ outcome: "failed", severity: "revision" })
    expect(result.remediation).toMatch(/Pixel/)
  })
  it("treats acknowledged unspecified rights as owner input, never licensing proof", () => {
    const { report, doc, project } = fixture()
    const results = contentChecks(
      { ...pin, mediaRights: "unspecified", rightsAcknowledged: true },
      doc,
      report,
      project,
    )
    expect(
      results.find((f) => f.ruleId === "rights.declaration"),
    ).toMatchObject({
      outcome: "manual_review_required",
      observed: { acknowledgementIsLicenseProof: false },
    })
  })
  it("flags incomplete and explicitly contradictory rights declarations", () => {
    const { report, doc, project } = fixture()
    for (const p of [
      { ...pin, mediaRights: "licensed", mediaRightsNote: "" },
      { ...pin, mediaRights: "owned", mediaRightsNote: "no permission" },
    ])
      expect(
        contentChecks(p, doc, report, project).find(
          (f) => f.ruleId === "rights.declaration",
        )?.outcome,
      ).toBe("manual_review_required")
  })
  it("offers corrective actions only for flagged findings", () => {
    expect(
      finding(
        pin,
        "check",
        "claims",
        "passed",
        "info",
        "Expected",
        {},
        "Regenerate script",
      ).remediation,
    ).toBeNull()
    expect(
      finding(
        pin,
        "check",
        "claims",
        "failed",
        "revision",
        "Expected",
        {},
        "Regenerate script",
      ).remediation,
    ).toBe("Regenerate script")
  })
  it("compares required disclosure using Quill validation", () => {
    const { report, doc, project } = fixture()
    doc.disclosure.required = false as true
    expect(
      contentChecks(pin, doc, report, project).find(
        (f) => f.ruleId === "claims.quill-eligibility",
      )?.outcome,
    ).toBe("failed")
  })
  it("samples all scene edges inside fades and transitions", () => {
    const { project } = fixture()
    const samples = sampleTimes(project)
    expect(samples).toHaveLength(project.scenes.length)
    for (const s of samples)
      expect(s.times).toEqual([
        s.start + 0.5,
        (s.start + s.end) / 2,
        s.end - 0.5,
      ])
  })
  it("rejects missing, duplicate, reordered and discontinuous presentation timestamps", () => {
    const frames = Array.from({ length: 10 }, (_, i) => ({
      best_effort_timestamp_time: String(i / 30),
    }))
    expect(timestampCheck(JSON.stringify({ frames }), 10).ok).toBe(true)
    frames[3] = frames[2]
    expect(timestampCheck(JSON.stringify({ frames }), 10).ok).toBe(false)
    expect(timestampCheck("{}", 10).ok).toBe(false)
    expect(timestampCheck("broken", 10).ok).toBe(false)
  })
})
