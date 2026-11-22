import {
  QUILL_FORMAT,
  QUILL_TEMPLATES,
  type GenerationMode,
  type QuillScene,
  type QuillScriptDocument,
} from "@/lib/quill/types"
import type { ResearchReport } from "@/lib/scout/types"
import { VIDEO_FORMAT } from "@/lib/video/format"
import { buildStoryboard } from "@/lib/video/storyboard"
import type { ProductInfo } from "@/lib/video/types"
import {
  DEFAULT_DISCLOSURE,
  MEDIA_LIMITS,
  TEXT_LIMITS,
  codePointLength,
  normalizeText,
  validateProduct,
} from "@/lib/video/validation"
import { MAX_BENEFITS, type EligibleFact } from "@/server/quill/select"

/**
 * Template-based script composition (DV-005B). Not AI: a small, fixed set
 * of sentence patterns filled with the product name and eligible Scout
 * facts only.
 *
 * - Hook: introduces the product or asks a plain question. No facts, no
 *   urgency, prices, popularity, reviews or superiority.
 * - Benefits: one scene per eligible fact (at most 5), caption and
 *   narration built from the claim itself, linked to its evidence.
 * - Call to action: neutral ("Check the product details").
 * - Disclosure: Pixel's default affiliate disclosure, required on every
 *   scene.
 * Durations come from Pixel's own storyboard fitting (15–30 s, 2–8 s per
 * scene), so the script lines up with what Pixel would render.
 */

export const HOOKS = [
  {
    headline: (name: string) => `Meet the ${name}`,
    narration: (name: string) => `Meet the ${name}.`,
  },
  {
    headline: (name: string) => `A closer look at the ${name}`,
    narration: (name: string) => `A closer look at the ${name}.`,
  },
  {
    headline: (name: string) => `What does the ${name} offer?`,
    narration: (name: string) => `What does the ${name} offer?`,
  },
] as const

export const CALL_TO_ACTION = {
  caption: "Check the product details",
  narration: "Check the product details through the link.",
}

export const WORDS_PER_SECOND = 2.5

/** Deterministic pattern choice per product (stable across retries). */
export function hookIndex(productId: string) {
  let h = 0
  for (const ch of productId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % HOOKS.length
}

export const words = (text: string) => text.split(/\s+/).filter(Boolean).length

export interface ComposeInput {
  report: ResearchReport
  snapshot: { checksum: string; data: Record<string, unknown> }
  ticketId: string
  eligible: EligibleFact[]
  excluded: QuillScriptDocument["excludedClaims"]
  now: Date
  /** Optional model wording that already passed validation. */
  wording?: {
    hook?: { headline: string; narration: string }
    benefits?: Map<string, string>
    callToAction?: { caption: string; narration: string }
  }
  generation?: QuillScriptDocument["generation"]
}

const product = (data: Record<string, unknown>) =>
  (data.product ?? {}) as {
    name?: string
    mediaRights?: string
    assets?: { kind?: string }[]
  }

export function composeScript(input: ComposeInput): QuillScriptDocument {
  const p = product(input.snapshot.data)
  const name = normalizeText(String(p.name ?? input.report.productName))
  const platform = String(
    (input.snapshot.data.ticket as { platform?: string })?.platform ?? "tiktok",
  )
  const facts = input.eligible.slice(0, MAX_BENEFITS)
  const pattern = HOOKS[hookIndex(input.report.productId)]
  let headline = pattern.headline(name)
  if (codePointLength(headline) > TEXT_LIMITS.headline)
    headline = "A closer look"
  const hook = input.wording?.hook ?? {
    headline,
    narration: pattern.narration(name),
  }
  const cta = input.wording?.callToAction ?? CALL_TO_ACTION

  const pixelProduct: ProductInfo = {
    name,
    headline: hook.headline,
    benefits: facts.map((f) => f.caption),
    callToAction: cta.caption,
    disclosure: DEFAULT_DISCLOSURE,
  }
  const storyboard = buildStoryboard(pixelProduct, [])
  const ms = (frames: number) => Math.round((frames / VIDEO_FORMAT.fps) * 1000)
  const rights = p.mediaRights ?? "unspecified"
  const imageNote =
    rights === "unspecified"
      ? [
          "The product's media rights are unspecified: confirm you may use its images.",
        ]
      : []

  const scenes: QuillScene[] = storyboard.map((s, i) => {
    if (s.kind === "hook")
      return {
        id: s.id,
        kind: s.kind,
        durationMs: ms(s.durationFrames),
        narration: hook.narration,
        caption: hook.headline,
        subtext: codePointLength(name) <= TEXT_LIMITS.name ? name : null,
        visual:
          "Hero product image (your own or licensed photo); headline centred with the product name below.",
        claims: [],
        notes: imageNote,
      }
    if (s.kind === "call-to-action")
      return {
        id: s.id,
        kind: s.kind,
        durationMs: ms(s.durationFrames),
        narration: cta.narration,
        caption: cta.caption,
        subtext: codePointLength(name) <= TEXT_LIMITS.name ? name : null,
        visual:
          "Hero product image again; call to action centred. The link goes in the post, not in the video.",
        claims: [],
        notes: [],
      }
    const f = facts[i - 1]
    return {
      id: s.id,
      kind: s.kind,
      durationMs: ms(s.durationFrames),
      narration: input.wording?.benefits?.get(f.claim.key) ?? f.narration,
      caption: f.caption,
      subtext: null,
      visual: `A product image that shows ${f.attribute ? `the ${f.attribute}` : "this feature"}; caption at the bottom. Show nothing the caption doesn't state.`,
      claims: [
        {
          claimKey: f.claim.key,
          statement: f.claim.statement,
          evidence: f.evidence,
        },
      ],
      notes: [],
    }
  })

  const textCheck = validateProduct(pixelProduct)
  const images = (p.assets ?? []).filter((a) => a.kind === "image").length
  const renderIssues: string[] = []
  if (images < MEDIA_LIMITS.minCount)
    renderIssues.push(
      `Pixel needs ${MEDIA_LIMITS.minCount}–${MEDIA_LIMITS.maxCount} product images; this product has ${images}. Add images to the product before rendering (DV-005C).`,
    )
  const narrationWords = scenes.reduce((n, s) => n + words(s.narration), 0)
  const generation: QuillScriptDocument["generation"] = input.generation ?? {
    mode: "template" as GenerationMode,
    templates: QUILL_TEMPLATES,
    model: null,
    modelProposalsAccepted: 0,
    modelProposalsRejected: 0,
    note: null,
  }
  return {
    format: QUILL_FORMAT,
    ticketId: input.ticketId,
    productId: input.report.productId,
    productName: name,
    snapshotChecksum: input.snapshot.checksum,
    report: {
      id: input.report.id,
      version: input.report.reportVersion,
      checksum: input.report.checksum,
    },
    generation,
    language: "en",
    platform,
    status: "valid",
    totalDurationMs: scenes.reduce((n, s) => n + s.durationMs, 0),
    estimatedNarrationSeconds:
      Math.round((narrationWords / WORDS_PER_SECOND) * 10) / 10,
    scenes,
    disclosure: {
      text: DEFAULT_DISCLOSURE,
      placement: "every-scene",
      required: true,
      source: "pixel-default",
    },
    pixel: {
      product: pixelProduct,
      textCompatible: textCheck.ok,
      textIssues: textCheck.ok ? [] : textCheck.issues.map((i) => i.message),
      renderReady: renderIssues.length === 0,
      renderIssues,
      imageCount: images,
    },
    findings: [],
    excludedClaims: input.excluded,
    generatedAt: input.now.toISOString(),
  }
}
