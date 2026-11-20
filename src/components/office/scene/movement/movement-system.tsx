"use client"

import { useEffect, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"

import {
  officeEmployees,
  type FloorId,
  type OfficeEmployeeId,
} from "@/config/office"
import { entryFor, type LiveStore } from "@/lib/office-live"
import type { Movement } from "@/lib/office-movement"
import {
  floorOfHeight,
  getNode,
  positionAt,
  segmentEdge,
  speedFor,
} from "@/lib/office-navigation"

import { shortestAngle } from "../camera-framing"
import { frameDelta } from "../frame-delta"

const TURN_RATE = 9

/**
 * Advances walking employees along their routes each frame and writes their
 * live position into the shared store. Navigation (the route) is data from
 * the reducer; this only samples it. Discrete events (arrival, floor change)
 * are reported back once; nothing here sets React state per frame.
 */
export function MovementSystem({
  movement,
  live,
  reducedMotion,
  onArrive,
  onFloorChange,
}: {
  movement: Record<OfficeEmployeeId, Movement>
  live: React.RefObject<LiveStore>
  reducedMotion: boolean
  onArrive: (id: OfficeEmployeeId, routeId: number) => void
  onFloorChange: (id: OfficeEmployeeId, floor: FloorId) => void
}) {
  const invalidate = useThree((s) => s.invalidate)
  const progress = useRef(
    new Map<
      OfficeEmployeeId,
      { routeId: number; distance: number; arrived: boolean }
    >(),
  )

  useEffect(() => {
    invalidate()
  }, [movement, invalidate])

  useFrame((_, rawDelta) => {
    const dt = frameDelta(rawDelta)
    const store = live.current
    let busy = false

    for (const { id } of officeEmployees) {
      const m = movement[id]
      const prev = store.get(id) ?? entryFor(m)
      let next = prev

      if (m.kind === "walking") {
        let p = progress.current.get(id)
        if (!p || p.routeId !== m.routeId) {
          p = { routeId: m.routeId, distance: 0, arrived: false }
          progress.current.set(id, p)
        }
        const before = p.distance
        const segment = positionAt(m.route, before).segment
        p.distance = reducedMotion
          ? m.route.total
          : Math.min(m.route.total, before + speedFor(m.route, segment) * dt)
        const sample = positionAt(m.route, p.distance)
        const turn = shortestAngle(prev.heading, sample.heading)
        next = {
          x: sample.position[0],
          y: sample.position[1],
          z: sample.position[2],
          heading: reducedMotion
            ? sample.heading
            : prev.heading + turn * (1 - Math.exp(-TURN_RATE * dt)),
          floor: floorOfHeight(sample.position[1]),
          moving: !sample.done,
          onStairs: sample.onStairs,
          stride: prev.stride + (p.distance - before),
          node: sample.done ? m.target : null,
          edge: segmentEdge(m.route, sample.segment),
        }
        if (sample.done && !p.arrived) {
          p.arrived = true
          onArrive(id, m.routeId)
        }
        if (!sample.done) busy = true
      } else {
        progress.current.delete(id)
        const base = entryFor(m)
        // Turn smoothly to the place's facing (e.g. towards the counter or sofa).
        const goal =
          m.kind === "at" && getNode(m.node).heading !== undefined
            ? base.heading
            : prev.heading
        const turn = shortestAngle(prev.heading, goal)
        const heading =
          reducedMotion || Math.abs(turn) < 0.002
            ? goal
            : prev.heading + turn * (1 - Math.exp(-TURN_RATE * dt))
        if (heading !== goal) busy = true
        next = { ...base, heading, stride: prev.stride }
      }

      if (next.floor !== prev.floor) onFloorChange(id, next.floor)
      store.set(id, next)
    }

    if (busy) invalidate()
  })

  return null
}
