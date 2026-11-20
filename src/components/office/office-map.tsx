import { Info } from "lucide-react"

import { EmployeeAvatar } from "@/components/employees/employee-card"
import { StatusBadge } from "@/components/employees/status-badge"
import type { EmployeeStatus } from "@/config/employee-status"
import {
  officeEmployees,
  ROOMS,
  type OfficeEmployeeId,
  type RoomId,
} from "@/config/office"
import {
  activityOf,
  locationLabel,
  roomOf,
  type Movement,
} from "@/lib/office-movement"
import { cn } from "@/lib/utils"

/** Back rooms in plan order, west → east (the Operations Room sits in front). */
export const MAP_BACK_ROOMS: Exclude<RoomId, "operations">[] = [
  "meeting",
  "pantry",
  "lounge",
]

/**
 * 2D plan of the single-floor office: the three back rooms in a row above
 * the Operations Room, like the 3D layout seen from above. It's the fallback
 * when WebGL is unavailable or fails, and an optional lightweight view.
 * Fully operable without three.js: one button per workstation.
 */
export function OfficeMap({
  statuses,
  movement,
  selectedId,
  onSelect,
  notice,
}: {
  statuses: Record<OfficeEmployeeId, EmployeeStatus>
  /** Where people are; desks stay listed in the Operations Room. */
  movement?: Record<OfficeEmployeeId, Movement>
  selectedId: OfficeEmployeeId | null
  onSelect: (id: OfficeEmployeeId) => void
  notice?: string
}) {
  const away = (room: RoomId) =>
    movement
      ? officeEmployees.filter(
          (e) =>
            activityOf(movement[e.id]) !== "at-desk" &&
            roomOf(movement[e.id]) === room,
        )
      : []

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4 pt-14 pb-6 sm:p-6 sm:pt-14">
      {notice ? (
        <p className="flex items-start gap-2 rounded-lg bg-surface/90 p-3 text-sm ring-1 ring-border">
          <Info
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-primary"
          />
          {notice}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-[6fr_5.5fr_6.5fr]">
        {MAP_BACK_ROOMS.map((room) => (
          <RoomSection key={room} room={room} people={away(room)} />
        ))}
      </div>

      <section
        aria-labelledby="map-room-operations"
        className="rounded-2xl border border-dashed border-border bg-surface/40 p-3"
      >
        <RoomHeading room="operations" />
        <ul className="grid gap-2 sm:grid-cols-4">
          {officeEmployees.map((employee) => {
            const selected = employee.id === selectedId
            const m = movement?.[employee.id]
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
                    <EmployeeAvatar employee={employee} className="size-8" />
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
                  {m && activityOf(m) !== "at-desk" ? (
                    <span className="text-xs text-muted-foreground">
                      {locationLabel(m)}
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}

function RoomHeading({ room }: { room: RoomId }) {
  return (
    <h3 id={`map-room-${room}`} className="mb-2 text-sm font-semibold">
      {ROOMS[room].name}{" "}
      <span className="font-normal text-muted-foreground">
        · {ROOMS[room].description}
      </span>
    </h3>
  )
}

function RoomSection({
  room,
  people,
}: {
  room: RoomId
  people: typeof officeEmployees
}) {
  return (
    <section
      aria-labelledby={`map-room-${room}`}
      className="rounded-2xl border border-dashed border-border bg-surface/40 p-3"
    >
      <RoomHeading room={room} />
      <p className="text-xs text-muted-foreground">
        {people.length === 0
          ? "Nobody here right now."
          : `Here now: ${people.map((p) => p.name).join(", ")}`}
      </p>
    </section>
  )
}
