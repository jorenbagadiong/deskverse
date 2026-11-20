/**
 * Physical movement of employees, independent of their task status.
 * "idle" is a task status; "walking to the pantry" is a movement. Changing one
 * never overwrites the other (the reducer only links them in one rule: an
 * employee given a working task walks back to their desk).
 *
 * Pure functions over plain data, unit-tested in tests/movement.test.ts.
 */
import type { EmployeeStatus } from "@/config/employee-status"
import {
  roomAt,
  ROOMS,
  type OfficeEmployeeId,
  type RoomId,
} from "@/config/office"

import {
  DESTINATION_LABEL,
  deskNode,
  getNode,
  planRoute,
  spotsFor,
  type DestinationKind,
  type NavStart,
  type Route,
  type Vec3,
} from "./office-navigation"

export type Movement =
  /** Standing or sitting at a graph node (desk, pantry spot, seat, corridor). */
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
  | "at-desk"
  | "walking"
  | "coffee-break"
  | "resting"
  | "gaming"
  | "meeting"
  | "standing"

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
  if (spot === "gaming") return "gaming"
  if (spot === "meeting") return "meeting"
  return "standing"
}

export const ACTIVITY_LABEL: Record<Activity, string> = {
  "at-desk": "At workstation",
  walking: "Walking",
  "coffee-break": "Coffee break",
  resting: "Resting",
  gaming: "At a gaming station",
  meeting: "In the meeting room",
  standing: "Standing",
}

/** Room for a point, with the corridor counted as part of the Operations Room. */
const roomName = (x: number, z: number) => {
  const room = roomAt(x, z)
  return room ? ROOMS[room].name : "Office"
}

/** Human-readable location, e.g. "Walking to the pantry" or "Pantry · counter". */
export function locationLabel(m: Movement): string {
  if (m.kind === "walking")
    return `Walking to the ${DESTINATION_LABEL[m.destination]}`
  if (m.kind === "stopped")
    return `Stopped · ${roomName(m.point[0], m.point[2])}`
  const node = getNode(m.node)
  switch (node.spot) {
    case "desk":
      return "At workstation · Operations Room"
    case "pantry":
      return "Pantry · coffee counter"
    case "lounge":
      return "Gaming & Rest Lounge · sofa"
    case "gaming":
      return "Gaming & Rest Lounge · gaming station"
    case "meeting":
      return "Meeting Room · conference table"
    default:
      return roomName(node.x, node.z)
  }
}

/**
 * Room the employee is in, as far as the reducer knows (a walker counts as
 * being where they set off from; the scene's live position is more precise).
 */
export function roomOf(m: Movement): RoomId | null {
  if (m.kind === "at") {
    const node = getNode(m.node)
    return roomAt(node.x, node.z)
  }
  if (m.kind === "stopped") return roomAt(m.point[0], m.point[2])
  const p = m.route.points[0]
  return roomAt(p.x, p.z)
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

/** Places away from the desk, in the order the controls list them. */
export const AWAY_DESTINATIONS = [
  "pantry",
  "lounge",
  "gaming",
  "meeting",
] as const

const AWAY_LABEL: Record<(typeof AWAY_DESTINATIONS)[number], string> = {
  pantry: "Visit the pantry",
  lounge: "Rest in the lounge",
  gaming: "Go to a gaming station",
  meeting: "Go to the meeting room",
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

  for (const kind of AWAY_DESTINATIONS) {
    const label = AWAY_LABEL[kind]
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
  if (spot === "gaming") return `${name} sat down at a gaming station.`
  if (spot === "meeting") return `${name} took a seat in the meeting room.`
  if (spot === "desk") return `${name} is back at their workstation.`
  return `${name} stopped.`
}
