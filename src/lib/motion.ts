/**
 * Shared Anime.js conventions. Intentionally tiny: constants only, no wrapper
 * framework. Each animated Client Component follows the official v4 React
 * pattern — createScope({ root, mediaQueries }) in useEffect, scope.revert() on cleanup.
 */
import { utils } from "animejs"

/** Pass to createScope({ mediaQueries }) then read scope.matches.reduceMotion. */
export const motionQueries = {
  reduceMotion: "(prefers-reduced-motion: reduce)",
} as const

export const duration = {
  fast: 180,
  base: 320,
  slow: 600,
} as const

/**
 * Hands [data-reveal] elements from the CSS pre-hide over to Anime.js:
 * pins them at opacity 0 inline (via utils.set, so scope.revert() restores the
 * original style), then marks them so the CSS rule/fallback stops applying.
 * Call inside a scope constructor, immediately before animating them.
 */
export function takeOverReveal(targets: Element[]) {
  if (targets.length === 0) return
  utils.set(targets, { opacity: 0 })
  for (const el of targets) el.setAttribute("data-revealed", "")
}

export const ease = {
  /** Default for entrances. */
  out: "out(3)",
  /** Snappy feedback for presses and pops. */
  spring: "outBack(1.7)",
  inOut: "inOut(2)",
} as const
