import {
  MOTION_FILTERS,
  TRANSITION_FILTERS,
  type FfmpegCapabilityReport,
} from "@/lib/video/capabilities"
import { VIDEO_FORMAT } from "@/lib/video/format"
import {
  MOTION_STYLES,
  TRANSITION_STYLES,
  type MotionStyle,
  type TransitionStyle,
  type VisualEffects,
} from "@/lib/video/types"

/**
 * Visual effects (DV-003D2): fixed, named choices. The browser only picks a
 * name; every number below and every filter are decided by the server.
 */

/** Projects saved before DV-003D2 have no `effects`: they keep rendering like this. */
export const STATIC_EFFECTS: VisualEffects = {
  motion: "none",
  transition: "cut",
}

/** What new projects start with in the studio. */
export const DEFAULT_EFFECTS: VisualEffects = {
  motion: "gentle-zoom",
  transition: "crossfade",
}

/** Gentle zoom: the product image grows by 5 % over its scene, linearly. */
export const GENTLE_ZOOM = { amount: 0.05 } as const

/**
 * Crossfade: 9 frames (0.3 s at 30 fps), centered on the storyboard's scene
 * boundary — it starts 4 frames before it and ends 5 frames after it. The
 * outgoing scene is held 5 frames longer and the incoming one starts 4
 * frames earlier, so the overlap never changes the total length: the video
 * has exactly the storyboard's frame count.
 */
export const CROSSFADE = {
  frames: 9,
  /** Frames of the dissolve before the boundary (taken from the incoming scene's lead-in). */
  framesBefore: 4,
} as const

export const CROSSFADE_SECONDS = CROSSFADE.frames / VIDEO_FORMAT.fps

export const MOTION_LABELS: Record<
  MotionStyle,
  { label: string; description: string }
> = {
  none: {
    label: "None",
    description: "Each product photo stays still for its whole scene.",
  },
  "gentle-zoom": {
    label: "Gentle zoom",
    description:
      "The product photo slowly grows by about 5\u00a0% during each scene. Captions and the disclosure stay still.",
  },
}

export const TRANSITION_LABELS: Record<
  TransitionStyle,
  { label: string; description: string }
> = {
  cut: {
    label: "Cuts",
    description: "Scenes change instantly.",
  },
  crossfade: {
    label: "Crossfade",
    description:
      "Each scene dissolves into the next over 0.3\u00a0s. The video's length doesn't change.",
  },
}

export function isMotionStyle(value: unknown): value is MotionStyle {
  return (MOTION_STYLES as readonly unknown[]).includes(value)
}

export function isTransitionStyle(value: unknown): value is TransitionStyle {
  return (TRANSITION_STYLES as readonly unknown[]).includes(value)
}

/** Short summary for the storyboard and history, e.g. "Gentle zoom · Crossfade". */
export function describeEffects(effects: VisualEffects) {
  const motion =
    effects.motion === "none"
      ? "Still photos"
      : MOTION_LABELS[effects.motion].label
  return `${motion} · ${TRANSITION_LABELS[effects.transition].label}`
}

/**
 * Where each scene sits in the encoded timeline when scenes crossfade.
 * Frame-based: `leadIn`/`tail` are the extra frames a scene is rendered with
 * so it can overlap its neighbours, and `offset` is the output frame where
 * the dissolve into this scene starts (null for the first scene).
 */
export interface SceneTiming {
  frames: number
  leadIn: number
  tail: number
  /** Frames this scene's own clip has: frames + leadIn + tail. */
  clipFrames: number
  transitionStart: number | null
}

export function sceneTimings(
  sceneFrames: readonly number[],
  transition: TransitionStyle,
): SceneTiming[] {
  const fade = transition === "crossfade"
  const before = fade ? CROSSFADE.framesBefore : 0
  const after = fade ? CROSSFADE.frames - CROSSFADE.framesBefore : 0
  let boundary = 0
  return sceneFrames.map((frames, i) => {
    const leadIn = i > 0 ? before : 0
    const tail = i < sceneFrames.length - 1 ? after : 0
    const timing: SceneTiming = {
      frames,
      leadIn,
      tail,
      clipFrames: frames + leadIn + tail,
      transitionStart: i > 0 && fade ? boundary - before : null,
    }
    boundary += frames
    return timing
  })
}

/** FFmpeg filters the chosen effects need (static with cuts needs none). */
export function effectFilters(effects: VisualEffects): string[] {
  return [
    ...(effects.motion === "gentle-zoom" ? MOTION_FILTERS : []),
    ...(effects.transition === "crossfade" ? TRANSITION_FILTERS : []),
  ]
}

/** Which of those this FFmpeg build lacks. */
export function missingEffectFilters(
  effects: VisualEffects,
  report: Pick<FfmpegCapabilityReport, "filters">,
): string[] {
  return effectFilters(effects).filter(
    (name) => !report.filters.some((f) => f.name === name && f.available),
  )
}

/** Whether each effect can be chosen with this build (for the studio). */
export function effectAvailability(
  report: Pick<FfmpegCapabilityReport, "filters">,
) {
  const has = (names: readonly string[]) =>
    names.every((name) =>
      report.filters.some((f) => f.name === name && f.available),
    )
  return { gentleZoom: has(MOTION_FILTERS), crossfade: has(TRANSITION_FILTERS) }
}

/** Says which effect can't run and which choice avoids it. */
export function missingEffectsMessage(
  effects: VisualEffects,
  missing: readonly string[],
) {
  const motion =
    effects.motion !== "none" &&
    missing.some((name) => (MOTION_FILTERS as readonly string[]).includes(name))
  const transition =
    effects.transition !== "cut" &&
    missing.some((name) =>
      (TRANSITION_FILTERS as readonly string[]).includes(name),
    )
  const needs = [motion && "gentle zoom", transition && "crossfades"]
    .filter(Boolean)
    .join(" and ")
  const choose = [
    motion && "Product motion: None",
    transition && "Scene transitions: Cuts",
  ]
    .filter(Boolean)
    .join(" and ")
  const plural = missing.length > 1 ? "filters" : "filter"
  return `This FFmpeg build lacks the ${missing.join(", ")} ${plural} needed for ${needs}. Choose ${choose}, or install a full FFmpeg build.`
}
