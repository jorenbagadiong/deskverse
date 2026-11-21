import type {
  ReferenceKind,
  ResearchBrief,
  SourceOutcome,
} from "@/lib/scout/types"
import {
  analyse,
  hostOf,
  identify,
  trustFor,
  type AnalysedSource,
  type Analysis,
} from "@/server/scout/analysis/claims"
import type { ScoutConfig } from "@/server/scout/config"
import {
  decodeBody,
  extractHtml,
  extractPlainText,
  type PageContent,
} from "@/server/scout/extract/html"
import { FetchCancelled, type FetchResult } from "@/server/scout/net/fetcher"
import { sameDestination } from "@/server/scout/net/url"
import {
  validateModelFacts,
  type ModelPassage,
  type OllamaStatus,
} from "@/server/scout/ollama"

/**
 * One product's research (DV-005A), from its frozen snapshot only.
 *
 * Reads the owner's reference URLs (manufacturer pages first, at most
 * `maxSources`), never the affiliate link; extracts passages and facts;
 * optionally asks the local model for more candidate facts (validated);
 * then assesses every claim. Bounded by a per-product time and byte
 * budget. Outcomes:
 * - report:      at least one source was read and matched to the product;
 * - transient:   nothing usable yet, but a temporary problem (rate limit,
 *                outage, timeout) might clear: retry later (Retry-After);
 * - needs_input: nothing usable and retrying won't help (no name, no
 *                references, blocked/forbidden/mismatched pages…).
 */

export interface SnapshotProduct {
  name?: unknown
  affiliateUrl?: unknown
  description?: unknown
  specifications?: unknown
  references?: unknown
}

export interface ResearchDeps {
  fetcher: { fetchPage(url: string, signal: AbortSignal): Promise<FetchResult> }
  config: ScoutConfig
  ollama: {
    status(signal: AbortSignal): Promise<OllamaStatus>
    extract(
      product: string,
      passages: ModelPassage[],
      signal: AbortSignal,
    ): Promise<{ raw: unknown; included: ModelPassage[] }>
    model: string
  } | null
  now?: () => Date
}

export type SourceProblem = { host: string; outcome: SourceOutcome }

export type ResearchOutcome =
  | { kind: "report"; analysis: Analysis; sources: AnalysedSource[] }
  | { kind: "needs_input"; message: string; problems: SourceProblem[] }
  | {
      kind: "transient"
      message: string
      retryAfterMs: number | null
      problems: SourceProblem[]
    }

const KIND_ORDER: Record<ReferenceKind, number> = {
  manufacturer: 0,
  listing: 1,
  review: 2,
  other: 3,
  demo_video: 4,
}

const str = (v: unknown) => (typeof v === "string" ? v : "")
const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s

export class ResearchCancelled extends Error {}

/** What a readable page turned out to be (barriers are never evidence). */
function pageBarrier(
  content: PageContent,
): { outcome: SourceOutcome; detail: string } | null {
  const s = content.signals
  const products = content.jsonLd.products.length
  if (s.captcha)
    return {
      outcome: "captcha",
      detail:
        "The site showed a CAPTCHA or bot check; Scout doesn't bypass those.",
    }
  if (s.login)
    return {
      outcome: "login_required",
      detail: "The page asks for a login; Scout never signs in.",
    }
  if (s.paywall)
    return {
      outcome: "paywall",
      detail: "The page is behind a paywall or subscription.",
    }
  if (
    products === 0 &&
    s.visibleChars < 200 &&
    (s.scripts > 0 || s.javascriptMessage)
  )
    return {
      outcome: "javascript_required",
      detail:
        "The page only shows its content with JavaScript, which Scout doesn't run.",
    }
  if (products === 0 && s.visibleChars < 20)
    return { outcome: "no_content", detail: "The page has no readable text." }
  return null
}

