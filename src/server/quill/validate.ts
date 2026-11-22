import type { Finding, QuillScriptDocument } from "@/lib/quill/types"
import {
  MAX_SCENE_FRAMES,
  MIN_SCENE_FRAMES,
  VIDEO_FORMAT,
} from "@/lib/video/format"
import {
  DEFAULT_DISCLOSURE,
  MAX_SCENES,
  TEXT_LIMITS,
  codePointLength,
} from "@/lib/video/validation"
import { CALL_TO_ACTION, WORDS_PER_SECOND, words } from "@/server/quill/compose"
import { unsafeText, type EligibleFact } from "@/server/quill/select"
import { claimTopic } from "@/server/scout/analysis/attributes"
import { parseQuantities, sameQuantity } from "@/server/scout/analysis/quantity"

/**
 * Validates a composed script before it can become a deliverable
 * (DV-005B). Errors block completion; warnings are kept as findings.
 *
 * This is a conservative content design, not proof of meaning: factual
 * scenes are built from approved, evidence-linked statements, and these
 * checks catch anything that strays (numbers or facts without a linked
 * claim, ineligible claims, unsafe text, marketing guarantees, invented
 * experiences, missing disclosure, Pixel structure).
 */

const EXPERIENCE =
  /\b(I|we)\s+(tested|tried|used|use|love|loved|bought|own|recommend|swear)\b|\bmy (experience|favou?rite|kitchen|home|daily)\b|\bin my\b/i
const GUARANTEE =
  /\b(guarantee[ds]?|guaranteed|risk[- ]free|never (fails|breaks)|always works|100\s?%|forever|instant(ly)? results?|limited time|hurry|act now|last chance|while (supplies|stocks?) last|selling out|everyone (is|loves))\b/i

export function textProblems(text: string): string | null {
  if (unsafeText(text))
    return "contains links, markup, AI-addressed text or unusual characters"
  if (EXPERIENCE.test(text)) return "describes a personal experience nobody had"
  if (GUARANTEE.test(text)) return "makes a guarantee or uses pressure tactics"
  const topic = claimTopic(text)
  if (topic) return `touches a sensitive topic (${topic})`
  return null
}

