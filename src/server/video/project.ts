import "server-only"

import { isAssetId } from "@/lib/video/ids"
import type { RenderJob } from "@/lib/video/render-job"
import { buildStoryboard } from "@/lib/video/storyboard"
import type { VideoProject } from "@/lib/video/types"
import {
  DEFAULT_VIDEO_SETTINGS,
  MEDIA_LIMITS,
  validateProduct,
  validateVideoProject,
  type Validation,
  type ValidationIssue,
} from "@/lib/video/validation"
import {
  missingGlyphs,
  type FontMetrics,
  type VideoFontWeight,
} from "@/server/video/font-metrics"

/**
 * Builds the project the renderer will use, trusting nothing from the client
 * except product text and the order of already-uploaded image IDs.
 *
 * The browser's storyboard, timings, captions, asset metadata and any FFmpeg
 * option are never accepted: the request may contain exactly
 * `{ product, assetIds }`. Scenes are rebuilt here with the same template and
 * fixed format, every image must belong to *this* job, and the result is
 * re-validated as a whole (durations, 15–30 s, references).
 */

const REQUEST_KEYS = ["product", "assetIds"] as const

export function buildTrustedProject(
  job: RenderJob,
  body: unknown,
  fonts: Record<VideoFontWeight, FontMetrics>,
): Validation<VideoProject> {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return fail("", "The render request must be an object.")
  const unexpected = Object.keys(body).filter(
    (key) => !(REQUEST_KEYS as readonly string[]).includes(key),
  )
  if (unexpected.length > 0)
    return {
      ok: false,
      issues: unexpected.map((key) => ({
        path: key,
        message: `“${key}” isn't an accepted field. Storyboards, timings and encoding options are decided by the server.`,
      })),
    }
  const request = body as Record<(typeof REQUEST_KEYS)[number], unknown>

  const product = validateProduct(request.product, "product")
  if (!product.ok) return product

  const ids = request.assetIds
  if (!Array.isArray(ids)) return fail("assetIds", "Images must be a list.")
  if (ids.length < MEDIA_LIMITS.minCount || ids.length > MEDIA_LIMITS.maxCount)
    return fail(
      "assetIds",
      `Use ${MEDIA_LIMITS.minCount}–${MEDIA_LIMITS.maxCount} product images.`,
    )
  const issues: ValidationIssue[] = []
  const seen = new Set<string>()
  ids.forEach((id, index) => {
    const path = `assetIds.${index}`
    if (!isAssetId(id))
      issues.push({ path, message: "That isn't an image ID." })
    else if (seen.has(id))
      issues.push({ path, message: "The same image is listed twice." })
    else if (!job.assets.some((asset) => asset.id === id))
      issues.push({
        path,
        message: "That image wasn't uploaded to this video.",
      })
    seen.add(String(id))
  })
  if (issues.length > 0) return { ok: false, issues }
  const assetIds = ids as RenderJob["assets"][number]["id"][]
  const assets = assetIds.map((id) => job.assets.find((a) => a.id === id)!)

  const glyphs = glyphIssues(product.value, fonts)
  if (glyphs.length > 0) return { ok: false, issues: glyphs }

  // Rebuild the storyboard server-side and validate the whole project.
  return validateVideoProject({
    product: product.value,
    assets,
    scenes: buildStoryboard(product.value, assetIds),
    settings: DEFAULT_VIDEO_SETTINGS,
  })
}

const FIELD_LABELS = {
  name: "Product name",
  headline: "Video headline",
  callToAction: "Call to action",
  disclosure: "Affiliate disclosure",
} as const

/** Rejects characters the bundled video font can't draw (they'd render as boxes). */
function glyphIssues(
  product: VideoProject["product"],
  fonts: Record<VideoFontWeight, FontMetrics>,
): ValidationIssue[] {
  const checks: {
    path: string
    label: string
    text: string
    font: FontMetrics
  }[] = [
    {
      path: "product.name",
      label: FIELD_LABELS.name,
      text: product.name,
      font: fonts.medium,
    },
    {
      path: "product.headline",
      label: FIELD_LABELS.headline,
      text: product.headline,
      font: fonts.bold,
    },
    ...product.benefits.map((text, i) => ({
      path: `product.benefits.${i}`,
      label: `Benefit ${i + 1}`,
      text,
      font: fonts.bold,
    })),
    {
      path: "product.callToAction",
      label: FIELD_LABELS.callToAction,
      text: product.callToAction,
      font: fonts.bold,
    },
    {
      path: "product.disclosure",
      label: FIELD_LABELS.disclosure,
      text: product.disclosure,
      font: fonts.medium,
    },
  ]
  return checks.flatMap(({ path, label, text, font }) => {
    const missing = missingGlyphs(font, text)
    return missing.length === 0
      ? []
      : [
          {
            path,
            message: `${label} uses characters the video font can't draw (${missing.join(" ")}). Remove them, or use letters, numbers and common punctuation.`,
          },
        ]
  })
}

function fail(
  path: string,
  message: string,
): { ok: false; issues: ValidationIssue[] } {
  return { ok: false, issues: [{ path, message }] }
}
