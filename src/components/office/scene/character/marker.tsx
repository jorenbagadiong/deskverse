"use client"

import * as THREE from "three"

import type { EmployeeStatus } from "@/config/employee-status"

import { statusGlowKey, useSceneMaterials } from "../materials"

import { g } from "./geometry"

/**
 * A small speech bubble over the head with a status glyph. Shapes mirror the
 * 2D lucide icons used in the UI, so state never relies on color alone.
 * Idle shows no bubble (calm).
 */
export function StatusBubble({ status }: { status: EmployeeStatus }) {
  const m = useSceneMaterials()
  if (status === "idle") return null
  const color = m.glow[statusGlowKey[status]]

  return (
    <group>
      <mesh geometry={g.circle(0.17, 32)} material={m.white} />
      <mesh geometry={g.ring(0.17, 0.2, 40)} material={color} />
      <mesh
        geometry={g.shape("bubble-tail", tail)}
        position={[0.05, -0.2, 0]}
        material={color}
      />
      <group position-z={0.004}>
        <Glyph status={status} />
      </group>
    </group>
  )
}

function Glyph({ status }: { status: EmployeeStatus }) {
  const m = useSceneMaterials()
  const color = m.glow[statusGlowKey[status]]
  switch (status) {
    case "working":
      return (
        <>
          {[-0.065, 0, 0.065].map((x) => (
            <mesh
              key={x}
              geometry={g.circle(0.026, 16)}
              position-x={x}
              material={color}
            />
          ))}
        </>
      )
    case "waiting":
      // Hourglass
      return (
        <>
          <mesh
            geometry={g.shape("tri-down", triangleDown)}
            position-y={0.045}
            material={color}
          />
          <mesh
            geometry={g.shape("tri-down", triangleDown)}
            position-y={-0.045}
            rotation-z={Math.PI}
            material={color}
          />
          <mesh
            geometry={g.box(0.13, 0.016, 0.004, 0.004)}
            position-y={0.1}
            material={color}
          />
          <mesh
            geometry={g.box(0.13, 0.016, 0.004, 0.004)}
            position-y={-0.1}
            material={color}
          />
        </>
      )
    case "completed":
      // Check mark
      return (
        <>
          <mesh
            geometry={g.box(0.075, 0.03, 0.004, 0.012)}
            position={[-0.035, -0.02, 0]}
            rotation-z={-Math.PI / 4}
            material={color}
          />
          <mesh
            geometry={g.box(0.14, 0.03, 0.004, 0.012)}
            position={[0.035, 0.015, 0]}
            rotation-z={Math.PI / 3.6}
            material={color}
          />
        </>
      )
    case "failed":
      // Exclamation mark
      return (
        <>
          <mesh
            geometry={g.box(0.034, 0.1, 0.004, 0.014)}
            position-y={0.03}
            material={color}
          />
          <mesh
            geometry={g.circle(0.019, 14)}
            position-y={-0.065}
            material={color}
          />
        </>
      )
    default:
      return null
  }
}

/** Floor ring + a soft blob shadow under the character. */
export function FloorRing({
  status,
  selected,
  hovered,
}: {
  status: EmployeeStatus
  selected: boolean
  hovered: boolean
}) {
  const m = useSceneMaterials()
  return (
    <>
      <mesh
        geometry={g.circle(0.4, 28)}
        rotation-x={-Math.PI / 2}
        position-y={0.008}
        material={m.shadow}
      />
      <mesh
        geometry={selected ? g.ring(0.44, 0.52, 48) : g.ring(0.4, 0.43, 48)}
        rotation-x={-Math.PI / 2}
        position-y={0.012}
        material={selected ? m.white : m.glow[statusGlowKey[status]]}
      />
      {hovered && !selected ? (
        <mesh
          geometry={g.ring(0.47, 0.5, 48)}
          rotation-x={-Math.PI / 2}
          position-y={0.012}
          material={m.glow.muted}
        />
      ) : null}
    </>
  )
}

function tail() {
  return triangleGeometry(0.07, 0.08, true)
}
function triangleDown() {
  return triangleGeometry(0.11, 0.075, true)
}

function triangleGeometry(width: number, height: number, down = false) {
  const s = new THREE.Shape()
  const y = down ? height / 2 : -height / 2
  s.moveTo(-width / 2, y)
  s.lineTo(width / 2, y)
  s.lineTo(0, -y)
  s.lineTo(-width / 2, y)
  return new THREE.ShapeGeometry(s)
}
