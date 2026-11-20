/**
 * Walkable navigation for Deskverse HQ: a small waypoint graph per floor,
 * joined by the staircase, plus the furniture footprints it routes around.
 *
 * Pure data and functions (no three.js, no React), so routes are
 * deterministic and unit-tested (tests/navigation.test.ts). The 3D scene only
 * samples `positionAt(route, distance)` each frame.
 *
 * Coordinates are world units: x ∈ [-7, 7], z ∈ [-5, 5]; y is height
 * (0 on Floor 1, FLOOR_HEIGHT on Floor 2, in between on the stairs).
 */
import {
  DESK_STAND_OFFSET_Z,
  FLOOR_HEIGHT,
  officeEmployees,
  type FloorId,
  type OfficeEmployeeId,
} from "@/config/office"

export type Vec3 = readonly [number, number, number]

export type NavNode = {
  id: string
  floor: FloorId
  x: number
  y: number
  z: number
  /** Facing when standing here (radians; 0 faces +z, the camera side). */
  heading?: number
  /** Seats and counter spots: the last step may enter furniture to sit or lean. */
  spot?: "desk" | "pantry" | "lounge"
}

export type DestinationKind = "desk" | "pantry" | "lounge"

/** Collision radius used to check that every corridor clears the furniture. */
export const WALKER_RADIUS = 0.25
export const WALK_SPEED = 1.25 // units per second on flat floor
export const STAIR_SPEED = 0.85 // along the stair slope

const Y2 = FLOOR_HEIGHT
const n = (
  id: string,
  floor: FloorId,
  x: number,
  z: number,
  extra: Partial<NavNode> = {},
): NavNode => ({
  id,
  floor,
  x,
  y: floor === 1 ? 0 : Y2,
  z,
  ...extra,
})

// ── Desk stand points (behind each desk, facing the room) ─────────────────────
const deskNodes = officeEmployees.map((e) =>
  n(`desk:${e.id}`, e.floor, e.desk[0], e.desk[1] + DESK_STAND_OFFSET_Z, {
    heading: 0,
    spot: "desk",
  }),
)
/** Aisle point behind each desk (where the employee steps back to leave). */
const deskAisleZ: Record<FloorId, number> = { 1: -0.15, 2: -3.65 }
const deskAisles = officeEmployees.map((e) =>
  n(`aisle:${e.id}`, e.floor, e.desk[0], deskAisleZ[e.floor]),
)

export const PANTRY_SPOTS = ["pantry:1", "pantry:2", "pantry:3"] as const
export const LOUNGE_SPOTS = ["lounge:1", "lounge:2", "lounge:3"] as const

export const NAV_NODES: NavNode[] = [
  ...deskNodes,
  ...deskAisles,
  // Floor 1: aisle behind the desks, passages between desks, front hallway
  n("f1:aisle-west", 1, -5.5, -0.15),
  n("f1:pass-1", 1, -2.73, -0.15),
  n("f1:pass-2", 1, 0.43, -0.15),
  n("f1:pass-3", 1, 3.58, -0.15),
  n("f1:front-west", 1, -5.4, 2.5),
  n("f1:front-1", 1, -2.73, 2.5),
  n("f1:front-2", 1, 0.43, 2.5),
  n("f1:front-3", 1, 3.58, 2.5),
  n("f1:stair-approach", 1, -5.5, 4.85),
  n("f1:stair-foot", 1, -6.35, 4.85),
  // Pantry (under the mezzanine, back right)
  n("f1:pantry-hub", 1, 4.6, -2.6),
  n("pantry:1", 1, 4.1, -3.55, { heading: Math.PI, spot: "pantry" }),
  n("pantry:2", 1, 5.3, -3.55, { heading: Math.PI, spot: "pantry" }),
  n("pantry:3", 1, 5.4, -2.5, { heading: Math.PI / 2, spot: "pantry" }),
  // Staircase (along the left wall)
  { id: "stairs:bottom", floor: 1, x: -6.35, y: 0, z: 4.6 },
  { id: "stairs:top", floor: 2, x: -6.35, y: Y2, z: -0.5 },
  // Floor 2: landing, front aisle along the railing, passages, back aisle
  n("f2:landing", 2, -6.35, -1.05),
  n("f2:front-west", 2, -5.0, -1.15),
  n("f2:front-1", 2, -1.6, -1.15),
  n("f2:front-2", 2, 1.9, -1.15),
  n("f2:front-east", 2, 5.8, -1.15),
  n("f2:back-west", 2, -5.0, -3.65),
  n("f2:back-1", 2, -1.6, -3.65),
  n("f2:back-2", 2, 1.9, -3.65),
  // Lounge (east end of the mezzanine): approach points and seats
  n("f2:seat-2-approach", 2, 5.8, -1.35),
  n("f2:seat-1-approach", 2, 5.8, -1.95),
  n("f2:seat-3-approach", 2, 5.8, -3.3),
  n("lounge:1", 2, 6.25, -1.95, { heading: -Math.PI / 2, spot: "lounge" }),
  n("lounge:2", 2, 6.25, -1.35, { heading: -Math.PI / 2, spot: "lounge" }),
  n("lounge:3", 2, 6.3, -3.3, { heading: -Math.PI / 2, spot: "lounge" }),
]