export async function researchProduct(
  product: SnapshotProduct,
  ctx: { attempt: number; maxAttempts: number; signal: AbortSignal },
  deps: ResearchDeps,
): Promise<ResearchOutcome> {
  const now = deps.now ?? (() => new Date())
  const name = str(product.name).trim()
  if (!name)
    return {
      kind: "needs_input",
      message:
        "This product has no name, so Scout can't tell which product a page is about. Add the name, mark the ticket Ready, then start a new research run.",
      problems: [],
    }
  const refs = (Array.isArray(product.references) ? product.references : [])
    .filter(
      (r): r is { kind: ReferenceKind; url: string; label?: string } =>
        Boolean(r) && typeof (r as { url?: unknown }).url === "string",
    )
    .map((r, i) => ({ ...r, i }))
    .sort(
      (a, b) =>
        (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.i - b.i,
    )
  if (refs.length === 0)
    return {
      kind: "needs_input",
      message:
        "No research references: add at least one public product page (the manufacturer's page is best) to this product, mark the ticket Ready, then start a new research run. The affiliate link isn't used as evidence.",
      problems: [],
    }

  const started = Date.now()
  const deadline = AbortSignal.timeout(deps.config.productTimeoutMs)
  const signal = AbortSignal.any([ctx.signal, deadline])
  let bytes = 0
  let attempted = 0
  const sources: AnalysedSource[] = []
  let retryAfter: number | null = null
  let retryable = false

  for (const ref of refs) {
    if (ctx.signal.aborted) throw new ResearchCancelled("cancelled")
    const base = {
      key: `S${sources.length + 1}`,
      position: ref.i,
      referenceKind: ref.kind,
      label: clip(str(ref.label), 200),
      requestedUrl: ref.url,
      finalUrl: null,
      title: null,
      httpStatus: null,
      contentType: null,
      byteCount: 0,
      contentSha256: null,
      retrievedAt: null,
      trust: trustFor(ref.kind, false),
      identified: false,
      transport: null,
      content: null,
      productName: null,
      modelFacts: [],
    } satisfies Omit<AnalysedSource, "outcome" | "detail">
    const skip = (outcome: SourceOutcome, detail: string) =>
      sources.push({ ...base, outcome, detail: clip(detail, 300) })

    if (sameDestination(ref.url, str(product.affiliateUrl))) {
      skip(
        "affiliate_link_skipped",
        "This is the affiliate link; Scout doesn't visit it or use it as evidence.",
      )
      continue
    }
    if (attempted >= deps.config.maxSources) {
      skip(
        "not_attempted",
        `Only ${deps.config.maxSources} references are read per product.`,
      )
      continue
    }
    if (
      deadline.aborted ||
      Date.now() - started > deps.config.productTimeoutMs
    ) {
      skip(
        "not_attempted",
        "The time limit for this product was reached first.",
      )
      continue
    }
    if (bytes >= deps.config.maxProductBytes) {
      skip(
        "not_attempted",
        "The download limit for this product was reached first.",
      )
      continue
    }
    attempted++
    let result: FetchResult
    try {
      result = await deps.fetcher.fetchPage(ref.url, signal)
    } catch (error) {
      if (ctx.signal.aborted || !(error instanceof FetchCancelled))
        throw new ResearchCancelled("cancelled")
      skip(
        "timeout",
        "The time limit for this product ran out while reading this page.",
      )
      retryable = true
      continue
    }
    if (!result.ok) {
      sources.push({
        ...base,
        finalUrl: result.finalUrl,
        outcome: result.outcome,
        httpStatus: result.status,
        retrievedAt: result.retrievedAt,
        detail: clip(result.message, 300),
      })
      if (result.retryable) {
        retryable = true
        if (result.retryAfterMs !== null)
          retryAfter = Math.max(retryAfter ?? 0, result.retryAfterMs)
      }
      continue
    }
    bytes += result.byteCount
    const text = decodeBody(result.body, result.charset)
    const content =
      result.contentType === "text/plain"
        ? extractPlainText(text)
        : extractHtml(text)
    const fetched = {
      ...base,
      finalUrl: result.finalUrl,
      httpStatus: result.status,
      contentType: result.contentType,
      byteCount: result.byteCount,
      contentSha256: result.sha256,
      retrievedAt: result.retrievedAt,
      transport: result.transport,
      title: content.title ?? content.meta.ogTitle ?? content.h1,
    }
    const barrier = pageBarrier(content)
    if (barrier) {
      sources.push({
        ...fetched,
        outcome: barrier.outcome,
        detail: barrier.detail,
      })
      continue
    }
    const id = identify(name, content)
    if (!id.identified) {
      sources.push({
        ...fetched,
        outcome: "product_mismatch",
        productName: id.productName,
        detail: clip(
          `The page is about “${id.productName ?? "something else"}”, which doesn't clearly match “${name}”.`,
          300,
        ),
      })
      continue
    }
    sources.push({
      ...fetched,
      outcome: "ok",
      identified: true,
      trust: trustFor(ref.kind, true),
      content,
      productName: id.productName,
      detail:
        content.jsonLd.products.length > 0
          ? "Read; structured product data (JSON-LD) found."
          : "Read.",
    })
  }

  const usable = sources.filter((s) => s.outcome === "ok")
  const problems = sources
    .filter((s) => s.outcome !== "ok")
    .map((s) => ({ host: hostOf(s.requestedUrl), outcome: s.outcome }))
    .slice(0, 10)
  if (usable.length === 0) {
    const summary = sources
      .map(
        (s) =>
          `${hostOf(s.requestedUrl)}: ${(s.detail ?? s.outcome).replace(/\.$/, "")}`,
      )
      .join("; ")
    if (retryable && ctx.attempt < ctx.maxAttempts)
      return {
        kind: "transient",
        message: clip(
          `No reference could be read yet (${summary}). Scout will try again.`,
          500,
        ),
        retryAfterMs: retryAfter,
        problems,
      }
    return {
      kind: "needs_input",
      message: clip(
        `Scout couldn't use any reference for this product (${summary}). Add or fix a public product page, mark the ticket Ready, then start a new research run.`,
        500,
      ),
      problems,
    }
  }

  // Optional local-model extraction (validated against the passages sent).
  const extraction: ResearchBrief["extraction"] = {
    mode: "deterministic",
    model: null,
    modelClaimsAccepted: 0,
    modelClaimsRejected: 0,
    note: null,
  }
  if (deps.config.extraction === "ollama") {
    if (!deps.ollama)
      extraction.note = `Local model extraction is configured but unusable (${deps.config.ollamaProblem ?? "no model"}); deterministic extraction was used.`
    else {
      const status = await deps.ollama.status(ctx.signal).catch(() => null)
      if (!status?.reachable || !status.modelAvailable)
        extraction.note = `Local model extraction wasn't available (${status?.problem ?? "Ollama didn't answer"}); deterministic extraction was used.`
      else {
        extraction.mode = "deterministic+ollama"
        extraction.model = {
          name: deps.ollama.model,
          digest: status.modelDigest,
          ollamaVersion: status.version,
        }
        for (const s of usable) {
          if (ctx.signal.aborted) throw new ResearchCancelled("cancelled")
          const passages = s
            .content!.passages.map((p, i) => ({ p, i }))
            .filter(({ p }) => !p.suspicious)
            .slice(0, 120)
            .map(({ p, i }) => ({ id: `P${i}`, text: p.text }))
          try {
            const { raw, included } = await deps.ollama.extract(
              name,
              passages,
              ctx.signal,
            )
            const { accepted, rejected } = validateModelFacts(raw, included)
            extraction.modelClaimsAccepted += accepted.length
            extraction.modelClaimsRejected += rejected.length
            s.modelFacts = accepted.map((f) => ({
              label: f.attribute,
              value: f.value,
              passage: Number(f.evidenceId.slice(1)),
              model: deps.ollama!.model,
            }))
          } catch {
            if (ctx.signal.aborted) throw new ResearchCancelled("cancelled")
            extraction.note = clip(
              `Local model extraction failed for ${s.key}; its deterministic results were kept.`,
              300,
            )
          }
        }
        if (extraction.modelClaimsRejected > 0)
          extraction.note = clip(
            `${extraction.note ? `${extraction.note} ` : ""}${extraction.modelClaimsRejected} model-proposed facts were rejected (missing or invalid evidence, or values not in the quoted text).`,
            300,
          )
      }
    }
  }

  const analysis = analyse(
    {
      name,
      description: str(product.description),
      specifications: str(product.specifications),
    },
    sources,
    extraction,
    now(),
  )
  return { kind: "report", analysis, sources }
}
