"use client"

import { useEffect, useRef } from "react"
import { animate, createScope, stagger, type Scope } from "animejs"
import { CheckCheck, Clock, Hourglass, RotateCcw, Users } from "lucide-react"

import { Button } from "@/components/ui/button"
import { duration, ease, motionQueries, takeOverReveal } from "@/lib/motion"

/* Static sample metrics for the showcase. */
const KPIS = [
  {
    label: "Tasks completed",
    value: "128",
    hint: "+12 this week",
    Icon: CheckCheck,
  },
  {
    label: "Awaiting approval",
    value: "3",
    hint: "Oldest: 2h ago",
    Icon: Hourglass,
  },
  { label: "Active employees", value: "5 / 7", hint: "2 idle", Icon: Users },
  {
    label: "Avg. turnaround",
    value: "14m",
    hint: "−3m vs last week",
    Icon: Clock,
  },
] as const

export function DashboardCardsDemo() {
  const root = useRef<HTMLDivElement>(null)
  const scope = useRef<Scope | null>(null)

  useEffect(() => {
    scope.current = createScope({ root, mediaQueries: motionQueries }).add(
      (self) => {
        if (!self || !root.current) return
        if (self.matches.reduceMotion) {
          self.add("reveal", () => {})
          return
        }

        const cards = Array.from(root.current.querySelectorAll("[data-reveal]"))
        takeOverReveal(cards)

        const reveal = () =>
          animate(cards, {
            opacity: [0, 1],
            translateY: [18, 0],
            scale: [0.97, 1],
            duration: duration.slow,
            ease: ease.out,
            delay: stagger(80),
          })

        reveal()
        self.add("reveal", reveal)
      },
    )

    return () => scope.current?.revert()
  }, [])

  return (
    <div ref={root} className="flex flex-col gap-4">
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {KPIS.map(({ label, value, hint, Icon }) => (
          <li
            key={label}
            data-reveal=""
            className="flex flex-col gap-2 rounded-xl bg-card p-4 shadow-raised ring-1 ring-border"
          >
            <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
              <span>{label}</span>
              <Icon aria-hidden="true" className="size-4 text-primary" />
            </div>
            <span className="text-headline tabular-nums">{value}</span>
            <span className="text-xs text-muted-foreground">{hint}</span>
          </li>
        ))}
      </ul>
      <Button
        variant="outline"
        size="sm"
        className="self-start motion-reduce:hidden"
        onClick={() => scope.current?.methods.reveal?.()}
      >
        <RotateCcw aria-hidden="true" />
        Replay card reveal
      </Button>
    </div>
  )
}
