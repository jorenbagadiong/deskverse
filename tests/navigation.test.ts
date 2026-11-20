import { describe, expect, it } from "vitest"

import { officeEmployees, ROOMS, roomAt, type RoomId } from "@/config/office"
import {
  DESTINATION_ROOM,
  DOORWAYS,
  GAMING_SPOTS,
  getNode,
  LOUNGE_SPOTS,
  MEETING_SPOTS,
  NAV_EDGES,
  NAV_NODES,
  OBSTACLES,
  PANTRY_SPOTS,
  planRoute,
  positionAt,
  routeDuration,
  segmentEdge,
  shortestPath,
  spotsFor,
  WALKABLE_BOUNDS,
  WALKER_RADIUS,
  type DestinationKind,
  type NavNode,
  type Obstacle,
} from "@/lib/office-navigation"

/** Distance from point p to segment ab (2D, x/z). */
function segPointDistance(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  px: number,
  pz: number,
) {
  const dx = bx - ax
  const dz = bz - az
  const len2 = dx * dx + dz * dz
  const t =
    len2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2))
  return Math.hypot(ax + dx * t - px, az + dz * t - pz)
}

/** Clearance between segment ab and an obstacle (negative = overlap). */
function clearance(a: NavNode, b: NavNode, o: Obstacle) {
  if (o.kind === "circle")
    return segPointDistance(a.x, a.z, b.x, b.z, o.x, o.z) - o.r
  // Rect: sample the segment densely and take the min distance to the rect.
  let min = Infinity
  for (let i = 0; i <= 200; i++) {
    const t = i / 200
    const x = a.x + (b.x - a.x) * t
    const z = a.z + (b.z - a.z) * t
    const dx = Math.max(o.x0 - x, 0, x - o.x1)
    const dz = Math.max(o.z0 - z, 0, z - o.z1)
    const inside = x > o.x0 && x < o.x1 && z > o.z0 && z < o.z1
    min = Math.min(
      min,
      inside
        ? -Math.min(x - o.x0, o.x1 - x, z - o.z0, o.z1 - z)
        : Math.hypot(dx, dz),
    )
  }
  return min
}

const DESKS = officeEmployees.map((e) => `desk:${e.id}`)
const ALL_SPOTS = [
  ...DESKS,
  ...PANTRY_SPOTS,
  ...LOUNGE_SPOTS,
  ...GAMING_SPOTS,
  ...MEETING_SPOTS,
]

describe("single-floor navigation graph", () => {
  it("has unique node ids and only references existing nodes", () => {
    const ids = NAV_NODES.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const [a, b] of NAV_EDGES) {
      expect(() => getNode(a)).not.toThrow()
      expect(() => getNode(b)).not.toThrow()
    }
  })

  it("puts every node on the one floor, inside the walkable bounds", () => {
    for (const node of NAV_NODES) {
      expect(node.y, node.id).toBe(0)
      expect(node.x, node.id).toBeGreaterThanOrEqual(WALKABLE_BOUNDS.x0)
      expect(node.x, node.id).toBeLessThanOrEqual(WALKABLE_BOUNDS.x1)
      expect(node.z, node.id).toBeGreaterThanOrEqual(WALKABLE_BOUNDS.z0)
      expect(node.z, node.id).toBeLessThanOrEqual(WALKABLE_BOUNDS.z1)
    }
  })

  it("has no stairs or level changes left", () => {
    expect(NAV_NODES.some((n) => /stair|landing|f[12]:/.test(n.id))).toBe(false)
  })

  it("places every desk in the Operations Room and every spot in its room", () => {
    const expected: [readonly string[], RoomId][] = [
      [DESKS, "operations"],
      [PANTRY_SPOTS, "pantry"],
      [LOUNGE_SPOTS, "lounge"],
      [GAMING_SPOTS, "lounge"],
      [MEETING_SPOTS, "meeting"],
    ]
    for (const [ids, room] of expected)
      for (const id of ids) {
        const node = getNode(id)
        expect(roomAt(node.x, node.z), id).toBe(room)
      }
  })

  it("seats the whole team in the Meeting Room", () => {
    expect(MEETING_SPOTS.length).toBeGreaterThanOrEqual(officeEmployees.length)
  })

  it("every corridor clears all furniture and walls by the walker radius", () => {
    const problems: string[] = []
    for (const [ia, ib] of NAV_EDGES) {
      const a = getNode(ia)
      const b = getNode(ib)
      for (const o of OBSTACLES) {
        // Sitting down: the last step onto a seat may enter that seat.
        if (o.seats?.includes(ia) || o.seats?.includes(ib)) continue
        const c = clearance(a, b, o)
        if (c < WALKER_RADIUS - 1e-6)
          problems.push(
            `${ia} → ${ib} hits ${o.name} (clearance ${c.toFixed(2)})`,
          )
      }
    }
    expect(problems).toEqual([])
  })

  it("never puts a standing spot inside furniture", () => {
    for (const node of NAV_NODES) {
      for (const o of OBSTACLES) {
        if (o.seats?.includes(node.id)) continue
        const d = clearance(node, node, o)
        expect(d, `${node.id} in ${o.name}`).toBeGreaterThan(0)
      }
    }
  })

  it("connects every desk and room spot to every other", () => {
    for (const from of ALL_SPOTS)
      for (const to of ALL_SPOTS)
        expect(shortestPath(from, to), `${from} → ${to}`).not.toBeNull()
  })

  it("reports unknown destinations as unreachable", () => {
    expect(shortestPath("desk:scout", "nowhere")).toBeNull()
    expect(
      planRoute({ kind: "node", node: "desk:scout" }, "nowhere"),
    ).toBeNull()
  })

  it("maps every destination kind to spots in its room", () => {
    const kinds: DestinationKind[] = [
      "desk",
      "pantry",
      "lounge",
      "gaming",
      "meeting",
    ]
    for (const kind of kinds)
      for (const id of spotsFor(kind, "quill")) {
        const node = getNode(id)
        expect(roomAt(node.x, node.z)).toBe(DESTINATION_ROOM[kind])
      }
  })
})

