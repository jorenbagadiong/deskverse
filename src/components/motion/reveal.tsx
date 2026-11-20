"use client"

import { useEffect, useRef } from "react"
import { animate, createScope, stagger, type Scope } from "animejs"

import { duration, ease, motionQueries, takeOverReveal } from "@/lib/motion"

/**
 * Staggered entrance for descendants marked `data-reveal` (e.g. dashboard cards).
 * Children stay Server Components; only this wrapper ships JS.
 * Uses opacity + transform only, so it never causes layout shift.
 */
export function Reveal({
  children,
  className,
  staggerMs = 70,
}: {
  children: React.ReactNode
  className?: string
  staggerMs?: number
}) {
  const root = useRef<HTMLDivElement>(null)
  const scope = useRef<Scope | null>(null)

  useEffect(() => {
    scope.current = createScope({ root, mediaQueries: motionQueries }).add(
      (self) => {
        // Reduced motion: CSS never pre-hides, so there is nothing to do.
        if (!self || self.matches.reduceMotion || !root.current) return

        const targets = Array.from(
          root.current.querySelectorAll("[data-reveal]"),
        )
        takeOverReveal(targets)
        animate(targets, {
          opacity: [0, 1],
          translateY: [14, 0],
          duration: duration.slow,
          ease: ease.out,
          delay: stagger(staggerMs),
        })
      },
    )

    return () => scope.current?.revert()
  }, [staggerMs])

  return (
    <div ref={root} className={className}>
      {children}
    </div>
  )
}
