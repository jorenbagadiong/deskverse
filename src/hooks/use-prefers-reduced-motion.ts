"use client"

import { useSyncExternalStore } from "react"

import { motionQueries } from "@/lib/motion"

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(motionQueries.reduceMotion)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

/**
 * Live `prefers-reduced-motion` value for code outside Anime.js scopes
 * (e.g. the React Three Fiber scene). Server render assumes motion is allowed.
 */
export function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(motionQueries.reduceMotion).matches,
    () => false,
  )
}
