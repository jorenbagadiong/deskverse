/**
 * Walkable navigation for Deskverse HQ: one floor, four rooms, a hand-placed
 * waypoint graph and the furniture and partition footprints it routes around.
 *
 * Pure data and functions (no three.js, no React), so routes are
 * deterministic and unit-tested (tests/navigation.test.ts). The 3D scene only
 * samples `positionAt(route, distance)` each frame.
 *
 * Coordinates are world units on the ground plane: x ∈ [-9, 9], z ∈ [-6.5, 6.5],
 * y = 0 everywhere (Vec3 keeps a y so positions plug straight into three.js).
 *
 * Layout (top view, +z toward the default camera):
 *
 *   z -6.5 ┌──────────────┬────────────┬───────────────┐
 *          │ Meeting Room │   Pantry   │ Gaming & Rest │
 *          │  (8 seats)   │ (3 spots)  │ Lounge (3+3)  │
 *   z -2.2 ├────door──────┴───door─────┴────door───────┤  glass partitions
 *          │  corridor z = -1.3                        │
 *          │  desks row 1: Scout Quill Pixel Vera      │  Operations Room
 *          │  aisle z = 2.3                            │
 *          │  desks row 2:   Tempo Relay Ledger        │
 *   z  6.5 └───────────────────────────────────────────┘
 *        x -9                                         9
 */
import {
  BACK_ROOMS_Z,
  DESK_STAND_OFFSET_Z,
  OFFICE_BOUNDS,
  officeEmployees,
  type OfficeEmployeeId,
  type RoomId,
} from "@/config/office"

export type Vec3 = readonly [number, number, number]

export type SpotKind = "desk" | "pantry" | "lounge" | "gaming" | "meeting"

export type NavNode = {
  id: string
  x: number
  y: number
  z: number
  /** Facing when standing or sitting here (radians; 0 faces +z, the camera side). */
  heading?: number
  /** Desks, counter spots and seats: the last step may enter that furniture. */
  spot?: SpotKind
}

export type DestinationKind = SpotKind

/** Collision radius used to check that every corridor clears the furniture. */
export const WALKER_RADIUS = 0.25
export const WALK_SPEED = 1.25 // units per second

const n = (
  id: string,
  x: number,
  z: number,
  extra: Partial<NavNode> = {},
): NavNode => ({ id, x, y: 0, z, ...extra })

/** A seat node just in front of a chair or sofa cushion, facing like the seat. */
const seat = (
  id: string,
  spot: SpotKind,
  x: number,
  z: number,
  heading: number,
  inset = 0.08,
): NavNode =>
  n(id, x + Math.sin(heading) * inset, z + Math.cos(heading) * inset, {
    heading,
    spot,
  })

// ── Operations Room ───────────────────────────────────────────────────────────
/** Corridor along the back rooms; also the aisle behind desk row 1. */
export const CORRIDOR_Z = -1.3
/** Aisle behind desk row 2. */
export const ROW2_AISLE_Z = 2.3
const aisleZ = (deskZ: number) => (deskZ < 2 ? CORRIDOR_Z : ROW2_AISLE_Z)

const deskNodes = officeEmployees.map((e) =>
  n(`desk:${e.id}`, e.desk[0], e.desk[1] + DESK_STAND_OFFSET_Z, {
    heading: 0,
    spot: "desk",
  }),
)
/** Aisle point behind each desk (where the employee steps back to leave). */
const deskAisles = officeEmployees.map((e) =>
  n(`aisle:${e.id}`, e.desk[0], aisleZ(e.desk[1])),
)

// ── Meeting Room: conference table with eight chairs ──────────────────────────
export const MEETING_TABLE = { x: -6, z: -4.35, width: 2.4, depth: 1.0 }
/** Chair positions and facings (towards the table). */
export const MEETING_CHAIRS: { x: number; z: number; heading: number }[] = [
  ...[-6.85, -6.0, -5.15].map((x) => ({ x, z: -3.4, heading: Math.PI })),
  ...[-6.85, -6.0, -5.15].map((x) => ({ x, z: -5.3, heading: 0 })),
  { x: -7.65, z: -4.35, heading: Math.PI / 2 },
  { x: -4.35, z: -4.35, heading: -Math.PI / 2 },
]
const MEETING_FRONT_Z = -2.75
const MEETING_BACK_Z = -5.95
const MEETING_WEST_X = -8.45
const MEETING_EAST_X = -3.55
/** Where each meeting chair is approached from (on the path around the table). */
const meetingApproach = (i: number): [number, number] => {
  const c = MEETING_CHAIRS[i]
  if (i < 3) return [c.x, MEETING_FRONT_Z]
  if (i < 6) return [c.x, MEETING_BACK_Z]
  return [i === 6 ? MEETING_WEST_X : MEETING_EAST_X, c.z]
}

