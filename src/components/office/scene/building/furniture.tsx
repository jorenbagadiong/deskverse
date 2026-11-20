"use client"

import type { EmployeeStatus } from "@/config/employee-status"
import { officeEmployees, type OfficeEmployeeId } from "@/config/office"
import {
  GAMING_CHAIRS,
  MEETING_CHAIRS,
  MEETING_TABLE,
} from "@/lib/office-navigation"

import { g } from "../character/geometry"
import { statusGlowKey, useSceneMaterials, type GlowKey } from "../materials"

import { Chair, Sofa } from "./architecture"

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

/**
 * Pantry: counter with a coffee machine, a fridge and a high table with
 * stools. Modeled in local coordinates; building.tsx places it with
 * PANTRY_OFFSET. Footprints match OBSTACLES in lib/office-navigation.ts; the
 * three standing spots (pantry:1–3) sit in front of the counter and at the table.
 */
export function Pantry() {
  const m = useSceneMaterials()
  return (
    <group>
      {/* Floor zone */}
      <mesh
        geometry={g.box(3.7, 0.012, 2.7, 0.006)}
        position={[5.05, 0.007, -3.35]}
        material={m.floorInset}
        receiveShadow
      />
      {/* Counter */}
      <mesh
        geometry={g.box(2.6, 0.92, 0.62, 0.06)}
        position={[4.8, 0.46, -4.4]}
        material={m.wood}
        castShadow
        receiveShadow
      />
      <mesh
        geometry={g.box(2.7, 0.05, 0.7, 0.02)}
        position={[4.8, 0.945, -4.42]}
        material={m.deskTop}
      />
      <mesh
        geometry={g.box(2.5, 0.02, 0.02, 0.008)}
        position={[4.8, 0.1, -4.08]}
        material={m.glow.accent}
      />
      {/* Coffee machine (in front of spot pantry:2) */}
      <group position={[5.3, 0.97, -4.5]}>
        <mesh
          geometry={g.box(0.38, 0.5, 0.34, 0.06)}
          position-y={0.25}
          material={m.joint}
          castShadow
        />
        <mesh
          geometry={g.box(0.22, 0.07, 0.02, 0.012)}
          position={[0, 0.38, 0.175]}
          material={m.glow.accent}
        />
        <mesh
          geometry={g.box(0.2, 0.03, 0.16, 0.01)}
          position={[0, 0.05, 0.12]}
          material={m.metal}
        />
        <mesh
          geometry={g.cylinder(0.04, 0.035, 0.08, 14)}
          position={[0, 0.1, 0.12]}
          material={m.shell}
        />
      </group>
      {/* Cups, kettle and a fruit bowl (in front of spot pantry:1) */}
      {[3.75, 3.92, 4.09].map((x, i) => (
        <mesh
          key={x}
          geometry={g.cylinder(0.04, 0.035, 0.09, 14)}
          position={[x, 1.015, -4.3]}
          material={i === 1 ? m.glow.secondary : m.shell}
        />
      ))}
      <mesh
        geometry={g.cylinder(0.08, 0.1, 0.2, 16)}
        position={[4.45, 1.07, -4.5]}
        material={m.metal}
      />
      <mesh
        geometry={g.cylinder(0.16, 0.1, 0.07, 18)}
        position={[6.0, 1.005, -4.45]}
        material={m.shell}
      />
      {[-0.06, 0.05, 0].map((dx, i) => (
        <mesh
          key={i}
          geometry={g.sphere(0.05, 10, 8)}
          position={[6.0 + dx, 1.07, -4.45 + (i - 1) * 0.04]}
          material={i === 2 ? m.plant : m.glow.accent}
        />
      ))}
      {/* Fridge */}
      <group position={[6.55, 0, -4.38]}>
        <mesh
          geometry={g.box(0.72, 1.8, 0.7, 0.07)}
          position-y={0.9}
          material={m.shellShade}
          castShadow
        />
        <mesh
          geometry={g.box(0.7, 0.012, 0.012, 0.004)}
          position={[0, 1.12, 0.355]}
          material={m.trim}
        />
        <mesh
          geometry={g.box(0.03, 0.3, 0.03, 0.01)}
          position={[-0.26, 1.42, 0.37]}
          material={m.metal}
        />
        <mesh
          geometry={g.box(0.03, 0.4, 0.03, 0.01)}
          position={[-0.26, 0.75, 0.37]}
          material={m.metal}
        />
        <mesh
          geometry={g.box(0.16, 0.06, 0.01, 0.01)}
          position={[0.15, 1.5, 0.36]}
          material={m.glow.primary}
        />
      </group>
      {/* High table and stools (spot pantry:3 stands at its west side) */}
      <group position={[6.1, 0, -2.5]}>
        <mesh
          geometry={g.cylinder(0.38, 0.38, 0.05, 24)}
          position-y={1.02}
          material={m.deskTop}
          castShadow
        />
        <mesh
          geometry={g.cylinder(0.04, 0.2, 1.0, 12)}
          position-y={0.5}
          material={m.metal}
        />
        <mesh
          geometry={g.cylinder(0.04, 0.035, 0.09, 14)}
          position={[-0.1, 1.09, 0.08]}
          material={m.shell}
        />
        {[-0.32, 0.32].map((dz) => (
          <group key={dz} position={[0.55, 0, dz]}>
            <mesh
              geometry={g.cylinder(0.025, 0.12, 0.72, 10)}
              position-y={0.36}
              material={m.metal}
            />
            <mesh
              geometry={g.cylinder(0.17, 0.16, 0.07, 18)}
              position-y={0.74}
              material={m.fabric}
            />
          </group>
        ))}
      </group>
    </group>
  )
}

