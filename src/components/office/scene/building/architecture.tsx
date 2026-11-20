"use client"

import type * as THREE from "three"

import { g } from "../character/geometry"
import { useSceneMaterials, type GlowKey } from "../materials"

/** A glass balustrade between two points on the floor (same y), with a top rail. */
export function Railing({
  from,
  to,
  height = 0.95,
  glow = "primary",
}: {
  from: [number, number]
  to: [number, number]
  height?: number
  glow?: GlowKey
}) {
  const m = useSceneMaterials()
  const [x0, z0] = from
  const [x1, z1] = to
  const length = Math.hypot(x1 - x0, z1 - z0)
  const angle = Math.atan2(-(z1 - z0), x1 - x0)
  const posts = Math.max(2, Math.round(length / 2.2) + 1)
  return (
    <group position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]} rotation-y={angle}>
      <mesh
        geometry={g.box(length, height - 0.08, 0.03, 0.012)}
        position-y={(height - 0.08) / 2 + 0.04}
        material={m.glass}
      />
      <mesh
        geometry={g.box(length + 0.04, 0.06, 0.08, 0.025)}
        position-y={height}
        material={m.metal}
        castShadow
      />
      <mesh
        geometry={g.box(length, 0.012, 0.02, 0.005)}
        position={[0, height - 0.045, 0.045]}
        material={m.glow[glow]}
      />
      {Array.from({ length: posts }, (_, i) => (
        <mesh
          key={i}
          geometry={g.box(0.05, height, 0.05, 0.015)}
          position={[-length / 2 + (i * length) / (posts - 1), height / 2, 0]}
          material={m.metal}
        />
      ))}
    </group>
  )
}

/** A wall window: frame, dark pane and a glowing skyline behind the glass. */
export function SkylineWindow({
  width,
  height,
  seed = 0,
}: {
  width: number
  height: number
  seed?: number
}) {
  const m = useSceneMaterials()
  const towers = Math.max(4, Math.round(width / 0.42))
  const keys: GlowKey[] = ["secondary", "primary", "secondary", "accent"]
  return (
    <group>
      <mesh
        geometry={g.box(width + 0.16, height + 0.16, 0.06, 0.03)}
        material={m.trim}
      />
      <mesh geometry={g.box(width, height, 0.065, 0.01)} material={m.window} />
      {Array.from({ length: towers }, (_, i) => {
        const h = height * (0.28 + (((i * 37 + seed * 11) % 50) / 100) * 0.9)
        const w = (width / towers) * 0.7
        const x = -width / 2 + (i + 0.5) * (width / towers)
        return (
          <mesh
            key={i}
            geometry={g.box(w, h, 0.004, 0.004)}
            position={[x, -height / 2 + h / 2, 0.036]}
            material={m.screen[keys[(i + seed) % keys.length]]}
          />
        )
      })}
      {/* Mullions */}
      {[-width / 6, width / 6].map((x) => (
        <mesh
          key={x}
          geometry={g.box(0.04, height, 0.03, 0.01)}
          position={[x, 0, 0.05]}
          material={m.trim}
        />
      ))}
      <mesh
        geometry={g.box(width, 0.04, 0.03, 0.01)}
        position={[0, height * 0.18, 0.05]}
        material={m.trim}
      />
    </group>
  )
}

/** Low-poly potted plant with layered, rounded foliage. */
export function Plant({
  position,
  scale = 1,
  tall = false,
}: {
  position: [number, number, number]
  scale?: number
  tall?: boolean
}) {
  const m = useSceneMaterials()
  const h = tall ? 0.55 : 0.36
  return (
    <group position={position} scale={scale}>
      <mesh
        geometry={g.cylinder(0.24, 0.18, h, 20)}
        position-y={h / 2}
        material={m.pot}
        castShadow
      />
      <mesh
        geometry={g.torus(0.235, 0.025, Math.PI * 2, 8, 28)}
        position-y={h}
        rotation-x={Math.PI / 2}
        material={m.trim}
      />
      <mesh
        geometry={g.sphere(0.32, 14, 10)}
        position-y={h + 0.26}
        scale={[1, 1.1, 1]}
        material={m.plant}
        castShadow
      />
      <mesh
        geometry={g.sphere(0.24, 12, 9)}
        position={[0.15, h + 0.55, 0.05]}
        material={m.plant}
        castShadow
      />
      <mesh
        geometry={g.sphere(0.2, 12, 9)}
        position={[-0.14, h + 0.5, -0.06]}
        material={m.plant}
      />
      {tall ? (
        <mesh
          geometry={g.sphere(0.18, 12, 9)}
          position={[0.02, h + 0.8, 0]}
          material={m.plant}
        />
      ) : null}
    </group>
  )
}

/** Soft, rounded lounge chair. */
export function Chair({
  position,
  rotationY = 0,
  material,
}: {
  position: [number, number, number]
  rotationY?: number
  material?: THREE.Material
}) {
  const m = useSceneMaterials()
  const fabric = material ?? m.fabric
  return (
    <group position={position} rotation-y={rotationY}>
      <mesh
        geometry={g.cylinder(0.04, 0.12, 0.32, 12)}
        position-y={0.16}
        material={m.metal}
      />
      <mesh
        geometry={g.box(0.46, 0.12, 0.44, 0.05)}
        position-y={0.38}
        material={fabric}
        castShadow
      />
      <mesh
        geometry={g.box(0.46, 0.4, 0.1, 0.045)}
        position={[0, 0.6, -0.19]}
        material={fabric}
        castShadow
      />
    </group>
  )
}

export function Sofa({
  position,
  rotationY = 0,
  length = 1.5,
}: {
  position: [number, number, number]
  rotationY?: number
  length?: number
}) {
  const m = useSceneMaterials()
  return (
    <group position={position} rotation-y={rotationY}>
      <mesh
        geometry={g.box(length, 0.22, 0.66, 0.08)}
        position-y={0.2}
        material={m.fabric}
        castShadow
      />
      <mesh
        geometry={g.box(length, 0.16, 0.6, 0.07)}
        position={[0, 0.38, 0.02]}
        material={m.fabric}
      />
      <mesh
        geometry={g.box(length, 0.48, 0.18, 0.08)}
        position={[0, 0.5, -0.26]}
        material={m.fabric}
        castShadow
      />
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          geometry={g.box(0.16, 0.42, 0.66, 0.07)}
          position={[side * (length / 2 - 0.02), 0.32, 0]}
          material={m.fabric}
        />
      ))}
    </group>
  )
}