/** Undirected corridors. Every flat edge is checked against OBSTACLES in tests. */
export const NAV_EDGES: [string, string][] = [
  ...officeEmployees.map(
    (e) => [`desk:${e.id}`, `aisle:${e.id}`] as [string, string],
  ),
  // Floor 1 aisle chain, west → east
  ["f1:aisle-west", "aisle:scout"],
  ["aisle:scout", "f1:pass-1"],
  ["f1:pass-1", "aisle:quill"],
  ["aisle:quill", "f1:pass-2"],
  ["f1:pass-2", "aisle:pixel"],
  ["aisle:pixel", "f1:pass-3"],
  ["f1:pass-3", "aisle:vera"],
  // Passages to the front hallway
  ["f1:pass-1", "f1:front-1"],
  ["f1:pass-2", "f1:front-2"],
  ["f1:pass-3", "f1:front-3"],
  ["f1:aisle-west", "f1:front-west"],
  ["f1:front-west", "f1:front-1"],
  ["f1:front-1", "f1:front-2"],
  ["f1:front-2", "f1:front-3"],
  // To the stairs
  ["f1:front-west", "f1:stair-approach"],
  ["f1:stair-approach", "f1:stair-foot"],
  ["f1:stair-foot", "stairs:bottom"],
  ["stairs:bottom", "stairs:top"],
  ["stairs:top", "f2:landing"],
  // Pantry
  ["aisle:vera", "f1:pantry-hub"],
  ["f1:pantry-hub", "pantry:1"],
  ["f1:pantry-hub", "pantry:2"],
  ["f1:pantry-hub", "pantry:3"],
  // Floor 2
  ["f2:landing", "f2:front-west"],
  ["f2:front-west", "f2:front-1"],
  ["f2:front-1", "f2:front-2"],
  ["f2:front-2", "f2:front-east"],
  ["f2:front-west", "f2:back-west"],
  ["f2:front-1", "f2:back-1"],
  ["f2:front-2", "f2:back-2"],
  ["f2:back-west", "aisle:tempo"],
  ["aisle:tempo", "f2:back-1"],
  ["f2:back-1", "aisle:relay"],
  ["aisle:relay", "f2:back-2"],
  ["f2:back-2", "aisle:ledger"],
  ["aisle:ledger", "f2:seat-3-approach"],
  // Lounge
  ["f2:front-east", "f2:seat-2-approach"],
  ["f2:seat-2-approach", "f2:seat-1-approach"],
  ["f2:seat-1-approach", "f2:seat-3-approach"],
  ["f2:seat-1-approach", "lounge:1"],
  ["f2:seat-2-approach", "lounge:2"],
  ["f2:seat-3-approach", "lounge:3"],
]

export type Obstacle =
  | {
      floor: FloorId
      kind: "rect"
      name: string
      x0: number
      x1: number
      z0: number
      z1: number
    }
  | {
      floor: FloorId
      kind: "circle"
      name: string
      x: number
      z: number
      r: number
    }

const rect = (
  floor: FloorId,
  name: string,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
): Obstacle => ({
  floor,
  kind: "rect",
  name,
  x0,
  x1,
  z0,
  z1,
})
const circle = (
  floor: FloorId,
  name: string,
  x: number,
  z: number,
  r: number,
): Obstacle => ({
  floor,
  kind: "circle",
  name,
  x,
  z,
  r,
})

