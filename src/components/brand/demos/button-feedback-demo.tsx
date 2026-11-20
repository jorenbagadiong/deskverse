"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { animate, createScope, type Scope } from "animejs"
import { Check, Play, ThumbsUp } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ease, motionQueries } from "@/lib/motion"

export function ButtonFeedbackDemo() {
  const [approved, setApproved] = useState(false)
  const [runs, setRuns] = useState(0)
  const previousApproved = useRef(approved)
  const root = useRef<HTMLDivElement>(null)
  const scope = useRef<Scope | null>(null)

  useEffect(() => {
    scope.current = createScope({ root, mediaQueries: motionQueries }).add(
      (self) => {
        if (!self) return
        self.add("press", (el: HTMLElement) => {
          if (self.matches.reduceMotion) return
          animate(el, {
            scale: [
              { to: 0.94, duration: 90, ease: "out(2)" },
              { to: 1, duration: 420, ease: ease.spring },
            ],
          })
        })
        self.add("popIcon", () => {
          if (self.matches.reduceMotion) return
          animate("[data-approve-icon]", {
            scale: [0.2, 1],
            rotate: [-40, 0],
            duration: 480,
            ease: ease.spring,
          })
        })
      },
    )
    return () => scope.current?.revert()
  }, [])

  // The icon element is swapped on toggle, so pop it after React renders it.
  useLayoutEffect(() => {
    if (previousApproved.current === approved) return
    previousApproved.current = approved
    scope.current?.methods.popIcon?.()
  }, [approved])

  return (
    <div ref={root} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant={approved ? "secondary" : "default"}
          className="transition-colors"
          onClick={(event) => {
            setApproved((a) => !a)
            scope.current?.methods.press?.(event.currentTarget)
          }}
        >
          {approved ? (
            <Check data-approve-icon="" aria-hidden="true" />
          ) : (
            <ThumbsUp data-approve-icon="" aria-hidden="true" />
          )}
          {approved ? "Approved" : "Approve script"}
        </Button>
        <Button
          variant="outline"
          className="transition-colors"
          onClick={(event) => {
            setRuns((r) => r + 1)
            scope.current?.methods.press?.(event.currentTarget)
          }}
        >
          <Play aria-hidden="true" />
          Run workflow
        </Button>
      </div>
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {runs === 0
          ? "No workflow runs queued."
          : `${runs} workflow run${runs === 1 ? "" : "s"} queued.`}
      </p>
    </div>
  )
}
