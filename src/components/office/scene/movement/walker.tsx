"use client"

import { useRef } from "react"
import { useFrame } from "@react-three/fiber"
import type * as THREE from "three"

import type { OfficeEmployeeId } from "@/config/office"
import type { LiveStore } from "@/lib/office-live"

import { LIFT_HEIGHT } from "../building/floor-group"

/**
 * Places a character in the world from its live position each frame.
 * Characters on Floor 2 follow the floor's lift (and hide with it) so the
 * "lift Floor 2 away" view never leaves anyone floating; walkers on the
 * staircase belong to the Floor 1 structure and stay visible.
 */
export function Walker({
  id,
  live,
  floor2Offset,
  children,
}: {
  id: OfficeEmployeeId
  live: React.RefObject<LiveStore>
  floor2Offset: React.RefObject<number>
  children: React.ReactNode
}) {
  const group = useRef<THREE.Group>(null)

  useFrame(() => {
    const g = group.current
    const e = live.current.get(id)
    if (!g || !e) return
    const lift = e.floor === 2 && !e.onStairs ? floor2Offset.current : 0
    g.position.set(e.x, e.y + lift, e.z)
    g.rotation.y = e.heading
    g.visible = lift < LIFT_HEIGHT - 0.05
  })

  return <group ref={group}>{children}</group>
}
