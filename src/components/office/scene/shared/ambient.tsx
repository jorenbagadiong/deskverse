"use client"

import { useEffect } from "react"
import { useThree } from "@react-three/fiber"

/**
 * Idle life without continuous rendering: instead of every robot breathing at
 * 60 fps, a scheduler asks one employee at a time to blink (and every third
 * tick, glance around). Each request triggers a short burst of frames.
 *
 * Deterministic order (round-robin) and fixed timing keep it testable.
 * Paused while the office is hidden (route preserved by Activity), the browser
 * tab is in the background, or reduced motion is requested.
 */
export type AmbientRequest = "blink" | "glance"

export type AmbientStore = {
  requests: React.RefObject<Map<string, AmbientRequest>>
  /** Set by the DOM-side scene wrapper: false while the route is hidden. */
  active: React.RefObject<boolean>
}

export const AMBIENT_INTERVAL_MS = 2400

/** Which employee acts on a given tick, and how. Pure for testing. */
export function ambientRequestFor(
  tick: number,
  ids: readonly string[],
): [string, AmbientRequest] {
  const id = ids[tick % ids.length]
  return [id, tick % 3 === 2 ? "glance" : "blink"]
}

export function AmbientScheduler({
  store,
  ids,
  enabled,
}: {
  store: AmbientStore
  ids: readonly string[]
  enabled: boolean
}) {
  const invalidate = useThree((s) => s.invalidate)

  useEffect(() => {
    if (!enabled || ids.length === 0) return
    let tick = 0
    const timer = window.setInterval(() => {
      if (!store.active.current || document.hidden) return
      const [id, request] = ambientRequestFor(tick++, ids)
      store.requests.current.set(id, request)
      invalidate()
    }, AMBIENT_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [enabled, ids, invalidate, store])

  return null
}
