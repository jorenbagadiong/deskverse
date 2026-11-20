"use client"

import { useEffect, useLayoutEffect, useRef } from "react"
import { animate, createScope, stagger, type Scope } from "animejs"
import {
  Armchair,
  Coffee,
  Footprints,
  Gamepad2,
  Hand,
  Monitor,
  MousePointerClick,
  Users,
  X,
} from "lucide-react"

import { EmployeeAvatar } from "@/components/employees/employee-card"
import { StatusBadge } from "@/components/employees/status-badge"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  EMPLOYEE_STATUSES,
  statusMeta,
  type EmployeeStatus,
} from "@/config/employee-status"
import { getOfficeEmployee, type OfficeEmployeeId } from "@/config/office"
import { duration, ease, motionQueries } from "@/lib/motion"
import {
  ACTIVITY_LABEL,
  activityOf,
  locationLabel,
  type DestinationOption,
  type Movement,
} from "@/lib/office-movement"
import { simulatedActions } from "@/lib/office-simulation"

import { SimulatedTag } from "./simulated-tag"

const intentVariant = {
  primary: "default",
  secondary: "outline",
  danger: "destructive",
} as const

const MOVE_ICON = {
  desk: Monitor,
  pantry: Coffee,
  lounge: Armchair,
  gaming: Gamepad2,
  meeting: Users,
  stop: Hand,
} as const

