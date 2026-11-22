import type { QuillScriptDocument } from "@/lib/quill/types"
import type { ResearchReport } from "@/lib/scout/types"
import {
  VERA_RULESET,
  type Category,
  type ReviewPin,
  type VeraFinding,
  type Verdict,
} from "@/lib/vera/types"
import type { VideoProject } from "@/lib/video/types"
import { assertFidelity } from "@/server/pixel/adapter"
import { selectFacts } from "@/server/quill/select"
import { validateScript } from "@/server/quill/validate"
import { canonicalJson } from "@/server/orchestrator/canonical"

export function aggregateVerdict(findings: readonly VeraFinding[]): Verdict {
  if (
    !findings.length ||
    findings.some((f) => f.outcome === "failed" && f.severity === "fatal")
  )
    return "failed"
  if (findings.some((f) => f.outcome === "failed" && f.severity === "revision"))
    return "needs_revision"
  if (
    findings.some(
      (f) =>
        f.outcome === "manual_review_required" ||
        f.outcome === "not_evaluated" ||
        (f.outcome === "failed" && f.severity === "owner"),
    )
  )
    return "needs_owner_input"
  if (findings.some((f) => f.outcome === "failed")) return "failed"
  return "pass"
}
export function finding(
  pin: ReviewPin,
  ruleId: string,
  category: Category,
  outcome: VeraFinding["outcome"],
  severity: VeraFinding["severity"],
  expected: string,
  observed: Record<string, unknown>,
  remediation: string | null = null,
  sceneId: string | null = null,
  artifacts: string[] = [],
): VeraFinding {
  return {
    ruleId,
    ruleset: VERA_RULESET,
    category,
    outcome,
    severity,
    expected,
    observed,
    remediation: outcome === "passed" ? null : remediation,
    sceneId,
    artifacts: [pin.deliverableId, ...artifacts],
    deliverableId: pin.deliverableId,
    checkedAt: new Date().toISOString(),
  }
}
export function contentChecks(
  pin: ReviewPin,
  doc: QuillScriptDocument,
  report: ResearchReport,
  project: VideoProject,
): VeraFinding[] {
  const errors = validateScript(doc, selectFacts(report).eligible).filter(
    (f) => f.level === "error",
  )
  const out = [
    finding(
      pin,
      "claims.quill-eligibility",
      "claims",
      errors.length ? "failed" : "passed",
      errors.length ? "fatal" : "info",
      "Quill's existing claim eligibility, source evidence and sensitive-topic rules pass.",
      { errors },
      "Correct owner facts, rerun Scout, then create a new Quill script and Pixel video.",
      null,
      [pin.manifest.script.id, pin.manifest.report.id],
    ),
  ]
  // Quill validates eligibility, but Vera also requires the exact trusted evidence/text mapping.
  const eligible = new Map(
    selectFacts(report).eligible.map((f) => [f.claim.key, f]),
  )
  const bad = doc.scenes
    .filter((s) =>
      s.claims.some((c) => {
        const f = eligible.get(c.claimKey)
        return (
          !f ||
          c.statement !== f.claim.statement ||
          c.evidence.length === 0 ||
          c.evidence.some(
            (e) =>
              !f.evidence.some((x) => canonicalJson(x) === canonicalJson(e)),
          )
        )
      }),
    )
    .map((s) => s.id)
  out.push(
    finding(
      pin,
      "claims.exact-evidence",
      "claims",
      bad.length ? "failed" : "passed",
      bad.length ? "fatal" : "info",
      "Scene claims use exact eligible statements and persisted evidence references.",
      { invalidScenes: bad },
      "Run Scout and Quill again with corrected evidence.",
    ),
  )
  let mismatch: string | null = null
  try {
    assertFidelity(doc, project)
  } catch {
    mismatch =
      "Scene order, captions, subtext, disclosure, duration or silent expectation differs from Quill."
  }
  out.push(
    finding(
      pin,
      "captions.project-fidelity",
      "captions",
      mismatch ? "failed" : "passed",
      mismatch ? "revision" : "info",
      "Project text and scene durations equal the pinned Quill script.",
      { mismatch },
      "Create a corrected Pixel version from the pinned Quill script.",
    ),
  )
  const note = pin.mediaRightsNote ?? ""
  const incomplete =
    pin.mediaRights !== "owned" &&
    pin.mediaRights !== "unspecified" &&
    !note.trim()
  const contradictory =
    /\b(no (permission|license|licence|rights)|not (owned|licensed|permitted)|permission denied|rights (denied|unknown))\b/i.test(
      note,
    )
  const declared =
    ["owned", "licensed", "permission", "affiliate_program"].includes(
      pin.mediaRights,
    ) &&
    !incomplete &&
    !contradictory

  out.push(
    finding(
      pin,
      "rights.declaration",
      "media_rights",
      declared ? "passed" : "manual_review_required",
      declared ? "info" : "owner",
      "A complete frozen media-rights declaration exists.",
      {
        declaration: pin.mediaRights,
        note,
        incomplete,
        contradictory,
        acknowledged: pin.rightsAcknowledged,
        acknowledgementIsLicenseProof: false,
      },
      declared
        ? null
        : "Obtain or confirm rights for every pinned image; update the product and create a new source/video version.",
    ),
  )
  out.push(
    finding(
      pin,
      "rights.legal-boundary",
      "media_rights",
      "warning",
      "warning",
      "Owner declarations are recorded, never treated as independent license proof.",
      {
        legalPermission: "not evaluated",
        imageIds: pin.manifest.assets.map((a) => a.id),
      },
      "Human approval must inspect ownership/licensing documentation.",
    ),
  )
  out.push(
    finding(
      pin,
      "visual.semantic-boundary",
      "visual_composition",
      "warning",
      "warning",
      "Only known caption text is machine evaluated.",
      {
        notEvaluated: [
          "Claims embedded in photographs",
          "Image relevance or misleading presentation",
          "Product name semantics",
          "Human-level readability or image quality",
        ],
      },
      "Inspect all imagery and visible text before human approval.",
    ),
  )
  return out
}
