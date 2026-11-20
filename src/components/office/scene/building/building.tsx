"use client"

import type { EmployeeStatus } from "@/config/employee-status"
import type { FloorId, OfficeEmployeeId } from "@/config/office"

import { BUILDING } from "../camera-framing"
import { g } from "../character/geometry"
import { useSceneMaterials } from "../materials"
import { Batch } from "../shared/batch"

import {
  Column,
  Plant,
  Railing,
  SkylineWindow,
  Sofa,
  Staircase,
} from "./architecture"
import {
  AnalyticsWall,
  CalendarWall,
  CoffeeBar,
  HotDesks,
  MeetingTable,
  OperationsBoard,
  ProjectBoard,
  Reception,
  WallPanels,
} from "./furniture"

const W = BUILDING.width
const D = BUILDING.depth
const HW = W / 2
const HD = D / 2
const FH = BUILDING.floorHeight
const EDGE = BUILDING.mezzanineEdge
const MEZZ_DEPTH = EDGE + HD
const UPPER = BUILDING.wallHeight - FH

/**
 * Staircase along the left wall (the far side from the camera, so it never
 * hides anyone): x center, bottom step z; 12 steps up to the mezzanine edge.
 */
export const STAIRS = { x: -6.35, bottomZ: 4.6, steps: 12, width: 1.0 } as const
const STEP_RISE = FH / STAIRS.steps
const STEP_RUN = (STAIRS.bottomZ - EDGE) / STAIRS.steps

/**
 * Deskverse HQ: an open-front isometric cutaway with two physically stacked
 * floors. Floor 1 fills the footprint; Floor 2 is a mezzanine over the back,
 * overlooking the atrium where the Floor 1 desks sit, joined by a staircase.
 *
 * Each floor's architecture is static and batched into a few draw calls.
 * Floor 2's parts are rendered inside its FloorGroup so they lift away together.
 */
export function Building({
  floor,
  statuses,
}: {
  floor: FloorId
  statuses: Record<OfficeEmployeeId, EmployeeStatus>
}) {
  return floor === 1 ? <FloorOne /> : <FloorTwo statuses={statuses} />
}

function FloorOne() {
  const m = useSceneMaterials()
  return (
    <Batch>
      {/* Base plinth and floor slab */}
      <mesh
        geometry={g.box(W + 0.5, 0.36, D + 0.5, 0.08)}
        position-y={-0.48}
        material={m.trim}
        receiveShadow
      />
      <mesh
        geometry={g.box(W, 0.3, D, 0.05)}
        position-y={-0.15}
        material={m.floor}
        receiveShadow
      />
      {/* Hallways linking the work areas */}
      <mesh
        geometry={g.box(W - 1.4, 0.012, 0.95, 0.006)}
        position={[-0.4, 0.006, 2.5]}
        material={m.floorInset}
        receiveShadow
      />
      <mesh
        geometry={g.box(W - 1.4, 0.012, 0.8, 0.006)}
        position={[-0.4, 0.006, -0.95]}
        material={m.floorInset}
        receiveShadow
      />
      <mesh
        geometry={g.box(0.8, 0.012, 3.0, 0.006)}
        position={[0.43, 0.006, 0.8]}
        material={m.floorInset}
        receiveShadow
      />
      {/* Glowing edges on the open sides */}
      <mesh
        geometry={g.box(W, 0.03, 0.025, 0.01)}
        position={[0, -0.02, HD + 0.01]}
        material={m.glow.primary}
      />
      <mesh
        geometry={g.box(0.025, 0.03, D, 0.01)}
        position={[HW + 0.01, -0.02, 0]}
        material={m.glow.primary}
      />

      {/* Lower walls (back and left) */}
      <mesh
        geometry={g.box(W + 0.4, FH, 0.2, 0.04)}
        position={[0, FH / 2, -HD - 0.1]}
        material={m.wall}
        receiveShadow
      />
      <mesh
        geometry={g.box(0.2, FH, D, 0.04)}
        position={[-HW - 0.1, FH / 2, 0]}
        material={m.wall}
        receiveShadow
      />
      <mesh
        geometry={g.box(W, 0.025, 0.02, 0.008)}
        position={[0, 0.1, -HD + 0.01]}
        material={m.glow.primary}
      />
      <mesh
        geometry={g.box(0.02, 0.025, D, 0.008)}
        position={[-HW + 0.01, 0.1, 0]}
        material={m.glow.primary}
      />

      {/* Atrium windows on the left wall */}
      <group position={[-HW + 0.03, 1.85, 1.15]} rotation-y={Math.PI / 2}>
        <SkylineWindow width={2.6} height={1.9} seed={1} />
      </group>
      <group position={[-HW + 0.03, 1.85, 3.75]} rotation-y={Math.PI / 2}>
        <SkylineWindow width={1.9} height={1.9} seed={3} />
      </group>
      {/* Decorative panels under the mezzanine */}
      <group position={[-3.1, 1.45, -HD + 0.04]}>
        <WallPanels count={9} />
      </group>

      {/* Mezzanine columns */}
      {[-2.73, 0.43, 3.58].map((x) => (
        <group key={x} position={[x, 0, EDGE - 0.2]}>
          <Column height={FH - 0.3} />
        </group>
      ))}

      {/* Staircase to Floor 2 */}
      <group position={[STAIRS.x, 0, STAIRS.bottomZ]}>
        <Staircase
          steps={STAIRS.steps}
          rise={STEP_RISE}
          run={STEP_RUN}
          width={STAIRS.width}
        />
      </group>

      {/* Front of house */}
      <group position={[4.75, 0, 3.9]}>
        <Reception />
      </group>
      <group position={[-1.2, 0, 3.8]}>
        <MeetingTable />
      </group>

      {/* Under the mezzanine */}
      <group position={[0.9, 0, -2.6]}>
        <ProjectBoard />
      </group>
      <group position={[-4.6, 0, -3.1]}>
        <HotDesks />
      </group>
      <group position={[4.7, 0, -4.35]}>
        <CoffeeBar />
      </group>

      <Plant position={[-6.4, 0, -4.4]} tall />
      <Plant position={[-6.35, 0, 0.7]} scale={0.8} />
      <Plant position={[-5.15, 0, 4.4]} />
      <Plant position={[2.1, 0, 4.4]} scale={0.85} />
      <Plant position={[6.45, 0, 2.3]} scale={0.8} />
      <Plant position={[-2.0, 0, -4.45]} scale={0.9} />
    </Batch>
  )
}

