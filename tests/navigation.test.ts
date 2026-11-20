import { describe, expect, it } from "vitest"

import { FLOOR_HEIGHT, officeEmployees } from "@/config/office"
import {
  FLOOR_BOUNDS,
  getNode,
  isStairSegment,
  LOUNGE_SPOTS,
  NAV_EDGES,
  NAV_NODES,
  OBSTACLES,
  PANTRY_SPOTS,
  planRoute,
  positionAt,
  routeDuration,
  segmentEdge,
  shortestPath,
  WALKER_RADIUS,
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

describe("navigation graph", () => {
  it("has unique node ids and only references existing nodes", () => {
    const ids = NAV_NODES.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const [a, b] of NAV_EDGES) {
      expect(() => getNode(a)).not.toThrow()
      expect(() => getNode(b)).not.toThrow()
    }
  })

  it("keeps every node inside its floor's walkable bounds", () => {
    for (const node of NAV_NODES) {
      if (node.id.startsWith("stairs:")) continue // stair ends sit on the floor edge
      const b = FLOOR_BOUNDS[node.floor]
      expect(node.x, node.id).toBeGreaterThanOrEqual(b.x0)
      expect(node.x, node.id).toBeLessThanOrEqual(b.x1)
      expect(node.z, node.id).toBeGreaterThanOrEqual(b.z0)
      expect(node.z, node.id).toBeLessThanOrEqual(b.z1)
    }
  })

  it("puts Floor 1 nodes on the ground and Floor 2 nodes on the mezzanine", () => {
    for (const node of NAV_NODES)
      expect(node.y).toBe(node.floor === 1 ? 0 : FLOOR_HEIGHT)
  })

  it("every flat corridor clears all furniture by the walker radius", () => {
    const problems: string[] = []
    for (const [ia, ib] of NAV_EDGES) {
      const a = getNode(ia)
      const b = getNode(ib)
      if (a.floor !== b.floor) continue // the staircase edge
      for (const o of OBSTACLES) {
        if (o.floor !== a.floor) continue
        // The last step onto a seat or the stair foot may touch that furniture.
        if (
          (a.spot === "lounge" || b.spot === "lounge") &&
          o.name.startsWith("lounge-")
        )
          continue
        if (
          (ia === "f1:stair-foot" || ib === "f1:stair-foot") &&
          o.name === "stairs"
        )
          continue
        if (ia === "stairs:bottom" || ib === "stairs:bottom") continue
        const c = clearance(a, b, o)
        if (c < WALKER_RADIUS - 1e-6)
          problems.push(
            `${ia} → ${ib} hits ${o.name} (clearance ${c.toFixed(2)})`,
          )
      }
    }
    expect(problems).toEqual([])
  })

  it("connects every desk, pantry spot and lounge seat to every other", () => {
    const targets = [
      ...officeEmployees.map((e) => `desk:${e.id}`),
      ...PANTRY_SPOTS,
      ...LOUNGE_SPOTS,
    ]
    for (const from of targets)
      for (const to of targets)
        expect(shortestPath(from, to), `${from} → ${to}`).not.toBeNull()
  })

  it("reports unknown destinations as unreachable", () => {
    expect(shortestPath("desk:scout", "nowhere")).toBeNull()
    expect(
      planRoute({ kind: "node", node: "desk:scout" }, "nowhere"),
    ).toBeNull()
  })
})

describe("routes", () => {
  it("walks a same-floor route to the pantry without leaving Floor 1", () => {
    const route = planRoute({ kind: "node", node: "desk:quill" }, "pantry:1")!
    expect(route.points[0].node).toBe("desk:quill")
    expect(route.points.at(-1)?.node).toBe("pantry:1")
    expect(route.points.every((p) => p.y === 0)).toBe(true)
    expect(route.total).toBeGreaterThan(5)
  })

  it("crosses floors only via the staircase", () => {
    const route = planRoute({ kind: "node", node: "desk:scout" }, "lounge:1")!
    const nodes = route.points.map((p) => p.node)
    expect(nodes).toContain("stairs:bottom")
    expect(nodes).toContain("stairs:top")
    const stairSegments = route.points
      .slice(1)
      .filter((p, i) => isStairSegment(route.points[i], p))
    expect(stairSegments).toHaveLength(1)
    // Heights change continuously: no jump anywhere along the route.
    for (let d = 0; d <= route.total; d += 0.05) {
      const a = positionAt(route, d).position[1]
      const b = positionAt(route, d + 0.05).position[1]
      expect(Math.abs(b - a)).toBeLessThan(0.06)
    }
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
    const route = planRoute({ kind: "node", node: "desk:quill" }, "pantry:1")!
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

  it("takes a realistic amount of time (no teleporting)", () => {
    const same = planRoute({ kind: "node", node: "desk:quill" }, "pantry:1")!
    const cross = planRoute({ kind: "node", node: "desk:quill" }, "lounge:2")!
    expect(routeDuration(same)).toBeGreaterThan(4)
    expect(routeDuration(cross)).toBeGreaterThan(routeDuration(same))
  })
})
