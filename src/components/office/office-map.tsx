import { Info } from "lucide-react"

import { EmployeeAvatar } from "@/components/employees/employee-card"
import { StatusBadge } from "@/components/employees/status-badge"
import type { EmployeeStatus } from "@/config/employee-status"
import {
  employeesOnFloor,
  FLOORS,
  type FloorId,
  type OfficeEmployeeId,
} from "@/config/office"
import { activityOf, locationLabel, type Movement } from "@/lib/office-movement"
import { cn } from "@/lib/utils"

/** Floors in plan order: upper floor drawn first, like a building section. */
export const MAP_FLOORS: FloorId[] = [2, 1]

/**
 * 2D floor plan of both floors: the fallback when WebGL is unavailable or
 * fails, and an optional lightweight view. Fully operable without three.js.
 */
export function OfficeMap({
  statuses,
  movement,
  selectedId,
  onSelect,
  notice,
}: {
  statuses: Record<OfficeEmployeeId, EmployeeStatus>
  /** Where people are; the plan lists them by their home desk. */
  movement?: Record<OfficeEmployeeId, Movement>
  selectedId: OfficeEmployeeId | null
  onSelect: (id: OfficeEmployeeId) => void
  notice?: string
}) {
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4 pt-14 pb-6 sm:p-6 sm:pt-14">
      {notice ? (
        <p className="flex items-start gap-2 rounded-lg bg-surface/90 p-3 text-sm ring-1 ring-border">
          <Info
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-primary"
          />
          {notice}
        </p>
      ) : null}
      {MAP_FLOORS.map((floor) => {
        const headingId = `map-floor-${floor}`
        return (
          <section
            key={floor}
            aria-labelledby={headingId}
            className="rounded-2xl border border-dashed border-border bg-surface/40 p-3"
          >
            <h3 id={headingId} className="mb-2 text-sm font-semibold">
              {FLOORS[floor].short}{" "}
              <span className="font-normal text-muted-foreground">
                · {FLOORS[floor].name}
              </span>
            </h3>
            <ul
              className={cn(
                "grid gap-2",
                floor === 1 ? "sm:grid-cols-4" : "sm:grid-cols-3",
              )}
            >
              {employeesOnFloor(floor).map((employee) => {
                const selected = employee.id === selectedId
                return (
                  <li key={employee.id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onSelect(employee.id)}
                      className={cn(
                        "flex w-full flex-col items-start gap-2 rounded-xl border-2 bg-surface/80 p-3 text-left transition-colors",
                        selected
                          ? "border-primary bg-surface"
                          : "border-border hover:border-input",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <EmployeeAvatar
                          employee={employee}
                          className="size-8"
                        />
                        <span>
                          <span className="block text-sm font-semibold">
                            {employee.name}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {employee.agentTitle}
                          </span>
                        </span>
                      </span>
                      <StatusBadge status={statuses[employee.id]} />
                      {movement &&
                      activityOf(movement[employee.id]) !== "at-desk" ? (
                        <span className="text-xs text-muted-foreground">
                          {locationLabel(movement[employee.id])}
                        </span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
