"use client"

import { useRef } from "react"
import { useFrame } from "@react-three/fiber"
import type * as THREE from "three"

import type { OfficeEmployeeId } from "@/config/office"
import type { LiveStore } from "@/lib/office-live"

/** Places a character in the world from its live position each frame. */
export function Walker({
  id,
  live,
  children,
}: {
  id: OfficeEmployeeId
  live: React.RefObject<LiveStore>
  children: React.ReactNode
}) {
  const group = useRef<THREE.Group>(null)

  useFrame(() => {
    const g = group.current
    const e = live.current.get(id)
    if (!g || !e) return
    g.position.set(e.x, e.y, e.z)
    g.rotation.y = e.heading
  })

  return <group ref={group}>{children}</group>
}