/** Wall shelves above the pantry counter (back wall; same local frame as Pantry). */
export function PantryShelves() {
  const m = useSceneMaterials()
  return (
    <group position={[4.75, 0, -4.86]}>
      {[1.55, 1.95].map((y, row) => (
        <group key={y} position-y={y}>
          <mesh geometry={g.box(2.3, 0.04, 0.24, 0.015)} material={m.wood} />
          {[-0.9, -0.55, -0.2, 0.25, 0.6, 0.95].map((x, i) => (
            <mesh
              key={x}
              geometry={
                i % 2
                  ? g.cylinder(0.05, 0.05, 0.16, 12)
                  : g.box(0.12, 0.18, 0.1, 0.02)
              }
              position={[x, 0.1, 0.02]}
              material={
                (i + row) % 3 === 0
                  ? m.glow.secondary
                  : (i + row) % 3 === 1
                    ? m.shell
                    : m.pot
              }
            />
          ))}
        </group>
      ))}
      <mesh
        geometry={g.box(2.3, 0.015, 0.015, 0.005)}
        position={[0, 1.5, 0.12]}
        material={m.glow.accent}
      />
    </group>
  )
}

/**
 * Rest corner of the Gaming & Rest Lounge: sofa with two seats, a lounge
 * chair, coffee table, rug and floor lamp, in local coordinates (building.tsx
 * places it with LOUNGE_OFFSET). Seats lounge:1–3 face the room (-x).
 */