/** Furniture footprints (from building.tsx / furniture.tsx / workstation.tsx). */
export const OBSTACLES: Obstacle[] = [
  ...officeEmployees.map((e) =>
    rect(
      e.floor,
      `desk:${e.id}`,
      e.desk[0] - 0.85,
      e.desk[0] + 0.85,
      e.desk[1] - 0.39,
      e.desk[1] + 0.39,
    ),
  ),
  // Floor 1
  circle(1, "column-1", -2.73, -0.7, 0.15),
  circle(1, "column-2", 0.43, -0.7, 0.15),
  circle(1, "column-3", 3.58, -0.7, 0.15),
  rect(1, "meeting-table", -2.9, 0.5, 3.0, 4.6),
  rect(1, "reception", 3.45, 6.05, 3.5, 4.3),
  rect(1, "stairs", -6.9, -5.8, -0.5, 4.6),
  rect(1, "hot-desks", -5.75, -3.45, -4.4, -1.8),
  rect(1, "project-board", -0.6, 2.4, -2.85, -2.35),
  rect(1, "pantry-counter", 3.45, 6.15, -4.75, -4.05),
  rect(1, "pantry-fridge", 6.15, 6.95, -4.75, -4.0),
  circle(1, "pantry-table", 6.1, -2.5, 0.4),
  circle(1, "plant-front", -4.6, 4.55, 0.32),
  circle(1, "plant-front-mid", 2.1, 4.4, 0.28),
  circle(1, "plant-east", 6.45, 2.3, 0.26),
  circle(1, "plant-back", -2.0, -4.45, 0.3),
  // Floor 2
  circle(2, "transmitter", 1.32, -2.75, 0.1),
  rect(2, "lounge-sofa", 6.07, 6.75, -2.4, -0.9),
  rect(2, "lounge-chair", 6.05, 6.75, -3.65, -2.95),
  circle(2, "lounge-table", 5.15, -1.8, 0.3),
  circle(2, "plant-east", 6.45, -4.45, 0.3),
  circle(2, "plant-west", -6.45, -4.45, 0.3),
  circle(2, "plant-mid", 1.95, -4.5, 0.25),
  // The railing along the mezzanine edge (except the stair opening)
  rect(2, "railing", -5.75, 7, -0.55, -0.4),
]

/** Walkable bounds per floor (inside walls, railings and floor edges). */
export const FLOOR_BOUNDS: Record<
  FloorId,
  { x0: number; x1: number; z0: number; z1: number }
> = {
  1: { x0: -6.9, x1: 6.9, z0: -4.9, z1: 4.95 },
  2: { x0: -6.9, x1: 6.9, z0: -4.9, z1: -0.55 },
}

// ── Graph ─────────────────────────────────────────────────────────────────────

const nodeIndex = new Map(NAV_NODES.map((node) => [node.id, node]))
const adjacency = new Map<string, string[]>()
for (const [a, b] of NAV_EDGES) {
  adjacency.set(a, [...(adjacency.get(a) ?? []), b])
  adjacency.set(b, [...(adjacency.get(b) ?? []), a])
}

export function getNode(id: string): NavNode {
  const node = nodeIndex.get(id)
  if (!node) throw new Error(`Unknown nav node "${id}"`)
  return node
}

export const point = (node: NavNode): Vec3 => [node.x, node.y, node.z]
export const distance = (a: Vec3, b: Vec3) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const nodeDistance = (a: string, b: string) =>
  distance(point(getNode(a)), point(getNode(b)))

/** Shortest node path (Dijkstra). Returns null when unreachable. */
export function shortestPath(from: string, to: string): string[] | null {
  if (!nodeIndex.has(from) || !nodeIndex.has(to)) return null
  const dist = new Map<string, number>([[from, 0]])
  const prev = new Map<string, string>()
  const open = new Set([from])
  while (open.size) {
    let current = ""
    let best = Infinity
    for (const id of open) {
      const d = dist.get(id) ?? Infinity
      if (d < best) {
        best = d
        current = id
      }
    }
    if (current === to) break
    open.delete(current)
    for (const next of adjacency.get(current) ?? []) {
      const d = best + nodeDistance(current, next)
      if (d < (dist.get(next) ?? Infinity)) {
        dist.set(next, d)
        prev.set(next, current)
        open.add(next)
      }
    }
  }
  if (!dist.has(to)) return null
  const path = [to]
  while (path[0] !== from) path.unshift(prev.get(path[0])!)
  return path
}

export const pathLength = (path: string[]) =>
  path.slice(1).reduce((sum, id, i) => sum + nodeDistance(path[i], id), 0)

// ── Routes ────────────────────────────────────────────────────────────────────

export type RoutePoint = {
  x: number
  y: number
  z: number
  /** Graph node at this point, if any. */
  node?: string
  /** For a free start point (an interrupted walk): the corridor it lies on. */
  edge?: readonly [string, string]
}

export type Route = { points: RoutePoint[]; lengths: number[]; total: number }

