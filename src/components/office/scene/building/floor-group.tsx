"use client"

import { useEffect, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import type * as THREE from "three"

import type { FloorId } from "@/config/office"

import { floorY } from "../camera-framing"
import { frameDelta } from "../frame-delta"

/** How far Floor 2 rises when it is lifted away to reveal Floor 1. */
export const LIFT_HEIGHT = 4.5

/**
 * Holds one floor's architecture, desks and characters. Floor 2 can be
 * "lifted" (it rises and then hides) so it never obstructs Floor 1, like
 * lifting the top off a dollhouse. Hidden content is not rendered at all.
 */
export function FloorGroup({
  floor,
  lifted,
  reducedMotion,
  children,
}: {
  floor: FloorId
  lifted: boolean
  reducedMotion: boolean
  children: React.ReactNode
}) {
  const group = useRef<THREE.Group>(null)
  const offset = useRef(lifted ? LIFT_HEIGHT : 0)
  const invalidate = useThree((s) => s.invalidate)

  useEffect(() => {
    invalidate()
  }, [lifted, invalidate])

  useFrame((_, rawDelta) => {
    const g = group.current
    if (!g) return
    const goal = lifted ? LIFT_HEIGHT : 0
    offset.current = reducedMotion
      ? goal
      : dampTo(offset.current, goal, frameDelta(rawDelta))
    g.position.y = floorY(floor) + offset.current
    g.visible = offset.current < LIFT_HEIGHT - 0.05
    if (Math.abs(offset.current - goal) > 0.002) invalidate()
    else offset.current = goal
  })

  return (
    <group
      ref={group}
      position-y={floorY(floor) + (lifted ? LIFT_HEIGHT : 0)}
      visible={!lifted}
    >
      {children}
    </group>
  )
}

function dampTo(from: number, to: number, dt: number) {
  return from + (to - from) * (1 - Math.exp(-7 * dt))
}
