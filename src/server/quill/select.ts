import type { ExcludedClaim, SceneEvidence } from "@/lib/quill/types"
import type { ResearchClaim, ResearchReport } from "@/lib/scout/types"
import {
  TEXT_LIMITS,
  codePointLength,
  normalizeText,
} from "@/lib/video/validation"
import { attributeKey } from "@/server/scout/analysis/attributes"
import { SUSPICIOUS } from "@/server/scout/extract/html"

/**
 * Which Scout claims Quill may turn into promotional copy (DV-005B).
 *
 * Eligible only when ALL hold:
 * - status "supported" (Scout's exact classification);
 * - not an identifier (brand/model/GTIN/SKU are not benefits);
 * - no sensitive topic (price, discount, commission, rating, performance
 *   comparisons, health, certification, warranty, delivery, stock,
 *   superiority) and not time-sensitive;
 * - no conflicting claim about the same attribute in the report;
 * - at least one "supports" link to evidence that exists in the report,
 *   from a source that was read and matched, whose passage isn't text
 *   addressed to AI systems;
 * - plain text (no links, HTML, control/invisible characters, negative
 *   yes/no values) that fits a caption without being cut.
 * Everything else is listed as excluded, with the reason.
 */

export const MIN_ELIGIBLE_FACTS = 2
export const MAX_BENEFITS = 5

export interface EligibleFact {
  claim: ResearchClaim
  evidence: SceneEvidence[]
  /** Caption text (Pixel benefit, ≤ 80 characters), built from the claim only. */
  caption: string
  /** Template narration sentence, built from the claim only. */
  narration: string
  /** Lower-case attribute label, or null for a statement claim. */
  attribute: string | null
}

export const UNSAFE_TEXT =
  /<\/?[a-z!][^>]*>|\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|net|org|io|co|shop|store|ly|app|info)\b|javascript:/i
const INVISIBLE = /[\p{Cc}\p{Co}\p{Cs}\u2028\u2029]|(?![\u200C\u200D])\p{Cf}/u

export function unsafeText(text: string) {
  return UNSAFE_TEXT.test(text) || INVISIBLE.test(text) || SUSPICIOUS.test(text)
}

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`)

export function selectFacts(report: ResearchReport): {
  eligible: EligibleFact[]
  excluded: ExcludedClaim[]
  conflicts: string[]
} {
  const evidence = new Map(report.evidence.items.map((e) => [e.key, e]))
  const sources = new Map(report.sources.map((s) => [s.key, s]))
  const conflicted = new Set(
    report.claims
      .filter((c) => c.status === "conflicting" && c.attribute)
      .map((c) => attributeKey(c.attribute!).key),
  )
  const conflicts = report.claims
    .filter((c) => c.status === "conflicting")
    .map((c) => c.attribute ?? c.statement)
  const excluded: ExcludedClaim[] = []
  const candidates: EligibleFact[] = []
  const exclude = (c: ResearchClaim, reason: string) =>
    excluded.push({ claimKey: c.key, statement: c.statement, reason })

  for (const c of report.claims) {
    if (c.status !== "supported") {
      exclude(
        c,
        c.status === "conflicting"
          ? "Sources disagree about it."
          : c.status === "unverified"
            ? "No source supports it."
            : "There was no usable source to check it.",
      )
      continue
    }
    if (c.kind === "identity") {
      exclude(c, "An identifier, not a benefit.")
      continue
    }
    if (c.topic) {
      exclude(
        c,
        `Sensitive (${c.topic}): needs a separate verification and approval step.`,
      )
      continue
    }
    if (c.timeSensitive) {
      exclude(c, "Time-sensitive (it may have changed since it was retrieved).")
      continue
    }
    if (c.attribute && conflicted.has(attributeKey(c.attribute).key)) {
      exclude(c, "Another claim about the same attribute conflicts.")
      continue
    }
    const supporting: SceneEvidence[] = []
    for (const link of c.evidence) {
      if (link.relationship !== "supports") continue
      const e = evidence.get(link.key)
      const s = e ? sources.get(e.sourceKey) : undefined
      if (
        !e ||
        !s ||
        s.outcome !== "ok" ||
        !s.identified ||
        SUSPICIOUS.test(e.passage)
      )
        continue
      supporting.push({
        key: e.key,
        sourceKey: s.key,
        sourceUrl: s.finalUrl ?? s.requestedUrl,
        retrievedAt: s.retrievedAt,
      })
    }
    if (supporting.length === 0) {
      exclude(c, "No valid supporting evidence in the report.")
      continue
    }
    const value = c.value ? normalizeText(c.value) : null
    const attribute = c.attribute ? normalizeText(c.attribute) : null
    if (
      unsafeText(c.statement) ||
      (value && unsafeText(value)) ||
      (attribute && unsafeText(attribute))
    ) {
      exclude(
        c,
        "Contains links, markup or unusual characters, so it isn't used as copy.",
      )
      continue
    }
    if (c.kind === "attribute" && (!value || !attribute)) {
      exclude(c, "Has no clear value.")
      continue
    }
    if (value && /^(no|none|n\/a|-)$/i.test(value)) {
      exclude(c, "A negative or empty value isn't a benefit.")
      continue
    }
    // "Auto shut-off: Yes" reads as just the feature: "Auto shut-off".
    const caption =
      c.kind === "attribute"
        ? /^yes$/i.test(value!)
          ? attribute!
          : `${attribute}: ${value}`
        : normalizeText(c.statement).replace(/\.$/, "")
    if (codePointLength(caption) > TEXT_LIMITS.benefit) {
      exclude(
        c,
        `Longer than a ${TEXT_LIMITS.benefit}-character caption; Quill doesn't shorten facts.`,
      )
      continue
    }
    const narration =
      c.kind === "attribute"
        ? /^yes$/i.test(value!)
          ? `It has ${attribute!.toLowerCase()}.`
          : `The ${attribute!.toLowerCase()} is ${value}.`
        : sentence(normalizeText(c.statement))
    candidates.push({
      claim: c,
      evidence: supporting,
      caption,
      narration,
      attribute: attribute?.toLowerCase() ?? null,
    })
  }

  // Scout's selling points first (their claim keys re-checked above), then
  // the rest in report order; one benefit per distinct caption.
  const order = report.brief.sellingPoints.flatMap((p) => p.claims)
  const rank = (f: EligibleFact) => {
    const i = order.indexOf(f.claim.key)
    return i === -1 ? order.length + Number(f.claim.key.slice(1)) : i
  }
  const seen = new Set<string>()
  const eligible = candidates
    .sort((a, b) => rank(a) - rank(b))
    .filter((f) => {
      const k = f.caption.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  return { eligible, excluded, conflicts }
}