/** Where someone is when a new route is planned. */
export type NavStart =
  | { kind: "node"; node: string }
  | { kind: "point"; point: Vec3; edge: readonly [string, string] }

export function makeRoute(points: RoutePoint[]): Route {
  const lengths = [0]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    lengths.push(lengths[i - 1] + distance([a.x, a.y, a.z], [b.x, b.y, b.z]))
  }
  return { points, lengths, total: lengths[lengths.length - 1] }
}

const toPoint = (id: string): RoutePoint => {
  const node = getNode(id)
  return { x: node.x, y: node.y, z: node.z, node: id }
}

/** Plans a walking route from a node or an interrupted mid-corridor point. */
export function planRoute(start: NavStart, to: string): Route | null {
  if (start.kind === "node") {
    const path = shortestPath(start.node, to)
    return path ? makeRoute(path.map(toPoint)) : null
  }
  // Mid-corridor: continue via whichever end of the corridor is shorter.
  let best: Route | null = null
  for (const end of start.edge) {
    const path = shortestPath(end, to)
    if (!path) continue
    const startPoint: RoutePoint = {
      x: start.point[0],
      y: start.point[1],
      z: start.point[2],
      edge: start.edge,
    }
    const route = makeRoute([startPoint, ...path.map(toPoint)])
    if (!best || route.total < best.total) best = route
  }
  return best
}

export type RouteSample = {
  position: Vec3
  /** Direction of travel (radians; 0 faces +z). */
  heading: number
  /** Index of the segment being walked (between points i and i+1). */
  segment: number
  /** On the staircase segment. */
  onStairs: boolean
  done: boolean
}

/** Deterministic position after walking `d` units along the route. */
export function positionAt(route: Route, d: number): RouteSample {
  const { points, lengths, total } = route
  if (points.length === 1) {
    const p = points[0]
    return {
      position: [p.x, p.y, p.z],
      heading: 0,
      segment: 0,
      onStairs: false,
      done: true,
    }
  }
  const clamped = Math.max(0, Math.min(d, total))
  let i = 0
  while (i < points.length - 2 && lengths[i + 1] < clamped) i++
  const a = points[i]
  const b = points[i + 1]
  const span = lengths[i + 1] - lengths[i] || 1
  const k = (clamped - lengths[i]) / span
  const dx = b.x - a.x
  const dz = b.z - a.z
  return {
    position: [a.x + dx * k, a.y + (b.y - a.y) * k, a.z + dz * k],
    heading: dx === 0 && dz === 0 ? 0 : Math.atan2(dx, dz),
    segment: i,
    onStairs: isStairSegment(a, b),
    done: clamped >= total,
  }
}

export const isStairSegment = (a: RoutePoint, b: RoutePoint) =>
  Math.abs(b.y - a.y) > 0.5

/** Corridor (pair of nodes) that a route segment lies on, for interruptions. */
export function segmentEdge(
  route: Route,
  segment: number,
): readonly [string, string] | null {
  const a = route.points[segment]
  const b = route.points[segment + 1]
  if (!a || !b) return null
  if (a.node && b.node) return [a.node, b.node]
  if (a.edge) return a.edge
  return null
}

/** Walking time for a route (stairs are slower). */
export function routeDuration(route: Route) {
  let t = 0
  for (let i = 1; i < route.points.length; i++) {
    const len = route.lengths[i] - route.lengths[i - 1]
    t +=
      len /
      (isStairSegment(route.points[i - 1], route.points[i])
        ? STAIR_SPEED
        : WALK_SPEED)
  }
  return t
}

/** Walking speed on a given segment. */
export const speedFor = (route: Route, segment: number) =>
  isStairSegment(
    route.points[segment],
    route.points[segment + 1] ?? route.points[segment],
  )
    ? STAIR_SPEED
    : WALK_SPEED

export const floorOfHeight = (y: number): FloorId =>
  y >= FLOOR_HEIGHT - 0.05 ? 2 : 1

export const deskNode = (id: OfficeEmployeeId) => `desk:${id}`

export function spotsFor(
  kind: DestinationKind,
  id: OfficeEmployeeId,
): readonly string[] {
  if (kind === "desk") return [deskNode(id)]
  return kind === "pantry" ? PANTRY_SPOTS : LOUNGE_SPOTS
}

export const DESTINATION_LABEL: Record<DestinationKind, string> = {
  desk: "workstation",
  pantry: "pantry",
  lounge: "lounge",
}

export const DESTINATION_FLOOR: Record<
  Exclude<DestinationKind, "desk">,
  FloorId
> = {
  pantry: 1,
  lounge: 2,
}
