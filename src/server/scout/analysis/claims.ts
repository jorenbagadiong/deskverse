import type {
  ClaimStatus,
  EvidenceMethod,
  EvidenceRelationship,
  ReferenceKind,
  ResearchBrief,
  ResearchClaim,
  ResearchEvidence,
  ResearchSource,
  SensitiveTopic,
  SourceTrust,
} from "@/lib/scout/types"
import {
  attributeKey,
  attributeWords,
  claimTopic,
  isIdentity,
  isTimeSensitive,
  tokens,
} from "@/server/scout/analysis/attributes"
import {
  differentQuantity,
  parseQuantities,
  sameQuantity,
} from "@/server/scout/analysis/quantity"
import type { PageContent } from "@/server/scout/extract/html"

/**
 * Evidence-backed claim assessment (DV-005A). Deterministic: the same
 * sources and owner input always give the same claims.
 *
 * Rules:
 * - Only sources that were read AND matched to the product count as
 *   evidence. Anything Scout couldn't read produces no facts.
 * - An owner claim is "supported" only when a stored passage states the
 *   same value (unit-aware for measurements, word-level for text);
 *   "conflicting" when a source states an incompatible measurement (or a
 *   different brand/model); otherwise "unverified". Without any usable
 *   source it is "insufficient_evidence".
 * - Source facts the owner didn't mention are reported as source facts,
 *   and sources that disagree with each other are reported as conflicts.
 * - Prices, availability and ratings are time-sensitive: reported with
 *   their retrieval date, never as selling points. Claims touching
 *   sensitive topics (health, certification, warranty, superiority…) are
 *   flagged and never suggested as selling points.
 * - Passages containing text addressed to AI systems are never evidence.
 * Every claim lists the evidence keys behind it; no numeric confidence.
 */

export interface AnalysedSource extends Omit<ResearchSource, "key"> {
  key: string
  content: PageContent | null
  /** Product name found on the page, when identified. */
  productName: string | null
  /** Validated model-extracted facts (passage index into content.passages). */
  modelFacts: { label: string; value: string; passage: number; model: string }[]
}

export interface OwnerProduct {
  name: string
  description: string
  specifications: string
}

interface Candidate {
  sourceKey: string
  key: string
  label: string
  value: string
  method: EvidenceMethod
  location: string
  passage: string
  model: string | null
  timeSensitive: boolean
}

interface TextPassage {
  sourceKey: string
  method: EvidenceMethod
  location: string
  text: string
}

export interface Analysis {
  brief: ResearchBrief
  claims: ResearchClaim[]
  evidence: ResearchEvidence[]
}

const MAX_EVIDENCE = 150
const MAX_CLAIMS = 150
const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s

