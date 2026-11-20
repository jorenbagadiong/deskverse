"use client"

import { useSyncExternalStore } from "react"

let cached: boolean | undefined

function detectWebGL(): boolean {
  if (cached !== undefined) return cached
  try {
    const canvas = document.createElement("canvas")
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl")
    cached = gl !== null
    // Release the probe context immediately; browsers cap live contexts.
    gl?.getExtension("WEBGL_lose_context")?.loseContext()
  } catch {
    cached = false
  }
  return cached
}

const noopSubscribe = () => () => {}

/**
 * `null` during server render and hydration (unknown), then `true`/`false`.
 * Lets the page render a placeholder first and decide on the client
 * whether to load the 3D scene or the 2D fallback.
 */
export function useWebGLSupport(): boolean | null {
  return useSyncExternalStore(noopSubscribe, detectWebGL, () => null)
}