function FloorTwo({
  statuses,
}: {
  statuses: Record<OfficeEmployeeId, EmployeeStatus>
}) {
  const m = useSceneMaterials()
  const zMid = -HD + MEZZ_DEPTH / 2
  return (
    <>
      <Batch>
        {/* Mezzanine slab with an edge light and downlights underneath */}
        <mesh
          geometry={g.box(W, 0.3, MEZZ_DEPTH, 0.05)}
          position={[0, -0.15, zMid]}
          material={m.floor}
          castShadow
          receiveShadow
        />
        <mesh
          geometry={g.box(W, 0.035, 0.02, 0.01)}
          position={[0, -0.16, EDGE + 0.01]}
          material={m.glow.primary}
        />
        {[-5, -2.5, 0, 2.5, 5].map((x) => (
          <mesh
            key={x}
            geometry={g.circle(0.13, 16)}
            position={[x, -0.305, EDGE - 1.6]}
            rotation-x={Math.PI / 2}
            material={m.glow.accent}
          />
        ))}
        <mesh
          geometry={g.box(10.3, 0.012, 0.8, 0.006)}
          position={[0.45, 0.006, -1.05]}
          material={m.floorInset}
          receiveShadow
        />

        {/* Upper walls (they lift away with this floor) */}
        <mesh
          geometry={g.box(W + 0.4, UPPER, 0.2, 0.04)}
          position={[0, UPPER / 2, -HD - 0.1]}
          material={m.wall}
          receiveShadow
        />
        <mesh
          geometry={g.box(0.2, UPPER, D, 0.04)}
          position={[-HW - 0.1, UPPER / 2, 0]}
          material={m.wall}
          receiveShadow
        />
        <mesh
          geometry={g.box(W + 0.4, 0.04, 0.04, 0.015)}
          position={[0, UPPER + 0.01, -HD]}
          material={m.glow.secondary}
        />
        <mesh
          geometry={g.box(0.04, 0.04, D, 0.015)}
          position={[-HW, UPPER + 0.01, 0]}
          material={m.glow.secondary}
        />
        <mesh
          geometry={g.box(W, 0.025, 0.02, 0.008)}
          position={[0, 0.1, -HD + 0.01]}
          material={m.glow.primary}
        />
        {/* Tall atrium window above the Floor 1 desks */}
        <group position={[-HW + 0.03, 1.75, 2.3]} rotation-y={Math.PI / 2}>
          <SkylineWindow width={4.6} height={2.6} seed={2} />
        </group>

        {/* Glass railings along the open edges (gap where the stairs arrive) */}
        <Railing
          from={[STAIRS.x + STAIRS.width / 2 + 0.1, EDGE]}
          to={[HW - 0.05, EDGE]}
        />
        <Railing from={[HW, EDGE]} to={[HW, -HD]} />

        {/* Calendar and analytics walls */}
        <group position={[-HW + 0.06, 1.75, -2.4]} rotation-y={Math.PI / 2}>
          <CalendarWall />
        </group>
        <group position={[4.4, 1.85, -HD + 0.07]}>
          <AnalyticsWall />
        </group>
        <group position={[-4.9, 1.6, -HD + 0.04]}>
          <WallPanels count={7} height={2.0} />
        </group>

        {/* Lounge, at the quiet end of the mezzanine */}
        <group position={[6.4, 0, -1.65]}>
          <Sofa position={[0, 0, 0]} rotationY={-Math.PI / 2} length={1.4} />
        </group>
        <group position={[5.45, 0, -1.65]}>
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
        </group>

        <Plant position={[6.45, 0, -4.45]} tall />
        <Plant position={[-6.45, 0, -4.45]} />
        <Plant position={[1.95, 0, -4.5]} scale={0.8} />
      </Batch>

      {/* The operations board shows live statuses, so it re-batches when they change. */}
      <group position={[-0.15, 1.95, -HD + 0.08]}>
        <Batch version={JSON.stringify(statuses)}>
          <OperationsBoard statuses={statuses} />
        </Batch>
      </group>
    </>
  )
}
