"use client"

import type { EmployeeStatus } from "@/config/employee-status"
import { officeEmployees, type OfficeEmployeeId } from "@/config/office"

import { g } from "../character/geometry"
import { statusGlowKey, useSceneMaterials, type GlowKey } from "../materials"

import { Chair } from "./architecture"

/** Reception desk with the (provisional) brand mark. */
export function Reception() {
  const m = useSceneMaterials()
  return (
    <group>
      <mesh
        geometry={g.box(2.3, 0.92, 0.62, 0.12)}
        position-y={0.46}
        material={m.wallInner}
        castShadow
        receiveShadow
      />
      <mesh
        geometry={g.box(2.45, 0.06, 0.78, 0.03)}
        position={[0, 0.95, -0.05]}
        material={m.deskTop}
        castShadow
      />
      <mesh
        geometry={g.box(2.3, 0.025, 0.02, 0.008)}
        position={[0, 0.1, 0.32]}
        material={m.glow.primary}
      />
      {/* Logo plate: portal + visor, echoing the brand mark */}
      <group position={[0, 0.52, 0.315]}>
        <mesh
          geometry={g.box(0.42, 0.42, 0.03, 0.11)}
          material={m.glow.primary}
        />
        <mesh
          geometry={g.box(0.22, 0.2, 0.034, 0.08)}
          position-y={-0.02}
          material={m.window}
        />
        <mesh
          geometry={g.box(0.13, 0.05, 0.036, 0.022)}
          position-y={0.0}
          material={m.glow.accent}
        />
      </group>
      {/* Visitor screen and a small lamp */}
      <group position={[0.7, 0.98, -0.12]} rotation-x={-0.35}>
        <mesh geometry={g.box(0.38, 0.24, 0.03, 0.02)} material={m.joint} />
        <mesh
          geometry={g.box(0.34, 0.2, 0.004, 0.012)}
          position-z={0.017}
          material={m.screen.primary}
        />
      </group>
      <group position={[-0.8, 0.98, -0.1]}>
        <mesh
          geometry={g.cylinder(0.07, 0.09, 0.03, 16)}
          position-y={0.015}
          material={m.metal}
        />
        <mesh
          geometry={g.cylinder(0.012, 0.012, 0.32, 8)}
          position-y={0.17}
          material={m.metal}
        />
        <mesh
          geometry={g.sphere(0.07, 14, 10)}
          position-y={0.36}
          material={m.glow.accent}
        />
      </group>
    </group>
  )
}

/** Oval meeting table with chairs and a small hologram. */
export function MeetingTable() {
  const m = useSceneMaterials()
  const seats: [number, number][] = [
    [-1.05, 0],
    [1.05, 0],
    [-0.45, 0.66],
    [0.45, 0.66],
    [-0.45, -0.66],
    [0.45, -0.66],
  ]
  return (
    <group>
      <mesh
        geometry={g.circle(1.55, 40)}
        rotation-x={-Math.PI / 2}
        position-y={0.005}
        scale={[1.25, 0.82, 1]}
        material={m.floorInset}
        receiveShadow
      />
      <mesh
        geometry={g.cylinder(0.8, 0.8, 0.06, 40)}
        position-y={0.62}
        scale={[1.45, 1, 0.75]}
        material={m.wood}
        castShadow
        receiveShadow
      />
      <mesh
        geometry={g.cylinder(0.08, 0.22, 0.6, 16)}
        position-y={0.3}
        material={m.metal}
      />
      {seats.map(([x, z], i) => (
        // Each chair turns to face the table center.
        <Chair key={i} position={[x, 0, z]} rotationY={Math.atan2(-x, -z)} />
      ))}
      {/* Hologram */}
      <mesh
        geometry={g.cylinder(0.12, 0.14, 0.03, 20)}
        position-y={0.665}
        material={m.metal}
      />
      <mesh
        geometry={g.sphere(0.2, 16, 12)}
        position-y={1.0}
        material={m.screen.secondary}
      />
      <mesh
        geometry={g.torus(0.26, 0.008, Math.PI * 2, 6, 32)}
        position-y={1.0}
        rotation-x={Math.PI / 2}
        material={m.glow.secondary}
      />
    </group>
  )
}

