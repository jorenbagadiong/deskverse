/**
 * Live, per-frame employee positions shared between the 3D scene (writer) and
 * the DOM / camera (readers). A plain mutable Map in a ref: updated every
 * frame without React state, read on demand (nameplates, camera follow,
 * "stop here" commands).
 */
import { roomAt, type OfficeEmployeeId, type RoomId } from "@/config/office"

import type { LiveLocation, Movement } from "./office-movement"
import { getNode } from "./office-navigation"

export type LiveEntry = {
  x: number
  y: number
  z: number
  /** Facing (radians; 0 faces +z). */
  heading: number
  moving: boolean
  /** Total distance walked (drives the walk cycle so feet don't slide). */
  stride: number
  node: string | null
  edge: readonly [string, string] | null
}

export type LiveStore = Map<OfficeEmployeeId, LiveEntry>

export function entryFor(m: Movement): LiveEntry {
  if (m.kind === "at") {
    const node = getNode(m.node)
    return {
      x: node.x,
      y: node.y,
      z: node.z,
      heading: node.heading ?? 0,
      moving: false,
      stride: 0,
      node: m.node,
      edge: null,
    }
  }
  if (m.kind === "stopped") {
    return {
      x: m.point[0],
      y: m.point[1],
      z: m.point[2],
      heading: 0,
      moving: false,
      stride: 0,
      node: null,
      edge: m.edge,
    }
  }
  const p = m.route.points[0]
  return {
    x: p.x,
    y: p.y,
    z: p.z,
    heading: 0,
    moving: true,
    stride: 0,
    node: p.node ?? null,
    edge: p.edge ?? null,
  }
}

export function createLiveStore(
  movement: Record<OfficeEmployeeId, Movement>,
): LiveStore {
  return new Map(
    Object.entries(movement).map(([id, m]) => [
      id as OfficeEmployeeId,
      entryFor(m),
    ]),
  )
}

/** Snapshot used when a command needs to know where a walker is right now. */
export function liveLocation(
  store: LiveStore,
  id: OfficeEmployeeId,
): LiveLocation | undefined {
  const e = store.get(id)
  if (!e) return undefined
  return { point: [e.x, e.y, e.z], node: e.node, edge: e.edge }
}

/** Room someone is in right now (the corridor belongs to the Operations Room). */
export function liveRoom(
  store: LiveStore,
  id: OfficeEmployeeId,
): RoomId | null {
  const e = store.get(id)
  return e ? roomAt(e.x, e.z) : null
}
