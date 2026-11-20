import {
  MAX_SCENE_FRAMES,
  MAX_TOTAL_FRAMES,
  MIN_SCENE_FRAMES,
  MIN_TOTAL_FRAMES,
  secondsToFrames,
} from "@/lib/video/format"
import type { AssetId } from "@/lib/video/ids"
import type { ProductInfo, VideoScene } from "@/lib/video/types"

/** Starting durations before the storyboard is fitted into 15–30 seconds. */
export const BASE_SCENE_SECONDS = {
  hook: 3,
  benefit: 4,
  "call-to-action": 4,
} as const

/**
 * Builds the fixed DV-003A storyboard template from product details:
 *
 *   1. Hook: headline over the hero image, with the product name
 *   2…n. One scene per benefit, cycling through the other images
 *   last. Call to action over the hero image
 *
 * The affiliate disclosure is not a scene: it is overlaid on every scene.
 * Durations are whole frames, fitted into 15–30 s while each scene stays
 * within 2–8 s.
 */
export function buildStoryboard(
  product: ProductInfo,
  assetIds: readonly AssetId[],
): VideoScene[] {
  const imageFor = (slot: number): AssetId | null =>
    assetIds.length === 0 ? null : assetIds[slot % assetIds.length]

  const drafts: Omit<VideoScene, "id" | "durationFrames">[] = [
    {
      kind: "hook",
      assetId: imageFor(0),
      caption: {
        text: product.headline,
        subtext: product.name,
        role: "headline",
        position: "center",
      },
    },
    ...product.benefits.map(
      (benefit, index): Omit<VideoScene, "id" | "durationFrames"> => ({
        kind: "benefit",
        assetId: imageFor(index + 1),
        caption: {
          text: benefit,
          subtext: null,
          role: "benefit",
          position: "bottom",
        },
      }),
    ),
    {
      kind: "call-to-action",
      assetId: imageFor(0),
      caption: {
        text: product.callToAction,
        subtext: product.name,
        role: "call-to-action",
        position: "center",
      },
    },
  ]

  const durations = fitDurations(
    drafts.map((scene) => secondsToFrames(BASE_SCENE_SECONDS[scene.kind])),
  )

  return drafts.map((scene, index) => ({
    id: `scene-${index + 1}`,
    durationFrames: durations[index],
    ...scene,
  }))
}

/**
 * Scales frame counts proportionally so their sum lands inside
 * [MIN_TOTAL_FRAMES, MAX_TOTAL_FRAMES], keeping each scene inside the
 * per-scene bounds. Leftover frames from rounding go to the earliest scenes.
 */
export function fitDurations(baseFrames: readonly number[]): number[] {
  const base = baseFrames.reduce((sum, frames) => sum + frames, 0)
  if (base === 0) return baseFrames.map(() => MIN_SCENE_FRAMES)
  const target = Math.min(Math.max(base, MIN_TOTAL_FRAMES), MAX_TOTAL_FRAMES)
  const clamp = (frames: number) =>
    Math.min(Math.max(frames, MIN_SCENE_FRAMES), MAX_SCENE_FRAMES)

  const scaled = baseFrames.map((frames) =>
    clamp(Math.floor((frames * target) / base)),
  )
  let remainder = target - scaled.reduce((sum, frames) => sum + frames, 0)
  for (let i = 0; remainder !== 0 && i < scaled.length * 2; i++) {
    const index = i % scaled.length
    const next = scaled[index] + Math.sign(remainder)
    if (next !== clamp(next)) continue
    scaled[index] = next
    remainder -= Math.sign(remainder)
  }
  return scaled
}

export function storyboardFrames(scenes: readonly VideoScene[]) {
  return scenes.reduce((sum, scene) => sum + scene.durationFrames, 0)
}
