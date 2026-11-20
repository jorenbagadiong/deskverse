"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { animate, createScope, type Scope } from "animejs"
import { FastForward, RotateCcw } from "lucide-react"

import { StatusBadge } from "@/components/employees/status-badge"
import { Button } from "@/components/ui/button"
import type { EmployeeStatus } from "@/config/employee-status"
import { duration, ease, motionQueries } from "@/lib/motion"

const TASKS = [
  { id: "research", label: "Trend research", owner: "Scout", step: 25 },
  { id: "script", label: "Script draft", owner: "Quill", step: 18 },
  { id: "render", label: "Teaser render", owner: "Pixel", step: 12 },
  { id: "publish", label: "Publish queue", owner: "Relay", step: 30 },
] as const

const INITIAL = [64, 40, 15, 0]

function statusFor(value: number): EmployeeStatus {
  if (value >= 100) return "completed"
  if (value <= 0) return "idle"
  return "working"
}

export function TaskProgressDemo() {
  const [values, setValues] = useState<number[]>(INITIAL)
  const previous = useRef<number[]>(INITIAL)
  const root = useRef<HTMLDivElement>(null)
  const scope = useRef<Scope | null>(null)

  useEffect(() => {
    scope.current = createScope({ root, mediaQueries: motionQueries }).add(
      (self) => {
        if (!self) return
        self.add("update", (from: number[], to: number[]) => {
          if (self.matches.reduceMotion || !root.current) return
          TASKS.forEach((task, i) => {
            if (from[i] === to[i]) return
            // Bars use scaleX (transform) instead of width: no layout recalculation.
            animate(`[data-progress-fill="${task.id}"]`, {
              scaleX: [from[i] / 100, to[i] / 100],
              duration: duration.slow + 100,
              ease: ease.out,
            })
            // Count the visible (aria-hidden) number by editing React's own text node,
            // so React's next render still updates the same node.
            const label = root.current?.querySelector(
              `[data-progress-label="${task.id}"]`,
            )
            const textNode = label?.firstChild
            if (!textNode) return
            const counter = { value: from[i] }
            animate(counter, {
              value: to[i],
              duration: duration.slow + 100,
              ease: ease.out,
              onUpdate: () => {
                textNode.nodeValue = `${Math.round(counter.value)}%`
              },
            })
          })
        })
      },
    )
    return () => scope.current?.revert()
  }, [])

  // Runs after React commits the final values, before paint.
  useLayoutEffect(() => {
    const from = previous.current
    previous.current = values
    if (from !== values) scope.current?.methods.update?.(from, values)
  }, [values])

  return (
    <div ref={root} className="flex flex-col gap-5">
      <ul className="flex flex-col gap-4">
        {TASKS.map((task, i) => {
          const value = values[i]
          return (
            <li key={task.id} className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span id={`task-${task.id}`} className="text-sm font-medium">
                    {task.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    · {task.owner}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={statusFor(value)} />
                  <span
                    data-progress-label={task.id}
                    aria-hidden="true"
                    className="w-10 text-right font-mono text-sm tabular-nums"
                  >
                    {`${value}%`}
                  </span>
                </div>
              </div>
              <div
                role="progressbar"
                aria-labelledby={`task-${task.id}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={value}
                className="h-2 overflow-hidden rounded-full bg-muted"
              >
                <div
                  data-progress-fill={task.id}
                  className="h-full origin-left rounded-full bg-primary"
                  style={{ transform: `scaleX(${value / 100})` }}
                />
              </div>
            </li>
          )
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() =>
            setValues((v) =>
              v.map((value, i) => Math.min(100, value + TASKS[i].step)),
            )
          }
          disabled={values.every((v) => v >= 100)}
        >
          <FastForward aria-hidden="true" />
          Advance work
        </Button>
        <Button variant="outline" onClick={() => setValues(INITIAL)}>
          <RotateCcw aria-hidden="true" />
          Reset
        </Button>
      </div>
    </div>
  )
}
