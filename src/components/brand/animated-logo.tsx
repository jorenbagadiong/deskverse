"use client"

import { useEffect, useRef } from "react"
import { createScope, createTimeline, type Scope } from "animejs"
import { RotateCcw } from "lucide-react"

import { LogoMark } from "@/components/brand/logo"
import { Button } from "@/components/ui/button"
import { brand } from "@/config/brand"
import { ease, motionQueries, takeOverReveal } from "@/lib/motion"
import { cn } from "@/lib/utils"

/** Brand logo entrance: the portal assembles, then the robot visor lights up. */
export function AnimatedLogo({
  className,
  replayable = false,
}: {
  className?: string
  replayable?: boolean
}) {
  const root = useRef<HTMLDivElement>(null)
  const scope = useRef<Scope | null>(null)

  useEffect(() => {
    scope.current = createScope({ root, mediaQueries: motionQueries }).add(
      (self) => {
        if (!self || !root.current) return

        if (self.matches.reduceMotion) {
          self.add("replay", () => {})
          return
        }

        const part = (name: string) => `[data-logo-part="${name}"]`
        takeOverReveal(
          Array.from(root.current.querySelectorAll("[data-reveal]")),
        )

        const timeline = createTimeline({
          defaults: { duration: 520, ease: ease.out },
        })
          .add(part("frame"), {
            opacity: [0, 1],
            scale: [0.6, 1],
            rotate: [-12, 0],
            duration: 640,
            ease: ease.spring,
          })
          .add(part("portal"), { opacity: [0, 1], translateY: [6, 0] }, "-=320")
          .add(part("desk"), { opacity: [0, 1], scaleX: [0.4, 1] }, "-=380")
          .add(
            part("visor"),
            { opacity: [0, 1], scaleX: [0, 1], ease: ease.spring },
            "-=200",
          )
          .add(
            part("wordmark"),
            { opacity: [0, 1], translateX: [-10, 0] },
            "-=460",
          )

        self.add("replay", () => timeline.restart())
      },
    )

    return () => scope.current?.revert()
  }, [])

  return (
    <div
      ref={root}
      className={cn("flex flex-wrap items-center gap-4", className)}
    >
      <span className="inline-flex items-center gap-4">
        <LogoMark animated className="size-16 sm:size-20" />
        <span
          data-logo-part="wordmark"
          data-reveal=""
          className="text-4xl font-semibold tracking-tight sm:text-5xl"
        >
          {brand.name}
        </span>
      </span>
      {replayable ? (
        <Button
          variant="outline"
          size="sm"
          className="motion-reduce:hidden"
          onClick={() => scope.current?.methods.replay?.()}
        >
          <RotateCcw aria-hidden="true" />
          Replay entrance
        </Button>
      ) : null}
    </div>
  )
}