/** Free-standing holographic project board (kanban). */
export function ProjectBoard() {
  const m = useSceneMaterials()
  const columns: GlowKey[] = ["muted", "primary", "accent", "success"]
  return (
    <group>
      {[-1.45, 1.45].map((x) => (
        <group key={x} position-x={x}>
          <mesh
            geometry={g.box(0.12, 2.3, 0.12, 0.04)}
            position-y={1.15}
            material={m.metal}
            castShadow
          />
          <mesh
            geometry={g.box(0.5, 0.05, 0.4, 0.02)}
            position-y={0.025}
            material={m.metal}
          />
        </group>
      ))}
      <mesh
        geometry={g.box(2.8, 1.5, 0.02, 0.04)}
        position-y={1.4}
        material={m.screen.primary}
      />
      <mesh
        geometry={g.box(2.8, 0.03, 0.03, 0.01)}
        position-y={2.16}
        material={m.glow.primary}
      />
      <mesh
        geometry={g.box(2.8, 0.03, 0.03, 0.01)}
        position-y={0.64}
        material={m.glow.primary}
      />
      {columns.map((key, c) => (
        <group key={key} position={[-1.05 + c * 0.7, 1.4, 0.02]}>
          <mesh
            geometry={g.box(0.56, 0.06, 0.006, 0.02)}
            position-y={0.6}
            material={m.glow[key]}
          />
          {Array.from({ length: 3 - (c % 2) }, (_, i) => (
            <mesh
              key={i}
              geometry={g.box(0.52, 0.24, 0.008, 0.03)}
              position-y={0.36 - i * 0.32}
              material={m.screen[key]}
            />
          ))}
        </group>
      ))}
    </group>
  )
}

/** Unassigned creative hot desks: two facing desks with monitors. */
export function HotDesks() {
  const m = useSceneMaterials()
  return (
    <group>
      <mesh
        geometry={g.box(2.0, 0.06, 1.3, 0.03)}
        position-y={0.6}
        material={m.deskTop}
        castShadow
        receiveShadow
      />
      {[-0.9, 0.9].map((x) => (
        <mesh
          key={x}
          geometry={g.box(0.08, 0.57, 1.2, 0.03)}
          position={[x, 0.285, 0]}
          material={m.desk}
        />
      ))}
      {[-1, 1].map((side) => (
        <group
          key={side}
          position-z={side * 0.3}
          rotation-y={side > 0 ? Math.PI : 0}
        >
          {[-0.45, 0.45].map((x) => (
            <group key={x} position={[x, 0.63, -0.1]}>
              <mesh
                geometry={g.cylinder(0.02, 0.05, 0.14, 10)}
                position-y={0.07}
                material={m.metal}
              />
              <mesh
                geometry={g.box(0.5, 0.3, 0.03, 0.02)}
                position-y={0.3}
                material={m.joint}
                castShadow
              />
              <mesh
                geometry={g.box(0.46, 0.26, 0.004, 0.012)}
                position={[0, 0.3, 0.017]}
                material={m.screen.secondary}
              />
            </group>
          ))}
          <Chair position={[0, 0, -0.95]} rotationY={0} />
        </group>
      ))}
    </group>
  )
}

/** Coffee bar: the warm heart of the office. */
export function CoffeeBar() {
  const m = useSceneMaterials()
  return (
    <group>
      <mesh
        geometry={g.box(2.2, 0.95, 0.6, 0.08)}
        position-y={0.475}
        material={m.wood}
        castShadow
        receiveShadow
      />
      <mesh
        geometry={g.box(2.3, 0.05, 0.7, 0.02)}
        position-y={0.97}
        material={m.deskTop}
      />
      <group position={[-0.55, 1.0, -0.05]}>
        <mesh
          geometry={g.box(0.36, 0.44, 0.32, 0.05)}
          position-y={0.22}
          material={m.joint}
          castShadow
        />
        <mesh
          geometry={g.box(0.2, 0.08, 0.02, 0.01)}
          position={[0, 0.34, 0.165]}
          material={m.glow.accent}
        />
        <mesh
          geometry={g.cylinder(0.045, 0.04, 0.09, 14)}
          position={[0, 0.05, 0.2]}
          material={m.shell}
        />
      </group>
      {[0.2, 0.45, 0.7].map((x, i) => (
        <mesh
          key={x}
          geometry={g.cylinder(0.045, 0.04, 0.1, 14)}
          position={[x, 1.05, 0.1]}
          material={i === 1 ? m.glow.accent : m.shell}
        />
      ))}
      {[-0.6, 0.6].map((x) => (
        <group key={x} position={[x, 0, 0.62]}>
          <mesh
            geometry={g.cylinder(0.025, 0.12, 0.7, 12)}
            position-y={0.35}
            material={m.metal}
          />
          <mesh
            geometry={g.cylinder(0.2, 0.18, 0.08, 20)}
            position-y={0.72}
            material={m.fabric}
            castShadow
          />
        </group>
      ))}
    </group>
  )
}

