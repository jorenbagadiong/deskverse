"use client"

import type { EmployeeStatus } from "@/config/employee-status"
import {
  BACK_ROOMS_Z,
  OFFICE_BOUNDS,
  type OfficeEmployeeId,
  type RoomId,
} from "@/config/office"
import {
  CORRIDOR_Z,
  DOORWAYS,
  PARTITIONS,
  ROW2_AISLE_Z,
} from "@/lib/office-navigation"

import { OFFICE } from "../camera-framing"
import { g } from "../character/geometry"
import { useSceneMaterials, type GlowKey } from "../materials"
import { Batch } from "../shared/batch"

import { Plant, Railing, SkylineWindow } from "./architecture"
import { BACK_WALL, CameraHider, LEFT_WALL } from "./camera-hider"
import {
  AnalyticsWall,
  CalendarWall,
  ConferenceTable,
  DoorSign,
  GamingStations,
  Lounge,
  OperationsBoard,
  Pantry,
  PantryShelves,
  Reception,
  WallPanels,
} from "./furniture"

const W = OFFICE.width
const D = OFFICE.depth
const H = OFFICE.wallHeight
const { x0: X0, x1: X1, z0: Z0, z1: Z1 } = OFFICE_BOUNDS
const CX = (X0 + X1) / 2
const CZ = (Z0 + Z1) / 2

/** Pantry and lounge furniture are modeled in local frames; these place them. */
export const PANTRY_OFFSET: [number, number, number] = [-4.6, 0, -1.5]
export const LOUNGE_OFFSET: [number, number, number] = [2, 0, -2]

/** Glass partition height: reads as a wall, never hides anyone behind it. */
const PARTITION_HEIGHT = 2.0

const DOOR_GLOW: Record<Exclude<RoomId, "operations">, GlowKey> = {
  meeting: "secondary",
  pantry: "accent",
  lounge: "primary",
}

/**
 * Deskverse HQ: one large floor in an open-front isometric cutaway. The
 * Operations Room fills the front with all seven workstations; the Meeting
 * Room, Pantry and Gaming & Rest Lounge line the back, behind glass
 * partitions with doorways onto the corridor.
 *
 * Everything is static and batched into a few draw calls. The back and left
 * outer walls (and what hangs on them) hide when the camera orbits behind
 * them; interior partitions are glass, so they never hide anyone.
 */
