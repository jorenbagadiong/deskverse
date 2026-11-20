"use client"

import { useEffect, useLayoutEffect, useRef } from "react"
import { animate, createScope, type Scope } from "animejs"

import { StatusBadge } from "@/components/employees/status-badge"
import { getOfficeEmployee } from "@/config/office"
import { duration, ease, motionQueries } from "@/lib/motion"
import { MAX_ACTIVITY, type ActivityEntry } from "@/lib/office-simulation"

import { SimulatedTag } from "./simulated-tag"

/**
 * UI notifications for simulated status changes. Not a live region: the detail
 * panel already announces changes, so screen readers don't hear them twice.
 */
export function ActivityFeed({ entries }: { entries: ActivityEntry[] }) {
  const root = useRef<HTMLElement>(null)
  const scope = useRef<Scope | null>(null)
  const lastAnimated = useRef(0)

  useEffect(() => {
    scope.current = createScope({ root, mediaQueries: motionQueries }).add(
      (self) => {
        if (!self) return
        self.add("enter", (id: number) => {
          if (self.matches.reduceMotion) return
          animate(`[data-activity-id="${id}"]`, {
            opacity: [0, 1],
            translateY: [-10, 0],
            scale: [0.98, 1],
            duration: duration.base + 120,
            ease: ease.out,
          })
        })
      },
    )
    return () => scope.current?.revert()
  }, [])

  const newestId = entries[0]?.id ?? 0
  useLayoutEffect(() => {
    if (newestId <= lastAnimated.current) return
    lastAnimated.current = newestId
    scope.current?.methods.enter?.(newestId)
  }, [newestId])

  return (
    <section
      ref={root}
      aria-labelledby="activity-title"
      className="rounded-2xl bg-card p-4 text-card-foreground shadow-flat ring-1 ring-border"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="activity-title" className="font-semibold">
          Activity
        </h2>
        <SimulatedTag />
      </div>
      {/* Reserved height for MAX_ACTIVITY items: new entries never shift the page. */}
      <div style={{ minHeight: `${MAX_ACTIVITY * 3.6}rem` }}>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No activity yet. Pick an employee and try a simulated action.
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {entries.map((entry) => (
              <li
                key={entry.id}
                data-activity-id={entry.id}
                className="flex flex-col gap-1.5 rounded-lg bg-surface-raised p-2.5 ring-1 ring-border"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">
                    {getOfficeEmployee(entry.employeeId).name}
                  </span>
                  <StatusBadge status={entry.status} />
                </div>
                <p className="text-xs text-muted-foreground">{entry.message}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  )
}
