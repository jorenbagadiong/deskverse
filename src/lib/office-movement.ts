/**
 * Physical movement of employees, independent of their task status.
 * "idle" is a task status; "walking to the pantry" is a movement. Changing one
 * never overwrites the other (the reducer only links them in one rule: an
 * employee given a working task walks back to their desk).
 *
 * Pure functions over plain data, unit-tested in tests/movement.test.ts.
 */
import type { EmployeeStatus } from "@/config/employee-status"
import type { FloorId, OfficeEmployeeId } from "@/config/office"

import {
  DESTINATION_LABEL,
  deskNode,
  floorOfHeight,
  getNode,
  planRoute,
  spotsFor,
  type DestinationKind,
  type NavStart,
  type Route,
  type Vec3,
} from "./office-navigation"

export type Movement =
  /** Standing or sitting at a graph node (desk, pantry spot, lounge seat, corridor). */
  | { kind: "at"; node: string; since: number }
  | {
      kind: "walking"
      routeId: number
      route: Route
      destination: DestinationKind
      /** Node the route ends at (the reserved desk, spot or seat). */
      target: string
    }
  /** Stopped mid-corridor by the user. */
  | { kind: "stopped"; point: Vec3; edge: readonly [string, string] }

/** What the body is doing (drives the 3D pose); separate from task status. */
export type Activity =
  "at-desk" | "walking" | "coffee-break" | "resting" | "standing"

/** Where a walking employee actually is, read from the scene at dispatch time. */
export type LiveLocation = {
  point: Vec3
  node: string | null
  edge: readonly [string, string] | null
}

export function activityOf(m: Movement): Activity {
  if (m.kind === "walking") return "walking"
  if (m.kind === "stopped") return "standing"
  const spot = getNode(m.node).spot
  if (spot === "desk") return "at-desk"
  if (spot === "pantry") return "coffee-break"
  if (spot === "lounge") return "resting"
  return "standing"
}

export const ACTIVITY_LABEL: Record<Activity, string> = {
  "at-desk": "At workstation",
  walking: "Walking",
  "coffee-break": "Coffee break",
  resting: "Resting",
  standing: "Standing",
}

/** Human-readable location, e.g. "Walking to the pantry" or "Lounge · Floor 2". */
export function locationLabel(m: Movement): string {
  if (m.kind === "walking")
    return `Walking to the ${DESTINATION_LABEL[m.destination]}`
  if (m.kind === "stopped")
    return `Stopped · Floor ${floorOfHeight(m.point[1])}`
  const node = getNode(m.node)
  if (node.spot === "desk") return `At workstation · Floor ${node.floor}`
  if (node.spot === "pantry") return "Pantry · Floor 1"
  if (node.spot === "lounge") return "Lounge · Floor 2"
  return `Floor ${node.floor}`
}

/** Floor the employee is on, as far as the reducer knows. */
export function floorOf(m: Movement): FloorId {
  if (m.kind === "at") return getNode(m.node).floor
  if (m.kind === "stopped") return floorOfHeight(m.point[1])
  return floorOfHeight(m.route.points[0].y)
}

export const isAtDesk = (m: Movement, id: OfficeEmployeeId) =>
  m.kind === "at" && m.node === deskNode(id)

export const isHeadingTo = (m: Movement, kind: DestinationKind) =>
  m.kind === "walking" && m.destination === kind

/** Where a new route should start from. */
export function startOf(m: Movement, live?: LiveLocation): NavStart {
  if (m.kind === "at") return { kind: "node", node: m.node }
  if (m.kind === "stopped")
    return { kind: "point", point: m.point, edge: m.edge }
  if (live?.node) return { kind: "node", node: live.node }
  if (live?.edge) return { kind: "point", point: live.point, edge: live.edge }
  // Without a live reading, fall back to the walk's starting node.
  const first = m.route.points[0]
  if (first.node) return { kind: "node", node: first.node }
  if (first.edge)
    return {
      kind: "point",
      point: [first.x, first.y, first.z],
      edge: first.edge,
    }
  return { kind: "node", node: m.target }
}

/** Node someone currently occupies or has reserved. */
export function claimedNode(m: Movement): string | null {
  if (m.kind === "at") return m.node
  if (m.kind === "walking") return m.target
  return null
}

/** First free spot of a kind (desks are personal; break spots are shared). */
export function freeSpot(
  kind: DestinationKind,
  id: OfficeEmployeeId,
  movement: Record<OfficeEmployeeId, Movement>,
): string | null {
  const spots = spotsFor(kind, id)
  const mine = claimedNode(movement[id])
  if (mine && spots.includes(mine)) return mine
  const taken = new Set(
    Object.entries(movement)
      .filter(([other]) => other !== id)
      .map(([, m]) => claimedNode(m))
      .filter(Boolean),
  )
  return spots.find((s) => !taken.has(s)) ?? null
}

export type DestinationOption = {
  kind: DestinationKind | "stop"
  label: string
  enabled: boolean
  /** Why it is disabled (also used as the accessible description). */
  reason?: string
}

/** Movement actions available for an employee right now. */
export function movementOptions(
  id: OfficeEmployeeId,
  status: EmployeeStatus,
  movement: Record<OfficeEmployeeId, Movement>,
): DestinationOption[] {
  const m = movement[id]
  const options: DestinationOption[] = []

  const atDesk = isAtDesk(m, id) || isHeadingTo(m, "desk")
  options.push({
    kind: "desk",
    label: "Return to workstation",
    enabled: !atDesk,
    reason: atDesk
      ? isHeadingTo(m, "desk")
        ? "Already on the way"
        : "Already at the workstation"
      : undefined,
  })

  for (const kind of ["pantry", "lounge"] as const) {
    const label = kind === "pantry" ? "Visit the pantry" : "Rest in the lounge"
    const here =
      (m.kind === "at" && getNode(m.node).spot === kind) || isHeadingTo(m, kind)
    let reason: string | undefined
    if (status === "working")
      reason = "Busy with a task: finish or pause it first"
    else if (here)
      reason = m.kind === "walking" ? "Already on the way" : "Already there"
    else if (!freeSpot(kind, id, movement)) reason = "All spots are taken"
    else if (!planRoute(startOf(m), freeSpot(kind, id, movement)!))
      reason = "Not reachable from here"
    options.push({ kind, label, enabled: !reason, reason })
  }

  options.push({
    kind: "stop",
    label: "Stop",
    enabled: m.kind === "walking",
    reason: m.kind === "walking" ? undefined : "Not walking",
  })
  return options
}

export function arrivalMessage(name: string, node: string): string {
  const spot = getNode(node).spot
  if (spot === "pantry")
    return `${name} is taking a coffee break in the pantry.`
  if (spot === "lounge") return `${name} is resting in the lounge.`
  if (spot === "desk") return `${name} is back at their workstation.`
  return `${name} stopped.`
}
