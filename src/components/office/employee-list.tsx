"use client"

import { useEffect, useLayoutEffect, useRef } from "react"
import { animate, createScope, type Scope } from "animejs"

import { EmployeeAvatar } from "@/components/employees/employee-card"
import { StatusBadge } from "@/components/employees/status-badge"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { EmployeeStatus } from "@/config/employee-status"
import {
  employeesOnFloor,
  FLOORS,
  type FloorId,
  type OfficeEmployeeId,
} from "@/config/office"
import { ease, motionQueries } from "@/lib/motion"
import {
  ACTIVITY_LABEL,
  activityOf,
  type Movement,
} from "@/lib/office-movement"

/**
 * Keyboard-first way to pick an employee: one radio group per floor
 * (Tab moves between floors, arrow keys between colleagues). Mirrors 3D
 * selection, so the canvas is never the only way in.
 */
export function EmployeeList({
  statuses,
  movement,
  selectedId,
  onSelect,
}: {
  statuses: Record<OfficeEmployeeId, EmployeeStatus>
  movement?: Record<OfficeEmployeeId, Movement>
  selectedId: OfficeEmployeeId | null
  onSelect: (id: OfficeEmployeeId) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const scope = useRef<Scope | null>(null)

  useEffect(() => {
    scope.current = createScope({ root, mediaQueries: motionQueries }).add(
      (self) => {
        if (!self) return
        self.add("indicate", (id: string) => {
          if (self.matches.reduceMotion) return
          animate(`[data-indicator="${id}"]`, {
            scaleY: [0, 1],
            opacity: [0, 1],
            duration: 360,
            ease: ease.spring,
          })
        })
      },
    )
    return () => scope.current?.revert()
  }, [])

  // Selection transition: grow the accent bar of the newly selected item.
  useLayoutEffect(() => {
    if (selectedId) scope.current?.methods.indicate?.(selectedId)
  }, [selectedId])

  return (
    <div ref={root} className="flex flex-col gap-3">
      {([1, 2] as FloorId[]).map((floor) => {
        const people = employeesOnFloor(floor)
        const onThisFloor = people.some((e) => e.id === selectedId)
        const headingId = `floor-${floor}-heading`
        return (
          <div key={floor} className="flex flex-col gap-1.5">
            <h2
              id={headingId}
              className="px-1 text-eyebrow text-muted-foreground uppercase"
            >
              {FLOORS[floor].short} · {FLOORS[floor].name}
            </h2>
            <ToggleGroup
              type="single"
              orientation="vertical"
              spacing={1}
              aria-labelledby={headingId}
              value={onThisFloor ? (selectedId ?? "") : ""}
              onValueChange={(value) => {
                if (value) onSelect(value as OfficeEmployeeId)
              }}
              className="w-full"
            >
              {people.map((employee) => {
                const selected = employee.id === selectedId
                const activity = movement
                  ? activityOf(movement[employee.id])
                  : "at-desk"
                return (
                  <ToggleGroupItem
                    key={employee.id}
                    value={employee.id}
                    className="relative h-auto w-full justify-start gap-3 overflow-hidden rounded-xl bg-surface px-3 py-2 text-left ring-1 ring-border data-[state=on]:bg-surface-raised data-[state=on]:ring-primary/60"
                  >
                    <span
                      data-indicator={employee.id}
                      aria-hidden="true"
                      className={`absolute inset-y-2 left-0 w-1 origin-center rounded-r-full bg-primary ${selected ? "" : "invisible"}`}
                    />
                    <EmployeeAvatar employee={employee} className="size-8" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold">
                        {employee.name}
                      </span>
                      <span className="block truncate text-xs font-normal text-muted-foreground">
                        {employee.agentTitle}
                        {activity !== "at-desk"
                          ? ` · ${ACTIVITY_LABEL[activity]}`
                          : null}
                      </span>
                    </span>
                    <StatusBadge
                      status={statuses[employee.id]}
                      className="shrink-0"
                    />
                  </ToggleGroupItem>
                )
              })}
            </ToggleGroup>
          </div>
        )
      })}
    </div>
  )
}
