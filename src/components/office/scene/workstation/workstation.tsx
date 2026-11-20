"use client"

import type { EmployeeStatus } from "@/config/employee-status"
import { DESK_STAND_OFFSET_Z, type OfficeEmployee } from "@/config/office"

import { g } from "../character/geometry"
import {
  statusGlowKey,
  useIdentityMaterials,
  useSceneMaterials,
} from "../materials"
import { Batch } from "../shared/batch"

import { StationProps } from "./props"

/** Shared desk dimensions; the character stands behind the desk (local -z). */
export const DESK = { width: 1.7, depth: 0.78, height: 0.58 } as const
export const CHARACTER_OFFSET_Z = DESK_STAND_OFFSET_Z

/**
 * Reusable workstation: one desk design for everyone, plus props that match
 * the employee's job (see props.tsx). Screens are tinted by status.
 */
export function Workstation({
  employee,
  status,
  animate,
  onSelect,
}: {
  employee: OfficeEmployee
  status: EmployeeStatus
  /** True while the employee is working and motion is allowed. */
  animate: boolean
  onSelect: () => void
}) {
  const m = useSceneMaterials()
  const id = useIdentityMaterials(employee.glow)
  const top = DESK.height

  // Idle/working screens use the identity color; other states show the status color.
  const screen =
    status === "idle" || status === "working"
      ? id.holo
      : m.screen[statusGlowKey[status]]
  const screenGlow =
    status === "idle" || status === "working"
      ? id.glow
      : m.glow[statusGlowKey[status]]

  return (
    <group
      onClick={(event) => {
        event.stopPropagation()
        onSelect()
      }}
    >
      <Batch version={status}>
        {/* Floor zone + soft shadow */}
        <mesh
          geometry={g.plate(2.3, 1.95, 0.01, 0.004)}
          position={[0, 0.006, -0.3]}
          rotation-x={-Math.PI / 2}
          material={m.floorInset}
          receiveShadow
        />
        <mesh
          geometry={g.box(2.3, 0.012, 0.025, 0.006)}
          position={[0, 0.012, 0.67]}
          material={id.glow}
        />

        {/* Desk */}
        <mesh
          geometry={g.box(DESK.width, 0.06, DESK.depth, 0.028)}
          position-y={top - 0.03}
          material={m.deskTop}
          castShadow
          receiveShadow
        />
        {[-1, 1].map((side) => (
          <mesh
            key={side}
            geometry={g.box(0.09, top - 0.06, DESK.depth - 0.08, 0.035)}
            position={[side * (DESK.width / 2 - 0.08), (top - 0.06) / 2, 0]}
            material={m.desk}
            castShadow
          />
        ))}
        <mesh
          geometry={g.box(DESK.width - 0.24, 0.32, 0.04, 0.018)}
          position={[0, top - 0.24, DESK.depth / 2 - 0.08]}
          material={m.desk}
        />
        <mesh
          geometry={g.box(DESK.width - 0.02, 0.018, 0.016, 0.006)}
          position={[0, top - 0.055, DESK.depth / 2 - 0.004]}
          material={id.glow}
        />

        {/* Keyboard (where the hands rest) */}
        <mesh
          geometry={g.box(0.5, 0.024, 0.16, 0.01)}
          position={[0, top + 0.012, -0.17]}
          material={m.metal}
        />
        <mesh
          geometry={g.box(0.44, 0.004, 0.012, 0.002)}
          position={[0, top + 0.026, -0.12]}
          material={id.glow}
        />

        {/* A warm personal detail: a mug */}
        <group position={[0.73, top, 0.27]}>
          <mesh
            geometry={g.cylinder(0.045, 0.04, 0.1, 16)}
            position-y={0.05}
            material={m.shell}
          />
          <mesh
            geometry={g.torus(0.03, 0.009, Math.PI * 2, 6, 14)}
            position={[0.05, 0.05, 0]}
            material={m.shell}
          />
        </group>

        <StationProps
          employee={employee}
          screen={screen}
          screenGlow={screenGlow}
          animate={animate}
        />
      </Batch>
    </group>
  )
}
