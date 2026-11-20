"use client"

import { useEffect, useRef, useState } from "react"
import { animate, createScope, type JSAnimation, type Scope } from "animejs"

import { EmployeeAvatar } from "@/components/employees/employee-card"
import {
  StatusBadge,
  statusDotClasses,
} from "@/components/employees/status-badge"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  EMPLOYEE_STATUSES,
  statusMeta,
  type EmployeeStatus,
} from "@/config/employee-status"
import { employees } from "@/config/employees"
import { duration, ease, motionQueries } from "@/lib/motion"
import { cn } from "@/lib/utils"

const vera = employees.find((e) => e.id === "vera") ?? employees[0]

export function StatusTransitionDemo() {
  const [status, setStatus] = useState<EmployeeStatus>("idle")
  const root = useRef<HTMLDivElement>(null)
  const scope = useRef<Scope | null>(null)

  useEffect(() => {
    scope.current = createScope({ root, mediaQueries: motionQueries }).add(
      (self) => {
        if (!self) return
        let halo: JSAnimation | null = null

        self.add("transition", (next: EmployeeStatus) => {
          halo?.revert()
          halo = null
          // Reduced motion: the label/color change alone communicates the state.
          if (self.matches.reduceMotion) return

          animate("[data-status-badge]", {
            scale: [0.85, 1],
            opacity: [0.4, 1],
            duration: duration.base + 100,
            ease: ease.spring,
          })
          animate("[data-status-dot]", {
            scale: [0.3, 1],
            duration: 480,
            ease: ease.spring,
          })

          if (next === "working") {
            // Bounded loop: a few pulses signal activity, then it settles.
            halo = animate("[data-status-halo]", {
              scale: [1, 2.6],
              opacity: [0.6, 0],
              duration: 1400,
              ease: "out(2)",
              loop: 4,
            })
          } else if (next === "failed") {
            animate("[data-status-card]", {
              translateX: [
                { to: -6, duration: 60 },
                { to: 6, duration: 90 },
                { to: -4, duration: 80 },
                { to: 3, duration: 70 },
                { to: 0, duration: 60 },
              ],
              ease: ease.inOut,
            })
          } else if (next === "completed") {
            animate("[data-status-card]", {
              translateY: [
                { to: -4, duration: 140 },
                { to: 0, duration: 260 },
              ],
              ease: ease.out,
            })
          }
        })
      },
    )

    return () => scope.current?.revert()
  }, [])

  const meta = statusMeta[status]

  return (
    <div ref={root} className="flex flex-col gap-5">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={1}
        value={status}
        aria-label="Set Vera's status"
        className="w-full flex-wrap"
        onValueChange={(value) => {
          if (!value) return
          const next = value as EmployeeStatus
          setStatus(next)
          // Same DOM nodes persist across the update, so we can animate immediately.
          scope.current?.methods.transition?.(next)
        }}
      >
        {EMPLOYEE_STATUSES.map((s) => (
          <ToggleGroupItem key={s} value={s}>
            {statusMeta[s].label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <div
        data-status-card=""
        className="flex items-center gap-4 rounded-xl bg-surface-sunken p-4 ring-1 ring-border"
      >
        <div className="relative">
          <EmployeeAvatar employee={vera} className="size-12" />
          <span className="absolute -right-1 -bottom-1 inline-flex size-3.5">
            <span
              data-status-halo=""
              aria-hidden="true"
              className={cn(
                "absolute inset-0 rounded-full opacity-0",
                statusDotClasses[status],
              )}
            />
            <span
              data-status-dot=""
              aria-hidden="true"
              className={cn(
                "relative size-3.5 rounded-full ring-2 ring-surface-sunken",
                statusDotClasses[status],
              )}
            />
          </span>
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="font-semibold">
            {vera.name}{" "}
            <span className="font-normal text-muted-foreground">
              · {vera.role}
            </span>
          </p>
          <StatusBadge data-status-badge="" status={status} />
          <p className="text-sm text-muted-foreground">{meta.description}</p>
        </div>
      </div>

      {/* Announced immediately; never waits for an animation. */}
      <p aria-live="polite" className="sr-only">
        {`${vera.name} status: ${meta.label}`}
      </p>
    </div>
  )
}
