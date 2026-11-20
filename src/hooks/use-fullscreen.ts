"use client"

import { useCallback, useState, useSyncExternalStore } from "react"

const subscribe = (onChange: () => void) => {
  document.addEventListener("fullscreenchange", onChange)
  return () => document.removeEventListener("fullscreenchange", onChange)
}
const noopSubscribe = () => () => {}

/**
 * Fullscreen API for one element. `active` follows the browser (Escape, the
 * browser's own UI, or `exit()`), so the layout restores itself however
 * fullscreen ends. A rejected request (iframe policy, iOS Safari, user
 * gesture rules) is reported through `error` instead of throwing.
 */
export function useFullscreen(target: React.RefObject<HTMLElement | null>) {
  const fullscreenElement = useSyncExternalStore(
    subscribe,
    () => document.fullscreenElement,
    () => null,
  )
  const supported = useSyncExternalStore(
    noopSubscribe,
    () =>
      typeof document.documentElement.requestFullscreen === "function" &&
      document.fullscreenEnabled !== false,
    () => false,
  )
  const [error, setError] = useState<string | null>(null)
  // Only the office viewport ever requests fullscreen on this page.
  const active = fullscreenElement !== null

  const enter = useCallback(async () => {
    const el = target.current
    if (!el) return
    setError(null)
    try {
      await el.requestFullscreen({ navigationUI: "hide" })
    } catch {
      setError("Fullscreen isn't available here. The office stays in the page.")
    }
  }, [target])

  const exit = useCallback(async () => {
    if (!document.fullscreenElement) return
    try {
      await document.exitFullscreen()
    } catch {
      // Already left (e.g. Escape raced the button): nothing to do.
    }
  }, [])

  return {
    supported,
    active,
    error,
    enter,
    exit,
    dismissError: () => setError(null),
  }
}