export function validateScript(
  doc: QuillScriptDocument,
  eligible: readonly EligibleFact[],
): Finding[] {
  const findings: Finding[] = []
  const error = (
    code: string,
    message: string,
    sceneId: string | null = null,
  ) => findings.push({ level: "error", code, message, sceneId })
  const warn = (code: string, message: string, sceneId: string | null = null) =>
    findings.push({ level: "warning", code, message, sceneId })
  const allowed = new Map(eligible.map((f) => [f.claim.key, f]))
  const s = doc.scenes
  // The owner's product name may contain digits or words like "Pro": it is
  // the owner's input, not a claim, so checks look at the text around it.
  const withoutName = (text: string) =>
    doc.productName ? text.split(doc.productName).join(" ") : text

  // Structure (Pixel's scene vocabulary and limits).
  if (s.length < 3 || s.length > MAX_SCENES)
    error("scene-count", `A script needs 3–${MAX_SCENES} scenes.`)
  if (s[0]?.kind !== "hook" || s.filter((x) => x.kind === "hook").length !== 1)
    error("hook", "A script starts with exactly one hook.")
  if (
    s.at(-1)?.kind !== "call-to-action" ||
    s.filter((x) => x.kind === "call-to-action").length !== 1
  )
    error("call-to-action", "A script ends with exactly one call to action.")
  const benefits = s.filter((x) => x.kind === "benefit")
  if (benefits.length < 1 || benefits.length > 5)
    error("benefits", "A script has 1–5 benefit scenes.")
  const ms = (frames: number) => (frames / VIDEO_FORMAT.fps) * 1000
  s.forEach((scene, i) => {
    if (scene.id !== `scene-${i + 1}`)
      error("scene-id", "Scene ids must be scene-1, scene-2…", scene.id)
    if (
      scene.durationMs < ms(MIN_SCENE_FRAMES) - 1 ||
      scene.durationMs > ms(MAX_SCENE_FRAMES) + 1
    )
      error("duration", "Each scene lasts 2–8 seconds.", scene.id)
  })
  const total = s.reduce((n, x) => n + x.durationMs, 0)
  if (
    total < VIDEO_FORMAT.minDurationSeconds * 1000 - 50 ||
    total > VIDEO_FORMAT.maxDurationSeconds * 1000 + 50
  )
    error("total-duration", "The script lasts 15–30 seconds.")

  for (const scene of s) {
    const limit =
      scene.kind === "hook"
        ? TEXT_LIMITS.headline
        : scene.kind === "benefit"
          ? TEXT_LIMITS.benefit
          : TEXT_LIMITS.callToAction
    if (!scene.caption || codePointLength(scene.caption) > limit)
      error(
        "caption-length",
        `The caption must be 1–${limit} characters.`,
        scene.id,
      )
    if (!scene.narration || scene.narration.length > 400)
      error("narration-length", "Narration must be 1–400 characters.", scene.id)
    if (scene.visual.length > 300)
      error("visual-length", "Visual direction is too long.", scene.id)
    for (const [field, text] of [
      ["narration", scene.narration],
      ["caption", scene.caption],
      ["subtext", scene.subtext ?? ""],
      ["visual", scene.visual],
    ] as const) {
      const problem = text ? textProblems(withoutName(text)) : null
      if (problem) error("unsafe-text", `The ${field} ${problem}.`, scene.id)
    }

    // Facts: every claim must be eligible and its evidence real; every
    // number in the scene must come from a linked claim.
    const linked = scene.claims.map((c) => allowed.get(c.claimKey))
    scene.claims.forEach((c, i) => {
      const fact = linked[i]
      if (!fact)
        return error(
          "ineligible-claim",
          `Claim ${c.claimKey} isn't eligible for copy.`,
          scene.id,
        )
      if (c.statement !== fact.claim.statement)
        error(
          "claim-statement",
          `Claim ${c.claimKey} doesn't match the report.`,
          scene.id,
        )
      const known = new Set(fact.evidence.map((e) => e.key))
      if (c.evidence.length === 0 || c.evidence.some((e) => !known.has(e.key)))
        error(
          "evidence",
          `Claim ${c.claimKey} cites evidence that doesn't support it.`,
          scene.id,
        )
    })
    if (scene.kind === "benefit") {
      if (scene.claims.length === 0)
        error(
          "unsupported-benefit",
          "A benefit must be linked to a supported claim.",
          scene.id,
        )
      else if (linked[0] && scene.caption !== linked[0].caption)
        error(
          "caption-claim",
          "A benefit caption must state its claim as recorded.",
          scene.id,
        )
    }
    const claimText = linked
      .filter((f): f is EligibleFact => Boolean(f))
      .map((f) => `${f.caption} ${f.claim.statement}`)
      .join(" ")
    const claimQuantities = parseQuantities(claimText)
    for (const text of [scene.narration, scene.caption].map(withoutName)) {
      for (const q of parseQuantities(text))
        if (!claimQuantities.some((c) => sameQuantity(c, q)))
          error(
            "unsupported-quantity",
            `“${q.text}” isn't stated by a linked claim.`,
            scene.id,
          )
      if (scene.claims.length === 0 && /\d/.test(text.replace(/#ad/i, "")))
        error(
          "unsupported-number",
          "A scene without linked claims can't contain numbers.",
          scene.id,
        )
    }
    const seconds = scene.durationMs / 1000
    if (words(scene.narration) / WORDS_PER_SECOND > seconds + 1)
      warn(
        "narration-pace",
        `The narration may be too long to say in ${seconds.toFixed(1)} s.`,
        scene.id,
      )
  }

  if (
    doc.disclosure.text !== DEFAULT_DISCLOSURE ||
    doc.disclosure.placement !== "every-scene" ||
    !doc.disclosure.required
  )
    error(
      "disclosure",
      "The affiliate disclosure must be present on every scene.",
    )
  if (doc.pixel.product.disclosure !== doc.disclosure.text)
    error("disclosure", "Pixel's text must carry the same disclosure.")
  if (s.at(-1)?.kind === "call-to-action" && s.at(-1)!.caption.length === 0)
    error(
      "call-to-action",
      `Use a neutral call to action such as “${CALL_TO_ACTION.caption}”.`,
    )
  if (!doc.pixel.textCompatible)
    warn(
      "pixel-text",
      `Not yet compatible with Pixel's text limits: ${doc.pixel.textIssues.join(" ")}`,
    )
  if (!doc.pixel.renderReady)
    warn("render-ready", doc.pixel.renderIssues.join(" "))
  return findings
}