// ── Gaming & Rest Lounge ──────────────────────────────────────────────────────
/** Gaming chairs (facing the screens on the back wall). */
export const GAMING_CHAIRS = [3.5, 4.9, 6.3].map((x) => ({
  x,
  z: -5.2,
  heading: Math.PI,
}))
const GAMING_AISLE_Z = -4.5
export const LOUNGE_APPROACH_X = 7.75

export const PANTRY_SPOTS = ["pantry:1", "pantry:2", "pantry:3"] as const
export const LOUNGE_SPOTS = ["lounge:1", "lounge:2", "lounge:3"] as const
export const GAMING_SPOTS = ["gaming:1", "gaming:2", "gaming:3"] as const
export const MEETING_SPOTS = MEETING_CHAIRS.map((_, i) => `meeting:${i + 1}`)

export const NAV_NODES: NavNode[] = [
  ...deskNodes,
  ...deskAisles,
  // Corridor (row 1 aisle) and the passages to row 2
  n("ops:corridor-west", -8.3, CORRIDOR_Z),
  n("ops:corridor-1", -4.2, CORRIDOR_Z),
  n("ops:corridor-2", 0, CORRIDOR_Z),
  n("ops:corridor-3", 4.2, CORRIDOR_Z),
  n("ops:corridor-east", 8.3, CORRIDOR_Z),
  n("ops:row2-west", -8.3, ROW2_AISLE_Z),
  n("ops:row2-east", 8.3, ROW2_AISLE_Z),
  // Meeting Room: a path around the table, entered by the door at x = -4.2
  n("meet:front-west", MEETING_WEST_X, MEETING_FRONT_Z),
  n("meet:door", -4.2, MEETING_FRONT_Z),
  n("meet:front-east", MEETING_EAST_X, MEETING_FRONT_Z),
  n("meet:back-west", MEETING_WEST_X, MEETING_BACK_Z),
  n("meet:back-east", MEETING_EAST_X, MEETING_BACK_Z),
  ...MEETING_CHAIRS.map((_, i) => {
    const [x, z] = meetingApproach(i)
    return n(`meet:approach-${i + 1}`, x, z)
  }),
  ...MEETING_CHAIRS.map((c, i) =>
    seat(`meeting:${i + 1}`, "meeting", c.x, c.z, c.heading),
  ),
  // Pantry (door at x = 0): counter spots and the high table
  n("pantry:hub", 0, -4.1),
  n("pantry:1", -0.5, -5.05, { heading: Math.PI, spot: "pantry" }),
  n("pantry:2", 0.7, -5.05, { heading: Math.PI, spot: "pantry" }),
  n("pantry:3", 0.8, -4.0, { heading: Math.PI / 2, spot: "pantry" }),
  // Gaming & Rest Lounge (door at x = 4.2)
  n("lounge:hub", 4.2, -3.3),
  ...GAMING_CHAIRS.map((c, i) =>
    n(`lounge:game-aisle-${i + 1}`, c.x, GAMING_AISLE_Z),
  ),
  ...GAMING_CHAIRS.map((c, i) =>
    seat(`gaming:${i + 1}`, "gaming", c.x, c.z, c.heading),
  ),
  n("lounge:seat-2-approach", LOUNGE_APPROACH_X, -3.35),
  n("lounge:seat-1-approach", LOUNGE_APPROACH_X, -3.95),
  n("lounge:seat-3-approach", LOUNGE_APPROACH_X, -5.3),
  n("lounge:1", 8.25, -3.95, { heading: -Math.PI / 2, spot: "lounge" }),
  n("lounge:2", 8.25, -3.35, { heading: -Math.PI / 2, spot: "lounge" }),
  n("lounge:3", 8.3, -5.3, { heading: -Math.PI / 2, spot: "lounge" }),
]

const chain = (ids: string[]): [string, string][] =>
  ids.slice(1).map((id, i) => [ids[i], id])