export function Building({
  statuses,
}: {
  statuses: Record<OfficeEmployeeId, EmployeeStatus>
}) {
  const m = useSceneMaterials()
  return (
    <>
      <Batch>
        {/* Base plinth and floor slab */}
        <mesh
          geometry={g.box(W + 0.5, 0.36, D + 0.5, 0.08)}
          position={[CX, -0.48, CZ]}
          material={m.trim}
          receiveShadow
        />
        <mesh
          geometry={g.box(W, 0.3, D, 0.05)}
          position={[CX, -0.15, CZ]}
          material={m.floor}
          receiveShadow
        />
        {/* Corridor and the aisle behind desk row 2 */}
        <mesh
          geometry={g.box(W - 0.6, 0.012, 1.1, 0.006)}
          position={[CX, 0.006, CORRIDOR_Z]}
          material={m.floorInset}
          receiveShadow
        />
        <mesh
          geometry={g.box(W - 0.6, 0.012, 0.9, 0.006)}
          position={[CX, 0.006, ROW2_AISLE_Z]}
          material={m.floorInset}
          receiveShadow
        />
        {/* Glowing edges on the open sides */}
        <mesh
          geometry={g.box(W, 0.03, 0.025, 0.01)}
          position={[CX, -0.02, Z1 + 0.01]}
          material={m.glow.primary}
        />
        <mesh
          geometry={g.box(0.025, 0.03, D, 0.01)}
          position={[X1 + 0.01, -0.02, CZ]}
          material={m.glow.primary}
        />

        {/* Glass partitions between the rooms, with lit door frames */}
        {PARTITIONS.map(({ from, to }, i) => (
          <Railing
            key={i}
            from={from}
            to={to}
            height={PARTITION_HEIGHT}
            glow="secondary"
          />
        ))}
        {DOORWAYS.map((d) => (
          <DoorSign
            key={d.room}
            x={(d.x0 + d.x1) / 2}
            z={BACK_ROOMS_Z}
            width={d.x1 - d.x0}
            glow={d.room === "operations" ? "primary" : DOOR_GLOW[d.room]}
          />
        ))}

        {/* Operations Room: front of house */}
        <group position={[6.6, 0, 5.7]}>
          <Reception />
        </group>
        <Plant position={[-8.45, 0, 5.95]} tall />
        <Plant position={[8.55, 0, 4.6]} scale={0.85} />

        {/* Meeting Room */}
        <ConferenceTable />

        {/* Pantry */}
        <group position={PANTRY_OFFSET}>
          <Pantry />
        </group>
        <Plant position={[-2.5, 0, -6.0]} scale={0.9} />

        {/* Gaming & Rest Lounge */}
        <GamingStations />
        <group position={LOUNGE_OFFSET}>
          <Lounge />
        </group>
        <Plant position={[2.95, 0, -2.65]} scale={0.9} />
        <Plant position={[8.6, 0, -6.1]} tall />
      </Batch>

      {/* Outer walls hide when the camera orbits behind them (with what hangs on them). */}
      <CameraHider outward={BACK_WALL}>
        <Batch>
          <mesh
            geometry={g.box(W + 0.4, H, 0.2, 0.04)}
            position={[CX, H / 2, Z0 - 0.1]}
            material={m.wall}
            receiveShadow
          />
          <mesh
            geometry={g.box(W + 0.4, 0.04, 0.04, 0.015)}
            position={[CX, H + 0.01, Z0]}
            material={m.glow.secondary}
          />
          <mesh
            geometry={g.box(W, 0.025, 0.02, 0.008)}
            position={[CX, 0.1, Z0 + 0.01]}
            material={m.glow.primary}
          />
          <group position={[-6, 1.75, Z0 + 0.06]}>
            <CalendarWall />
          </group>
          <group position={PANTRY_OFFSET}>
            <PantryShelves />
          </group>
          <group position={[4.9, 2.2, Z0 + 0.03]}>
            <SkylineWindow width={4.2} height={1.2} seed={2} />
          </group>
        </Batch>
      </CameraHider>
      <CameraHider outward={LEFT_WALL}>
        <Batch>
          <mesh
            geometry={g.box(0.2, H, D, 0.04)}
            position={[X0 - 0.1, H / 2, CZ]}
            material={m.wall}
            receiveShadow
          />
          <mesh
            geometry={g.box(0.04, 0.04, D, 0.015)}
            position={[X0, H + 0.01, CZ]}
            material={m.glow.secondary}
          />
          <mesh
            geometry={g.box(0.02, 0.025, D, 0.008)}
            position={[X0 + 0.01, 0.1, CZ]}
            material={m.glow.primary}
          />
          <group position={[X0 + 0.03, 1.7, -4.35]} rotation-y={Math.PI / 2}>
            <SkylineWindow width={2.8} height={1.6} seed={1} />
          </group>
          <group position={[X0 + 0.07, 1.75, 5.2]} rotation-y={Math.PI / 2}>
            <AnalyticsWall />
          </group>
          <group position={[X0 + 0.04, 1.5, -1.3]} rotation-y={Math.PI / 2}>
            <WallPanels count={3} height={1.8} />
          </group>
        </Batch>
        {/* The operations board shows live statuses, so it re-batches when they change. */}
        <group position={[X0 + 0.08, 1.7, 1.6]} rotation-y={Math.PI / 2}>
          <Batch version={JSON.stringify(statuses)}>
            <OperationsBoard statuses={statuses} />
          </Batch>
        </group>
      </CameraHider>
    </>
  )
}