export function Lounge() {
  const m = useSceneMaterials()
  return (
    <group>
      <mesh
        geometry={g.circle(1.35, 36)}
        rotation-x={-Math.PI / 2}
        position={[5.7, 0.007, -2.2]}
        scale={[0.85, 1.25, 1]}
        material={m.floorInset}
        receiveShadow
      />
      <Sofa position={[6.4, 0, -1.65]} rotationY={-Math.PI / 2} length={1.4} />
      <Sofa position={[6.4, 0, -3.3]} rotationY={-Math.PI / 2} length={0.75} />
      {/* Cushions */}
      {[-1.95, -1.35].map((z, i) => (
        <mesh
          key={z}
          geometry={g.box(0.1, 0.24, 0.3, 0.05)}
          position={[6.6, 0.55, z]}
          rotation-y={i ? 0.1 : -0.1}
          material={i ? m.glow.secondary : m.pot}
        />
      ))}
      {/* Coffee table */}
      <group position={[5.0, 0, -2.0]}>
        <mesh
          geometry={g.cylinder(0.3, 0.3, 0.05, 24)}
          position-y={0.38}
          material={m.wood}
          castShadow
        />
        <mesh
          geometry={g.cylinder(0.05, 0.12, 0.36, 12)}
          position-y={0.18}
          material={m.metal}
        />
        <mesh
          geometry={g.cylinder(0.045, 0.04, 0.09, 14)}
          position={[0.08, 0.45, 0.04]}
          material={m.shell}
        />
        <mesh
          geometry={g.box(0.18, 0.03, 0.13, 0.01)}
          position={[-0.08, 0.42, -0.05]}
          rotation-y={0.3}
          material={m.glow.secondary}
        />
      </group>
      {/* Side table between sofa and chair, with a small plant */}
      <group position={[6.5, 0, -2.68]}>
        <mesh
          geometry={g.cylinder(0.16, 0.16, 0.04, 18)}
          position-y={0.5}
          material={m.wood}
        />
        <mesh
          geometry={g.cylinder(0.03, 0.06, 0.48, 10)}
          position-y={0.24}
          material={m.metal}
        />
        <mesh
          geometry={g.cylinder(0.07, 0.06, 0.1, 12)}
          position-y={0.57}
          material={m.pot}
        />
        <mesh
          geometry={g.sphere(0.1, 10, 8)}
          position-y={0.7}
          material={m.plant}
        />
      </group>
      {/* Floor lamp (warm, soft) */}
      <group position={[6.55, 0, -0.78]}>
        <mesh
          geometry={g.cylinder(0.12, 0.14, 0.03, 18)}
          position-y={0.015}
          material={m.metal}
        />
        <mesh
          geometry={g.cylinder(0.012, 0.012, 1.45, 6)}
          position-y={0.74}
          material={m.metal}
        />
        <mesh
          geometry={g.cylinder(0.14, 0.2, 0.22, 18)}
          position-y={1.5}
          material={m.glow.accent}
        />
      </group>
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

/**
 * Meeting Room centerpiece: a long conference table with a hologram and
 * eight chairs (seats meeting:1–8), positioned from the navigation data so
 * seats and furniture can never drift apart.
 */
export function ConferenceTable() {
  const m = useSceneMaterials()
  const { x, z, width, depth } = MEETING_TABLE
  return (
    <group>
      <mesh
        geometry={g.box(width + 2.2, 0.012, depth + 2.2, 0.3)}
        position={[x, 0.006, z]}
        material={m.floorInset}
        receiveShadow
      />
      <group position={[x, 0, z]}>
        <mesh
          geometry={g.box(width, 0.07, depth, 0.2)}
          position-y={0.66}
          material={m.wood}
          castShadow
          receiveShadow
        />
        {[-width / 2 + 0.45, width / 2 - 0.45].map((dx) => (
          <mesh
            key={dx}
            geometry={g.box(0.12, 0.62, depth * 0.6, 0.04)}
            position={[dx, 0.31, 0]}
            material={m.metal}
          />
        ))}
        <mesh
          geometry={g.box(width - 0.3, 0.012, 0.03, 0.006)}
          position={[0, 0.7, 0]}
          material={m.glow.secondary}
        />
        {/* Hologram */}
        <mesh
          geometry={g.cylinder(0.14, 0.16, 0.03, 20)}
          position-y={0.71}
          material={m.metal}
        />
        <mesh
          geometry={g.sphere(0.2, 16, 12)}
          position-y={1.05}
          material={m.screen.secondary}
        />
        <mesh
          geometry={g.torus(0.27, 0.008, Math.PI * 2, 6, 32)}
          position-y={1.05}
          rotation-x={Math.PI / 2}
          material={m.glow.secondary}
        />
      </group>
      {MEETING_CHAIRS.map((c, i) => (
        <Chair key={i} position={[c.x, 0, c.z]} rotationY={c.heading} />
      ))}
    </group>
  )
}

/**
 * Three gaming stations along the lounge's back wall: a desk with a curved
 * glowing screen, a controller and a gaming chair (seats gaming:1–3).
 */
export function GamingStations() {
  const m = useSceneMaterials()
  const glows: GlowKey[] = ["primary", "accent", "secondary"]
  return (
    <group>
      <mesh
        geometry={g.box(4.4, 0.012, 2.2, 0.2)}
        position={[4.9, 0.006, -5.3]}
        material={m.floorInset}
        receiveShadow
      />
      {GAMING_CHAIRS.map((c, i) => (
        <group key={c.x}>
          <group position={[c.x, 0, -6.0]}>
            <mesh
              geometry={g.box(1.0, 0.06, 0.6, 0.03)}
              position-y={0.72}
              material={m.deskTop}
              castShadow
            />
            {[-0.42, 0.42].map((dx) => (
              <mesh
                key={dx}
                geometry={g.box(0.06, 0.7, 0.5, 0.02)}
                position={[dx, 0.35, 0]}
                material={m.metal}
              />
            ))}
            {/* Screen */}
            <group position={[0, 1.1, -0.12]}>
              <mesh
                geometry={g.box(0.86, 0.5, 0.05, 0.03)}
                material={m.joint}
              />
              <mesh
                geometry={g.box(0.8, 0.44, 0.006, 0.02)}
                position-z={0.028}
                material={m.screen[glows[i]]}
              />
              <mesh
                geometry={g.box(0.8, 0.02, 0.01, 0.005)}
                position={[0, -0.27, 0.03]}
                material={m.glow[glows[i]]}
              />
            </group>
            <mesh
              geometry={g.cylinder(0.03, 0.06, 0.32, 10)}
              position={[0, 0.9, -0.12]}
              material={m.metal}
            />
            {/* Controller */}
            <mesh
              geometry={g.box(0.18, 0.035, 0.09, 0.02)}
              position={[0.12, 0.77, 0.12]}
              material={m.glow[glows[i]]}
            />
          </group>
          <Chair position={[c.x, 0, c.z]} rotationY={c.heading} />
        </group>
      ))}
    </group>
  )
}

/** Glowing header over a doorway, colored per room. */
export function DoorSign({
  x,
  z,
  width,
  glow,
}: {
  x: number
  z: number
  width: number
  glow: GlowKey
}) {
  const m = useSceneMaterials()
  return (
    <group position={[x, 0, z]}>
      <mesh
        geometry={g.box(width + 0.1, 0.1, 0.1, 0.03)}
        position-y={2.05}
        material={m.metal}
      />
      <mesh
        geometry={g.box(width - 0.1, 0.03, 0.12, 0.01)}
        position-y={2.05}
        material={m.glow[glow]}
      />
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          geometry={g.box(0.06, 2.05, 0.08, 0.02)}
          position={[(side * (width + 0.04)) / 2, 1.025, 0]}
          material={m.metal}
        />
      ))}
    </group>
  )
}