/** Undirected corridors. Every edge is checked against OBSTACLES in tests. */
export const NAV_EDGES: [string, string][] = [
  ...officeEmployees.map(
    (e) => [`desk:${e.id}`, `aisle:${e.id}`] as [string, string],
  ),
  // Corridor west → east (row 1 desks open onto it)
  ...chain([
    "ops:corridor-west",
    "aisle:scout",
    "ops:corridor-1",
    "aisle:quill",
    "ops:corridor-2",
    "aisle:pixel",
    "ops:corridor-3",
    "aisle:vera",
    "ops:corridor-east",
  ]),
  // Row 2 aisle west → east
  ...chain([
    "ops:row2-west",
    "aisle:tempo",
    "aisle:relay",
    "aisle:ledger",
    "ops:row2-east",
  ]),
  // Passages between the row 1 desks
  ["ops:corridor-west", "ops:row2-west"],
  ["ops:corridor-1", "aisle:tempo"],
  ["ops:corridor-2", "aisle:relay"],
  ["ops:corridor-3", "aisle:ledger"],
  ["ops:corridor-east", "ops:row2-east"],
  // Meeting Room
  ["ops:corridor-1", "meet:door"],
  ...chain([
    "meet:front-west",
    "meet:approach-1",
    "meet:approach-2",
    "meet:approach-3",
    "meet:door",
    "meet:front-east",
  ]),
  ...chain([
    "meet:back-west",
    "meet:approach-4",
    "meet:approach-5",
    "meet:approach-6",
    "meet:back-east",
  ]),
  ...chain(["meet:front-west", "meet:approach-7", "meet:back-west"]),
  ...chain(["meet:front-east", "meet:approach-8", "meet:back-east"]),
  ...MEETING_CHAIRS.map(
    (_, i) =>
      [`meet:approach-${i + 1}`, `meeting:${i + 1}`] as [string, string],
  ),
  // Pantry
  ["ops:corridor-2", "pantry:hub"],
  ["pantry:hub", "pantry:1"],
  ["pantry:hub", "pantry:2"],
  ["pantry:hub", "pantry:3"],
  // Gaming & Rest Lounge
  ["ops:corridor-3", "lounge:hub"],
  ["lounge:hub", "lounge:game-aisle-2"],
  ...chain([
    "lounge:game-aisle-1",
    "lounge:game-aisle-2",
    "lounge:game-aisle-3",
  ]),
  ...GAMING_CHAIRS.map(
    (_, i) =>
      [`lounge:game-aisle-${i + 1}`, `gaming:${i + 1}`] as [string, string],
  ),
  ["lounge:hub", "lounge:seat-2-approach"],
  ["lounge:seat-2-approach", "lounge:seat-1-approach"],
  ["lounge:seat-1-approach", "lounge:seat-3-approach"],
  ["lounge:seat-1-approach", "lounge:1"],
  ["lounge:seat-2-approach", "lounge:2"],
  ["lounge:seat-3-approach", "lounge:3"],
]

export type Obstacle = {
  name: string
  /** Seat nodes allowed to step into this piece (sitting down on it). */
  seats?: readonly string[]
} & (
  | { kind: "rect"; x0: number; x1: number; z0: number; z1: number }
  | { kind: "circle"; x: number; z: number; r: number }
)

const rect = (
  name: string,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  seats?: readonly string[],
): Obstacle => ({ name, kind: "rect", x0, x1, z0, z1, seats })
const circle = (
  name: string,
  x: number,
  z: number,
  r: number,
  seats?: readonly string[],
): Obstacle => ({ name, kind: "circle", x, z, r, seats })

const WALL_HALF = 0.05
/** Doorways in the back-room partition (x ranges). */
export const DOORWAYS: { room: RoomId; x0: number; x1: number }[] = [
  { room: "meeting", x0: -4.85, x1: -3.55 },
  { room: "pantry", x0: -0.65, x1: 0.65 },
  { room: "lounge", x0: 3.55, x1: 4.85 },
]

/** Glass partitions between the rooms (segments of [x0, z0] → [x1, z1]). */
export const PARTITIONS: { from: [number, number]; to: [number, number] }[] = [
  // Front wall of the back rooms, with the three doorways
  {
    from: [OFFICE_BOUNDS.x0, BACK_ROOMS_Z],
    to: [DOORWAYS[0].x0, BACK_ROOMS_Z],
  },
  { from: [DOORWAYS[0].x1, BACK_ROOMS_Z], to: [DOORWAYS[1].x0, BACK_ROOMS_Z] },
  { from: [DOORWAYS[1].x1, BACK_ROOMS_Z], to: [DOORWAYS[2].x0, BACK_ROOMS_Z] },
  {
    from: [DOORWAYS[2].x1, BACK_ROOMS_Z],
    to: [OFFICE_BOUNDS.x1, BACK_ROOMS_Z],
  },
  // Between Meeting Room | Pantry | Lounge
  { from: [-3, OFFICE_BOUNDS.z0], to: [-3, BACK_ROOMS_Z] },
  { from: [2.5, OFFICE_BOUNDS.z0], to: [2.5, BACK_ROOMS_Z] },
]