export function EmployeeDetails({
  selectedId,
  status,
  movement,
  moveOptions,
  onMove,
  onSetStatus,
  onClose,
}: {
  selectedId: OfficeEmployeeId | null
  status: EmployeeStatus | null
  /** Physical movement, shown and controlled separately from the task status. */
  movement: Movement | null
  moveOptions: DestinationOption[]
  onMove: (option: DestinationOption["kind"]) => void
  onSetStatus: (status: EmployeeStatus) => void
  onClose: () => void
}) {
  const root = useRef<HTMLElement>(null)
  const statusBlock = useRef<HTMLDivElement>(null)
  const scope = useRef<Scope | null>(null)
  const previous = useRef<{
    id: OfficeEmployeeId | null
    status: EmployeeStatus | null
  }>({
    id: selectedId,
    status,
  })

  useEffect(() => {
    scope.current = createScope({ root, mediaQueries: motionQueries }).add(
      (self) => {
        if (!self) return
        // Panel entrance when a (different) employee is selected.
        self.add("enter", () => {
          if (self.matches.reduceMotion) return
          animate("[data-panel-item]", {
            opacity: [0, 1],
            translateY: [10, 0],
            duration: duration.base + 80,
            ease: ease.out,
            delay: stagger(45),
          })
        })
        // Task status message when the state changes.
        self.add("statusChanged", () => {
          if (self.matches.reduceMotion) return
          animate("[data-status-badge]", {
            scale: [0.85, 1],
            duration: 420,
            ease: ease.spring,
          })
          animate("[data-status-message]", {
            opacity: [0, 1],
            translateX: [-8, 0],
            duration: duration.base,
            ease: ease.out,
          })
        })
      },
    )
    return () => scope.current?.revert()
  }, [])

  useLayoutEffect(() => {
    const before = previous.current
    previous.current = { id: selectedId, status }
    if (!selectedId) return
    if (before.id !== selectedId) scope.current?.methods.enter?.()
    else if (before.status !== status) scope.current?.methods.statusChanged?.()
  }, [selectedId, status])

  const employee = selectedId ? getOfficeEmployee(selectedId) : null
  const location = movement ? locationLabel(movement) : null
  // One explanation for unavailable breaks (busy, spots taken…), shown once.
  const breakNote = moveOptions.find(
    (o) => (o.kind === "pantry" || o.kind === "lounge") && !o.enabled,
  )?.reason

  return (
    <section
      ref={root}
      aria-labelledby="employee-details-title"
      className="rounded-2xl bg-card p-4 text-card-foreground shadow-flat ring-1 ring-border"
    >
      {!employee || !status ? (
        <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
          <MousePointerClick
            aria-hidden="true"
            className="size-6 text-muted-foreground"
          />
          <h2 id="employee-details-title" className="font-semibold">
            No employee selected
          </h2>
          <p className="text-sm text-muted-foreground">
            Click a robot in the office or choose someone from the list above.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <header data-panel-item="" className="flex items-start gap-3">
            <EmployeeAvatar employee={employee} className="size-11" />
            <div className="min-w-0 flex-1">
              <h2 id="employee-details-title" className="text-title">
                {employee.name}
              </h2>
              <p className="text-sm text-muted-foreground">
                {employee.agentTitle}
                {employee.role !== employee.agentTitle
                  ? ` · ${employee.role}`
                  : null}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Close details for ${employee.name}`}
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </Button>
          </header>

          <p data-panel-item="" className="text-sm text-muted-foreground">
            {employee.summary}
          </p>

          <div
            ref={statusBlock}
            tabIndex={-1}
            data-panel-item=""
            className="space-y-2 rounded-xl bg-surface-sunken p-3 ring-1 ring-border"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Current status</h3>
              <SimulatedTag />
            </div>
            <StatusBadge data-status-badge="" status={status} />
            <p className="text-xs text-muted-foreground">
              {statusMeta[status].description}
            </p>
            <p data-status-message="" className="text-sm">
              <span className="sr-only">Simulated task: </span>
              {employee.tasks[status]}
            </p>
          </div>

          {movement ? (
            <div
              data-panel-item=""
              className="space-y-2 rounded-xl bg-surface-sunken p-3 ring-1 ring-border"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="movement-label" className="text-sm font-medium">
                  Location
                </h3>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Footprints aria-hidden="true" className="size-3.5" />
                  {ACTIVITY_LABEL[activityOf(movement)]}
                </span>
              </div>
              <p data-location="" className="text-sm">
                {location}
              </p>
              <div
                role="group"
                aria-labelledby="movement-label"
                className="flex flex-wrap gap-2"
              >
                {moveOptions.map((option) => {
                  const Icon = MOVE_ICON[option.kind]
                  return (
                    <Button
                      key={option.kind}
                      size="sm"
                      variant="outline"
                      disabled={!option.enabled}
                      title={option.reason}
                      onClick={() => onMove(option.kind)}
                    >
                      <Icon aria-hidden="true" />
                      {option.label}
                    </Button>
                  )
                })}
              </div>
              {breakNote ? (
                <p className="text-xs text-muted-foreground">
                  Breaks: {breakNote}.
                </p>
              ) : null}
            </div>
          ) : null}

          <div data-panel-item="" className="space-y-2">
            <h3 className="text-sm font-medium">Simulated actions</h3>
            <div className="flex flex-wrap gap-2">
              {simulatedActions[status].map((action) => (
                <Button
                  key={action.id}
                  size="sm"
                  variant={intentVariant[action.intent]}
                  onClick={() => {
                    onSetStatus(action.next)
                    // The clicked button disappears with the old state; keep focus nearby.
                    statusBlock.current?.focus()
                  }}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          </div>

          <div data-panel-item="" className="space-y-2">
            <h3 id="set-state-label" className="text-sm font-medium">
              Set state directly
            </h3>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={1}
              aria-labelledby="set-state-label"
              value={status}
              onValueChange={(value) => {
                if (value) onSetStatus(value as EmployeeStatus)
              }}
              className="w-full flex-wrap"
            >
              {EMPLOYEE_STATUSES.map((s) => (
                <ToggleGroupItem key={s} value={s}>
                  {statusMeta[s].label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>
      )}

      {/* One polite announcement for selection and status changes. */}
      <p aria-live="polite" className="sr-only">
        {employee && status
          ? `${employee.name}: ${statusMeta[status].label} (simulated status). ${location ?? ""}`
          : ""}
      </p>
    </section>
  )
}
