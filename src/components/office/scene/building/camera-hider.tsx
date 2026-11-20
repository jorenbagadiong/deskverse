"use client"

import { useRef } from "react"
import { useFrame } from "@react-three/fiber"
import type * as THREE from "three"

import { nextWallHidden, wallFacesCamera } from "../camera-framing"

export { BACK_WALL, LEFT_WALL } from "../camera-framing"

/**
 * Hides a wall (and everything mounted on it) when the camera moves behind it,
 * so the interior stays visible from every horizontal angle. The building's
 * walls sit on its back (-z) and left (-x) sides.
 *
 * `outward` is the wall's outward normal in the x/z plane. Visibility only
 * changes on frames that render anyway (camera moves invalidate).
 */
export function CameraHider({
  outward,
  children,
}: {
  outward: readonly [number, number]
  children: React.ReactNode
}) {
  const group = useRef<THREE.Group>(null)
  const hidden = useRef(false)

  useFrame(({ camera, controls }) => {
    const g = group.current
    if (!g) return
    // Direction from the orbit target to the camera.
    const target = (controls as { target?: THREE.Vector3 } | null)?.target
    const dx = camera.position.x - (target?.x ?? 0)
    const dz = camera.position.z - (target?.z ?? 0)
    hidden.current = nextWallHidden(
      hidden.current,
      wallFacesCamera(outward, dx, dz),
    )
    g.visible = !hidden.current
  })

  return <group ref={group}>{children}</group>
}