const partitionObstacles = PARTITIONS.map(({ from, to }, i) =>
  rect(
    `wall-${i + 1}`,
    Math.min(from[0], to[0]) - WALL_HALF,
    Math.max(from[0], to[0]) + WALL_HALF,
    Math.min(from[1], to[1]) - WALL_HALF,
    Math.max(from[1], to[1]) + WALL_HALF,
  ),
)

/** Furniture footprints (from building.tsx / furniture.tsx / workstation.tsx). */
export const OBSTACLES: Obstacle[] = [
  ...partitionObstacles,
  ...officeEmployees.map((e) =>
    rect(
      `desk:${e.id}`,
      e.desk[0] - 0.85,
      e.desk[0] + 0.85,
      e.desk[1] - 0.39,
      e.desk[1] + 0.39,
    ),
  ),
  // Operations Room
  rect("reception", 5.45, 7.75, 5.4, 6.0),
  circle("plant-front-west", -8.45, 5.95, 0.32),
  circle("plant-front-east", 8.55, 4.6, 0.28),
  // Meeting Room
  rect(
    "meeting-table",
    MEETING_TABLE.x - MEETING_TABLE.width / 2,
    MEETING_TABLE.x + MEETING_TABLE.width / 2,
    MEETING_TABLE.z - MEETING_TABLE.depth / 2,
    MEETING_TABLE.z + MEETING_TABLE.depth / 2,
  ),
  ...MEETING_CHAIRS.map((c, i) =>
    circle(`meeting-chair-${i + 1}`, c.x, c.z, 0.25, [`meeting:${i + 1}`]),
  ),
  // Pantry
  rect("pantry-counter", -1.15, 1.55, -6.25, -5.55),
  rect("pantry-fridge", 1.55, 2.35, -6.25, -5.5),
  circle("pantry-table", 1.5, -4.0, 0.4),
  circle("pantry-stools", 2.05, -4.0, 0.5),
  circle("plant-pantry", -2.5, -6.0, 0.3),
  // Gaming & Rest Lounge
  ...GAMING_CHAIRS.map((c, i) =>
    rect(`gaming-desk-${i + 1}`, c.x - 0.5, c.x + 0.5, -6.3, -5.7),
  ),
  ...GAMING_CHAIRS.map((c, i) =>
    circle(`gaming-chair-${i + 1}`, c.x, c.z, 0.25, [`gaming:${i + 1}`]),
  ),
  rect("lounge-sofa", 8.07, 8.75, -4.4, -2.9, ["lounge:1", "lounge:2"]),
  rect("lounge-chair", 8.05, 8.75, -5.65, -4.95, ["lounge:3"]),
  circle("lounge-table", 7.0, -4.0, 0.3),
  circle("lounge-side-table", 8.5, -4.68, 0.16),
  circle("lounge-lamp", 8.55, -2.78, 0.14),
  circle("plant-lounge-door", 2.95, -2.65, 0.3),
  circle("plant-lounge-back", 8.6, -6.1, 0.3),
]

/** Walkable bounds: inside the back and left walls and the open front/right edges. */
export const WALKABLE_BOUNDS = {
  x0: OFFICE_BOUNDS.x0 + 0.1,
  x1: OFFICE_BOUNDS.x1 - 0.1,
  z0: OFFICE_BOUNDS.z0 + 0.1,
  z1: OFFICE_BOUNDS.z1 - 0.1,
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
    done: clamped >= total,
  }
}

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

/** Walking time for a route (one floor, one speed). */
export const routeDuration = (route: Route) => route.total / WALK_SPEED

export const deskNode = (id: OfficeEmployeeId) => `desk:${id}`

export function spotsFor(
  kind: DestinationKind,
  id: OfficeEmployeeId,
): readonly string[] {
  switch (kind) {
    case "desk":
      return [deskNode(id)]
    case "pantry":
      return PANTRY_SPOTS
    case "lounge":
      return LOUNGE_SPOTS
    case "gaming":
      return GAMING_SPOTS
    case "meeting":
      return MEETING_SPOTS
  }
}

export const DESTINATION_LABEL: Record<DestinationKind, string> = {
  desk: "workstation",
  pantry: "pantry",
  lounge: "lounge",
  gaming: "gaming stations",
  meeting: "meeting room",
}

/** The room each kind of destination is in. */
export const DESTINATION_ROOM: Record<DestinationKind, RoomId> = {
  desk: "operations",
  pantry: "pantry",
  lounge: "lounge",
  gaming: "lounge",
  meeting: "meeting",
}