/** Floor 2 centerpiece: live (simulated) status of the whole team. */
export function OperationsBoard({
  statuses,
}: {
  statuses: Record<OfficeEmployeeId, EmployeeStatus>
}) {
  const m = useSceneMaterials()
  return (
    <group>
      <mesh geometry={g.box(4.6, 1.7, 0.06, 0.06)} material={m.window} />
      <mesh
        geometry={g.box(4.7, 1.8, 0.04, 0.07)}
        position-z={-0.02}
        material={m.trim}
      />
      <mesh
        geometry={g.box(4.3, 0.05, 0.01, 0.02)}
        position={[0, 0.7, 0.035]}
        material={m.glow.primary}
      />
      {officeEmployees.map((employee, i) => {
        const col = i < 4 ? 0 : 1
        const row = i < 4 ? i : i - 4
        const x = col === 0 ? -1.15 : 1.15
        const y = 0.45 - row * 0.32
        const status = statuses[employee.id]
        return (
          <group key={employee.id} position={[x, y, 0.035]}>
            <mesh
              geometry={g.circle(0.07, 16)}
              position-x={-0.85}
              material={m.glow.muted}
            />
            <mesh
              geometry={g.box(0.9, 0.05, 0.004, 0.02)}
              position-x={-0.25}
              material={m.glow.muted}
            />
            <mesh
              geometry={g.box(0.48, 0.17, 0.006, 0.06)}
              position-x={0.62}
              material={m.screen[statusGlowKey[status]]}
            />
            <mesh
              geometry={g.circle(0.04, 12)}
              position={[0.45, 0, 0.005]}
              material={m.glow[statusGlowKey[status]]}
            />
          </group>
        )
      })}
    </group>
  )
}

/** Wall calendar near Tempo's station. */
export function CalendarWall() {
  const m = useSceneMaterials()
  return (
    <group>
      <mesh geometry={g.box(1.9, 1.15, 0.05, 0.05)} material={m.window} />
      <mesh
        geometry={g.box(1.7, 0.05, 0.006, 0.02)}
        position={[0, 0.45, 0.03]}
        material={m.glow.secondary}
      />
      {Array.from({ length: 15 }, (_, n) => {
        const c = n % 5
        const r = Math.floor(n / 5)
        return (
          <mesh
            key={n}
            geometry={g.box(0.26, 0.2, 0.006, 0.04)}
            position={[-0.62 + c * 0.31, 0.2 - r * 0.27, 0.03]}
            material={
              n % 4 === 1
                ? m.screen.secondary
                : n % 7 === 3
                  ? m.screen.accent
                  : m.screen.muted
            }
          />
        )
      })}
    </group>
  )
}

/** Wall of analytics monitors near Ledger's station. */
export function AnalyticsWall() {
  const m = useSceneMaterials()
  return (
    <group>
      {[
        [-0.55, 0.36],
        [0.55, 0.36],
        [-0.55, -0.32],
        [0.55, -0.32],
      ].map(([x, y], i) => (
        <group key={i} position={[x, y, 0]}>
          <mesh
            geometry={g.box(1.0, 0.6, 0.06, 0.04)}
            material={m.joint}
            castShadow
          />
          <mesh
            geometry={g.box(0.92, 0.52, 0.004, 0.02)}
            position-z={0.032}
            material={m.screen.accent}
          />
          {i % 2 === 0
            ? [0, 1, 2, 3, 4].map((b) => (
                <mesh
                  key={b}
                  geometry={g.box(
                    0.1,
                    0.08 + ((b * 7 + i) % 5) * 0.06,
                    0.004,
                    0.012,
                  )}
                  position={[
                    -0.3 + b * 0.15,
                    -0.2 + (0.08 + ((b * 7 + i) % 5) * 0.06) / 2,
                    0.036,
                  ]}
                  material={m.glow.accent}
                />
              ))
            : [
                <mesh
                  key="ring"
                  geometry={g.ring(0.1, 0.15, 28)}
                  position={[-0.2, 0, 0.036]}
                  material={m.glow.accent}
                />,
                <mesh
                  key="l1"
                  geometry={g.box(0.3, 0.03, 0.004, 0.01)}
                  position={[0.2, 0.08, 0.036]}
                  material={m.glow.muted}
                />,
                <mesh
                  key="l2"
                  geometry={g.box(0.24, 0.03, 0.004, 0.01)}
                  position={[0.17, -0.02, 0.036]}
                  material={m.glow.muted}
                />,
              ]}
        </group>
      ))}
    </group>
  )
}

/** Decorative wall slats with a thin light line. */
export function WallPanels({
  count,
  spacing = 0.5,
  height = 2.2,
}: {
  count: number
  spacing?: number
  height?: number
}) {
  const m = useSceneMaterials()
  return (
    <group>
      {Array.from({ length: count }, (_, i) => (
        <mesh
          key={i}
          geometry={g.box(spacing * 0.8, height, 0.06, 0.03)}
          position={[(i - (count - 1) / 2) * spacing, 0, 0]}
          material={i % 3 === 1 ? m.wood : m.wallInner}
        />
      ))}
      <mesh
        geometry={g.box(count * spacing, 0.02, 0.02, 0.008)}
        position={[0, -height / 2 + 0.18, 0.045]}
        material={m.glow.secondary}
      />
    </group>
  )
}