describe("routes", () => {
  it("enters each back room through its doorway, never through a wall", () => {
    for (const [room, target] of [
      ["meeting", "meeting:1"],
      ["pantry", "pantry:1"],
      ["lounge", "lounge:1"],
    ] as const) {
      const route = planRoute({ kind: "node", node: "desk:relay" }, target)!
      const door = DOORWAYS.find((d) => d.room === room)!
      // Sample the walk: whenever it crosses the partition line, it's in the doorway.
      let crossings = 0
      for (let d = 0; d < route.total; d += 0.02) {
        const a = positionAt(route, d).position
        const b = positionAt(route, d + 0.02).position
        if (
          (a[2] - ROOMS[room].bounds.z1) * (b[2] - ROOMS[room].bounds.z1) <
          0
        ) {
          crossings++
          expect(a[0], `${room} crossing x`).toBeGreaterThan(
            door.x0 + WALKER_RADIUS,
          )
          expect(a[0], `${room} crossing x`).toBeLessThan(
            door.x1 - WALKER_RADIUS,
          )
        }
      }
      expect(crossings, room).toBe(1)
    }
  })

  it("keeps every sampled point of every route inside the floor", () => {
    for (const from of DESKS)
      for (const to of [...PANTRY_SPOTS, ...GAMING_SPOTS, "meeting:7"]) {
        const route = planRoute({ kind: "node", node: from }, to)!
        for (let d = 0; d <= route.total; d += 0.1) {
          const [x, y, z] = positionAt(route, d).position
          expect(y).toBe(0)
          expect(x).toBeGreaterThanOrEqual(WALKABLE_BOUNDS.x0)
          expect(x).toBeLessThanOrEqual(WALKABLE_BOUNDS.x1)
          expect(z).toBeGreaterThanOrEqual(WALKABLE_BOUNDS.z0)
          expect(z).toBeLessThanOrEqual(WALKABLE_BOUNDS.z1)
        }
      }
  })

  it("walks between rooms continuously (no jumps, no teleporting)", () => {
    const route = planRoute({ kind: "node", node: "pantry:2" }, "gaming:3")!
    for (let d = 0; d <= route.total; d += 0.05) {
      const a = positionAt(route, d).position
      const b = positionAt(route, d + 0.05).position
      expect(Math.hypot(b[0] - a[0], b[2] - a[2])).toBeLessThan(0.051)
    }
    expect(routeDuration(route)).toBeGreaterThan(4)
  })

  it("samples positions deterministically and faces the direction of travel", () => {
    const route = planRoute({ kind: "node", node: "desk:pixel" }, "pantry:2")!
    expect(positionAt(route, 1.234)).toEqual(positionAt(route, 1.234))
    const start = positionAt(route, 0)
    expect(start.position).toEqual([
      route.points[0].x,
      route.points[0].y,
      route.points[0].z,
    ])
    // First step goes back from the desk (towards -z): heading ≈ π.
    expect(Math.abs(Math.abs(start.heading) - Math.PI)).toBeLessThan(1e-6)
    const end = positionAt(route, route.total + 5)
    expect(end.done).toBe(true)
    expect(end.position).toEqual([
      route.points.at(-1)!.x,
      route.points.at(-1)!.y,
      route.points.at(-1)!.z,
    ])
  })

  it("resumes an interrupted walk from the middle of a corridor", () => {
    const route = planRoute({ kind: "node", node: "desk:quill" }, "meeting:4")!
    const mid = positionAt(route, route.total / 2)
    const edge = segmentEdge(route, mid.segment)!
    expect(edge).toHaveLength(2)
    const back = planRoute(
      { kind: "point", point: mid.position, edge },
      "desk:quill",
    )!
    expect(back.points[0].x).toBeCloseTo(mid.position[0])
    expect(back.points.at(-1)?.node).toBe("desk:quill")
    expect(back.total).toBeLessThan(route.total)
  })

  it("takes longer to reach a farther room", () => {
    const near = planRoute({ kind: "node", node: "desk:pixel" }, "pantry:1")!
    const far = planRoute({ kind: "node", node: "desk:pixel" }, "meeting:7")!
    expect(routeDuration(near)).toBeGreaterThan(2)
    expect(routeDuration(far)).toBeGreaterThan(routeDuration(near))
  })
})