const LABEL_VALUE =
  /^([A-Za-z][A-Za-z0-9 ()/&.'’-]{1,40}?)\s*[:：]\s+(.{1,200})$/

/** Owner-supplied claims from the frozen snapshot (specifications, description). */
export function ownerClaims(product: OwnerProduct) {
  const out: {
    kind: "attribute" | "statement"
    key: string | null
    label: string | null
    value: string | null
    statement: string
  }[] = []
  for (const raw of product.specifications.split(/\r?\n|;|•|·|\|/)) {
    const line = raw.replace(/^[-*–]\s*/, "").trim()
    if (line.length < 2) continue
    const kv = LABEL_VALUE.exec(line)
    if (kv) {
      const { key, label } = attributeKey(kv[1])
      out.push({
        kind: "attribute",
        key,
        label,
        value: kv[2].trim(),
        statement: clip(line, 500),
      })
    } else
      out.push({
        kind: "statement",
        key: null,
        label: null,
        value: null,
        statement: clip(line, 500),
      })
  }
  for (const raw of product.description.split(/(?<=[.!?])\s+|\r?\n+|•/)) {
    const sentence = raw.replace(/^[-*–]\s*/, "").trim()
    if (sentence.split(/\s+/).length < 3) continue
    out.push({
      kind: "statement",
      key: null,
      label: null,
      value: null,
      statement: clip(sentence, 500),
    })
  }
  return out.slice(0, 60)
}

/** How a source value relates to a claimed value for the same attribute. */
export function compareValues(
  key: string,
  claimed: string,
  stated: string,
): EvidenceRelationship {
  const a = parseQuantities(claimed)
  const b = parseQuantities(stated)
  if (a.length > 0 && b.length > 0) {
    if (a.some((x) => b.some((y) => sameQuantity(x, y)))) return "supports"
    if (a.some((x) => b.some((y) => differentQuantity(x, y))))
      return "contradicts"
    return "context"
  }
  const ta = tokens(claimed)
  const tb = tokens(stated)
  if (ta.length === 0 || tb.length === 0) return "context"
  const inB = ta.filter((t) => tb.includes(t)).length
  const inA = tb.filter((t) => ta.includes(t)).length
  if (inB === ta.length || inA === tb.length) return "supports"
  if (key === "brand" || key === "model") return "contradicts"
  return "context"
}

/** Whether a page is about the owner's product (by name tokens and model numbers). */
export function identify(ownerName: string, content: PageContent) {
  const owner = [...new Set(tokens(ownerName))]
  const names = [
    ...content.jsonLd.products.map((p) => p.name),
    content.meta.ogTitle,
    content.h1,
    content.title,
  ].filter((n): n is string => Boolean(n))
  if (owner.length === 0 || names.length === 0)
    return { identified: false, productName: names[0] ?? null }
  const modelish = owner.filter(
    (t) => /\d/.test(t) && /[a-z]/.test(t) && t.length >= 3,
  )
  let best = { score: 0, name: names[0], model: false }
  for (const name of names) {
    const t = new Set(tokens(name))
    const score = owner.filter((x) => t.has(x)).length / owner.length
    const model = modelish.some((m) => t.has(m))
    if (score > best.score || (score === best.score && model && !best.model))
      best = { score, name, model }
  }
  return {
    identified: best.score >= 0.6 || (best.model && best.score >= 0.34),
    productName: clip(best.name, 300),
  }
}

const trustOrder: Record<string, number> = {
  manufacturer: 0,
  seller_listing: 1,
  independent_review: 2,
  unknown: 3,
}

export function analyse(
  owner: OwnerProduct,
  sources: AnalysedSource[],
  extraction: ResearchBrief["extraction"],
  now = new Date(),
): Analysis {
  const usable = sources.filter(
    (s) => s.outcome === "ok" && s.identified && s.content,
  )
  const byKey = new Map(sources.map((s) => [s.key, s]))

  // 1. Candidate facts and searchable passages from usable sources only.
  const candidates: Candidate[] = []
  const passages: TextPassage[] = []
  for (const s of usable) {
    const c = s.content!
    const product =
      c.jsonLd.products.find(
        (p) => p.name && s.productName && p.name === s.productName,
      ) ?? c.jsonLd.products[0]
    for (const f of product?.facts ?? []) {
      if (f.label === "Name") continue
      if (f.label === "Description") {
        passages.push({
          sourceKey: s.key,
          method: "json-ld",
          location: f.location,
          text: f.value,
        })
        continue
      }
      const { key, label } = attributeKey(f.label)
      candidates.push({
        sourceKey: s.key,
        key,
        label,
        value: f.value,
        method: "json-ld",
        location: f.location,
        passage: f.passage,
        model: null,
        timeSensitive: f.timeSensitive || isTimeSensitive(key),
      })
    }
    for (const f of c.facts) {
      const p = c.passages[f.passage]
      if (!p || p.suspicious) continue
      const { key, label } = attributeKey(f.label)
      candidates.push({
        sourceKey: s.key,
        key,
        label,
        value: clip(f.value, 200),
        method: f.method,
        location: p.location,
        passage: p.text,
        model: null,
        timeSensitive: isTimeSensitive(key),
      })
    }
    for (const f of s.modelFacts) {
      const p = c.passages[f.passage]
      if (!p || p.suspicious) continue
      const { key, label } = attributeKey(f.label)
      if (
        candidates.some(
          (x) => x.sourceKey === s.key && x.key === key && x.passage === p.text,
        )
      )
        continue
      candidates.push({
        sourceKey: s.key,
        key,
        label,
        value: clip(f.value, 200),
        method: "ollama",
        location: p.location,
        passage: p.text,
        model: f.model,
        timeSensitive: isTimeSensitive(key),
      })
    }
    if (c.meta.description)
      passages.push({
        sourceKey: s.key,
        method: "html-meta",
        location: "Meta description",
        text: c.meta.description,
      })
    for (const p of c.passages)
      if (!p.suspicious)
        passages.push({
          sourceKey: s.key,
          method:
            p.kind === "line"
              ? "text-plain"
              : p.kind === "row" || p.kind === "term"
                ? "html-table"
                : p.kind === "list"
                  ? "html-list"
                  : "html-text",
          location: p.location,
          text: p.text,
        })
  }

  // 2. Evidence registry: only what a claim actually cites is kept.
  const evidence: ResearchEvidence[] = []
  const evidenceIndex = new Map<string, string>()
  const cite = (e: Omit<ResearchEvidence, "key">): string | null => {
    const id = `${e.sourceKey}\u0000${e.method}\u0000${e.passage}\u0000${e.attribute ?? ""}`
    const known = evidenceIndex.get(id)
    if (known) return known
    if (evidence.length >= MAX_EVIDENCE) return null
    const key = `E${evidence.length + 1}`
    evidence.push({ ...e, key })
    evidenceIndex.set(id, key)
    return key
  }
  const citeCandidate = (c: Candidate) =>
    cite({
      sourceKey: c.sourceKey,
      method: c.method,
      location: clip(c.location, 200),
      passage: clip(c.passage, 600),
      statement: clip(`${c.label}: ${c.value}`, 300),
      attribute: c.label,
      value: c.value,
      model: c.model,
    })
  const citePassage = (p: TextPassage, statement: string) =>
    cite({
      sourceKey: p.sourceKey,
      method: p.method,
      location: clip(p.location, 200),
      passage: clip(p.text, 600),
      statement: clip(statement, 300),
      attribute: null,
      value: null,
      model: null,
    })

  const claims: ResearchClaim[] = []
  const add = (c: Omit<ResearchClaim, "key">) => {
    if (claims.length >= MAX_CLAIMS) return
    claims.push({ ...c, key: `C${claims.length + 1}` })
  }
  const describe = (keys: string[]) =>
    [...new Set(keys)]
      .map((k) => {
        const s = byKey.get(k)
        return s ? `${k} (${hostOf(s.finalUrl ?? s.requestedUrl)})` : k
      })
      .join(", ")

  const noSources = usable.length === 0
  const ownerKeys = new Set<string>()

  // 3. Owner claims.
  for (const oc of ownerClaims(owner)) {
    const topic = claimTopic(oc.statement, oc.key ?? undefined)
    if (noSources) {
      add({
        origin: "owner",
        kind: oc.kind,
        attribute: oc.label,
        value: oc.value,
        statement: oc.statement,
        status: "insufficient_evidence",
        reason:
          "No usable source could be read and matched to this product, so this couldn't be checked.",
        topic,
        timeSensitive: oc.key ? isTimeSensitive(oc.key) : false,
        evidence: [],
      })
      continue
    }
    if (oc.kind === "attribute" && oc.key && oc.value) {
      ownerKeys.add(oc.key)
      const links: ResearchClaim["evidence"] = []
      const supportSources: string[] = []
      const contradictions: string[] = []
      for (const c of candidates.filter((x) => x.key === oc.key)) {
        const rel = compareValues(oc.key, oc.value, c.value)
        const key = citeCandidate(c)
        if (!key) continue
        links.push({ key, relationship: rel })
        if (rel === "supports") supportSources.push(c.sourceKey)
        if (rel === "contradicts")
          contradictions.push(`${c.sourceKey} states ${c.value}`)
      }
      if (supportSources.length === 0 && contradictions.length === 0) {
        // Text fallback: a passage that names the attribute and states the same value.
        const words = attributeWords(oc.key, oc.label ?? "")
        const quantities = parseQuantities(oc.value)
        for (const p of passages) {
          if (links.length >= 3) break
          const lower = p.text.toLowerCase()
          if (!words.some((w) => w && lower.includes(w))) continue
          const pq = parseQuantities(p.text)
          const matches =
            quantities.length > 0
              ? quantities.some((q) => pq.some((x) => sameQuantity(q, x)))
              : tokens(oc.value).length > 0 &&
                tokens(oc.value).every((t) => tokens(p.text).includes(t))
          if (!matches) continue
          // Ambiguous: the passage also states other, different amounts of
          // the same kind (e.g. a comparison row listing several models).
          // It's cited as context only, never as support.
          const ambiguous =
            quantities.length > 0 &&
            pq.some((x) => quantities.some((q) => differentQuantity(q, x)))
          const key = citePassage(p, `${oc.label}: ${oc.value}`)
          if (!key) continue
          links.push({ key, relationship: ambiguous ? "context" : "supports" })
          if (!ambiguous) supportSources.push(p.sourceKey)
        }
      }
      const status: ClaimStatus =
        contradictions.length > 0
          ? "conflicting"
          : supportSources.length > 0
            ? "supported"
            : "unverified"
      add({
        origin: "owner",
        kind: "attribute",
        attribute: oc.label,
        value: oc.value,
        statement: oc.statement,
        status,
        reason:
          status === "conflicting"
            ? clip(
                `You said ${oc.value}; ${contradictions.join("; ")}.${supportSources.length ? ` Supported by ${describe(supportSources)}.` : ""}`,
                300,
              )
            : status === "supported"
              ? clip(`Stated by ${describe(supportSources)}.`, 300)
              : links.some((l) => l.relationship === "context")
                ? "A source mentions this value only alongside other, different values (context, not support); no source states it unambiguously."
                : "No retrieved source states this value.",
        topic,
        timeSensitive: isTimeSensitive(oc.key),
        evidence: links.slice(0, 8),
      })
      continue
    }
    // Statement claims: a single passage must state every measurement and most of the words.
    const qs = parseQuantities(oc.statement)
    const words = [...new Set(tokens(oc.statement))]
    const checkable = qs.length > 0 || words.length >= 3
    let best: { p: TextPassage; coverage: number } | null = null
    if (checkable)
      for (const p of passages) {
        const pq = parseQuantities(p.text)
        if (!qs.every((q) => pq.some((x) => sameQuantity(q, x)))) continue
        const pt = new Set(tokens(p.text))
        const coverage = words.length
          ? words.filter((w) => pt.has(w)).length / words.length
          : 1
        if (
          coverage >= (qs.length > 0 ? 0.5 : 0.6) &&
          (!best || coverage > best.coverage)
        )
          best = { p, coverage }
      }
    const key = best ? citePassage(best.p, oc.statement) : null
    add({
      origin: "owner",
      kind: "statement",
      attribute: null,
      value: null,
      statement: oc.statement,
      status: key ? "supported" : "unverified",
      reason: key
        ? `Stated by ${describe([best!.p.sourceKey])}.`
        : checkable
          ? "No retrieved passage states this."
          : "General or subjective wording; sources can't confirm it.",
      topic,
      timeSensitive: false,
      evidence: key ? [{ key, relationship: "supports" }] : [],
    })
  }

  // 4. Source facts the owner didn't claim (and disagreements between sources).
  const groups = new Map<string, Candidate[]>()
  for (const c of candidates) {
    if (ownerKeys.has(c.key)) continue
    groups.set(c.key, [...(groups.get(c.key) ?? []), c])
  }
  for (const [key, list] of groups) {
    const clusters: Candidate[][] = []
    for (const c of list) {
      const home = clusters.find(
        (cl) => compareValues(key, cl[0].value, c.value) === "supports",
      )
      if (home) home.push(c)
      else clusters.push([c])
    }
    const conflicting = clusters.some((a, i) =>
      clusters.some(
        (b, j) =>
          j > i && compareValues(key, a[0].value, b[0].value) === "contradicts",
      ),
    )
    const first = clusters.sort(
      (a, b) =>
        b.length - a.length ||
        Math.min(...a.map((c) => trustOrder[byKey.get(c.sourceKey)!.trust])) -
          Math.min(...b.map((c) => trustOrder[byKey.get(c.sourceKey)!.trust])),
    )[0]
    const head = first[0]
    const links: ResearchClaim["evidence"] = []
    for (const c of first.slice(0, 3)) {
      const k = citeCandidate(c)
      if (k) links.push({ key: k, relationship: "supports" })
    }
    if (conflicting)
      for (const cl of clusters.slice(1))
        for (const c of cl.slice(0, 2)) {
          const k = citeCandidate(c)
          if (k)
            links.push({
              key: k,
              relationship:
                compareValues(key, head.value, c.value) === "contradicts"
                  ? "contradicts"
                  : "context",
            })
        }
    if (links.length === 0) continue
    const timeSensitive = head.timeSensitive
    add({
      origin: "source",
      kind: isIdentity(key) ? "identity" : "attribute",
      attribute: head.label,
      value: head.value,
      statement: clip(`${head.label}: ${head.value}`, 500),
      status: conflicting ? "conflicting" : "supported",
      reason: conflicting
        ? clip(
            `Sources disagree: ${clusters
              .map(
                (cl) =>
                  `${cl[0].value} (${[...new Set(cl.map((c) => c.sourceKey))].join(", ")})`,
              )
              .join(" vs ")}.`,
            300,
          )
        : clip(
            `Stated by ${describe(first.map((c) => c.sourceKey))}${timeSensitive ? `; as of ${byKey.get(head.sourceKey)!.retrievedAt?.slice(0, 10)}, may have changed` : ""}.`,
            300,
          ),
      topic: timeSensitive ? claimTopic(head.label, key) : null,
      timeSensitive,
      evidence: links,
    })
  }

  // 5. The brief.
  const keysWhere = (f: (c: ResearchClaim) => boolean) =>
    claims.filter(f).map((c) => c.key)
  const identifiedSource =
    usable.find((s) => s.trust === "manufacturer") ?? usable[0] ?? null
  const identifiers = claims
    .filter((c) => c.kind === "identity" && c.status === "supported")
    .map((c) => ({
      label: c.attribute ?? "",
      value: c.value ?? "",
      evidence: c.evidence.map((e) => e.key),
    }))
  const sourcesOf = (c: ResearchClaim) => [
    ...new Set(
      c.evidence
        .filter((e) => e.relationship === "supports")
        .map((e) => evidence.find((x) => x.key === e.key)?.sourceKey)
        .filter((k): k is string => Boolean(k)),
    ),
  ]
  const features = claims.filter(
    (c) =>
      c.status === "supported" &&
      c.kind !== "identity" &&
      !c.timeSensitive &&
      c.topic === null,
  )
  const sellingPoints = features
    .map((c) => {
      const keys = sourcesOf(c)
      const trusts = keys.map((k) => byKey.get(k)?.trust)
      const basis = trusts.includes("manufacturer")
        ? "manufacturer page"
        : keys.length >= 2
          ? `${keys.length} sources agree`
          : trusts[0] === "seller_listing"
            ? "one seller listing only"
            : trusts[0] === "independent_review"
              ? "one review only"
              : "one source only"
      return {
        text:
          c.kind === "attribute" ? `${c.attribute}: ${c.value}` : c.statement,
        claims: [c.key],
        basis,
        rank: trusts.includes("manufacturer") ? 0 : keys.length >= 2 ? 1 : 2,
      }
    })
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 8)
    .map((p) => ({ text: p.text, claims: p.claims, basis: p.basis }))

  const limitations: string[] = [
    "Scout only reads the reference pages you supplied; it doesn't search the web, and affiliate links are never visited.",
  ]
  for (const s of sources) {
    if (s.outcome === "product_mismatch")
      limitations.push(
        clip(
          `${s.key} (${hostOf(s.finalUrl ?? s.requestedUrl)}) was read but doesn't clearly describe “${owner.name}”, so nothing from it was used.`,
          300,
        ),
      )
    else if (s.outcome !== "ok")
      limitations.push(
        clip(
          `${s.key} (${hostOf(s.requestedUrl)}) wasn't used: ${s.detail ?? s.outcome}`,
          300,
        ),
      )
    if (s.content && s.content.signals.suspiciousPassages > 0)
      limitations.push(
        clip(
          `${s.key} contains text addressed to AI systems (e.g. “ignore previous instructions”); it was treated as page content and never used as evidence.`,
          300,
        ),
      )
  }
  if (!usable.some((s) => s.trust === "manufacturer"))
    limitations.push(
      "No manufacturer page was read and matched, so nothing here is confirmed by the maker.",
    )
  if (claims.some((c) => c.timeSensitive))
    limitations.push(
      "Prices, availability and ratings are as retrieved and may have changed; they aren't used as selling points.",
    )
  if (claims.some((c) => c.origin === "owner" && c.topic !== null))
    limitations.push(
      "Claims about price, health, certification, warranty, delivery, stock or superiority are listed for review only, never as selling points.",
    )
  if (extraction.note) limitations.push(clip(extraction.note, 300))

  const ownerActions: string[] = []
  const referenced = sources.filter(
    (s) =>
      s.outcome !== "affiliate_link_skipped" && s.outcome !== "not_attempted",
  )
  if (referenced.length === 0)
    ownerActions.push(
      "Add a public product page as a research reference (the manufacturer's page is best).",
    )
  if (!sources.some((s) => s.referenceKind === "manufacturer"))
    ownerActions.push(
      "If the maker has a product page, add it as a Manufacturer reference.",
    )
  for (const c of claims.filter((x) => x.status === "conflicting"))
    ownerActions.push(
      clip(
        `Resolve the conflict on “${c.attribute ?? c.statement}”: ${c.reason}`,
        300,
      ),
    )
  for (const c of claims
    .filter((x) => x.origin === "owner" && x.status === "unverified")
    .slice(0, 10))
    ownerActions.push(
      clip(
        `Add a source that states “${c.statement}”, or remove it before Quill uses it.`,
        300,
      ),
    )
  for (const s of sources.filter(
    (x) =>
      !["ok", "affiliate_link_skipped", "product_mismatch"].includes(x.outcome),
  ))
    ownerActions.push(
      clip(
        `Replace or fix ${hostOf(s.requestedUrl)}: ${s.detail ?? s.outcome}`,
        300,
      ),
    )
  for (const s of sources.filter((x) => x.outcome === "product_mismatch"))
    ownerActions.push(
      clip(
        `Check that ${hostOf(s.finalUrl ?? s.requestedUrl)} is the right product page.`,
        300,
      ),
    )

  const brief: ResearchBrief = {
    format: "scout-brief/1",
    status:
      usable.length > 0 &&
      claims.some((c) => c.status === "supported" || c.status === "conflicting")
        ? "complete"
        : "insufficient_evidence",
    product: {
      name: clip(owner.name, 120),
      identification: usable.length > 0 ? "identified" : "not_identified",
      identifiedAs: identifiedSource?.productName ?? null,
      identifiers,
    },
    supportedFacts: keysWhere(
      (c) => c.status === "supported" && !c.timeSensitive,
    ),
    unverifiedOwnerClaims: keysWhere(
      (c) => c.origin === "owner" && c.status === "unverified",
    ),
    conflicts: keysWhere((c) => c.status === "conflicting"),
    insufficient: keysWhere((c) => c.status === "insufficient_evidence"),
    features: features.map((c) => c.key),
    sellingPoints,
    timeSensitive: claims
      .filter((c) => c.timeSensitive && c.status === "supported")
      .map((c) => ({
        claim: c.key,
        retrievedAt:
          byKey.get(
            evidence.find((e) => e.key === c.evidence[0]?.key)?.sourceKey ?? "",
          )?.retrievedAt ?? now.toISOString(),
      })),
    limitations: [...new Set(limitations)].slice(0, 30),
    ownerActions: [...new Set(ownerActions)].slice(0, 30),
    extraction,
    generatedAt: now.toISOString(),
  }
  return { brief, claims, evidence }
}

export function hostOf(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return "an invalid address"
  }
}

export function trustFor(
  kind: ReferenceKind,
  identified: boolean,
): SourceTrust {
  if (kind === "manufacturer") return identified ? "manufacturer" : "unknown"
  if (kind === "listing") return "seller_listing"
  if (kind === "review" || kind === "demo_video") return "independent_review"
  return "unknown"
}

export type { SensitiveTopic }
