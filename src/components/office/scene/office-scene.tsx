"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js"

import type { EmployeeStatus } from "@/config/employee-status"
import {
  employeesOnFloor,
  officeEmployees,
  type FloorId,
  type OfficeEmployeeId,
} from "@/config/office"
import type { LiveStore } from "@/lib/office-live"
import { activityOf, type Movement } from "@/lib/office-movement"
import { cn } from "@/lib/utils"

import { Building } from "./building/building"
import { FloorGroup, LIFT_HEIGHT } from "./building/floor-group"
import type { ViewMode } from "./camera-framing"
import { CameraRig, type CameraApi } from "./camera-rig"
import { Character } from "./character/character"
import { SceneMaterialsProvider } from "./materials"
import { MovementSystem } from "./movement/movement-system"
import { Walker } from "./movement/walker"
import { environment, type SceneTheme } from "./palette"
import { geometryCache } from "./shared/geometry-cache"
import {
  AmbientScheduler,
  type AmbientRequest,
  type AmbientStore,
} from "./shared/ambient"
import { Workstation } from "./workstation/workstation"

export type OfficeSceneProps = {
  statuses: Record<OfficeEmployeeId, EmployeeStatus>
  selectedId: OfficeEmployeeId | null
  onSelect: (id: OfficeEmployeeId) => void
  view: ViewMode
  theme: SceneTheme
  reducedMotion: boolean
  cameraRef: React.Ref<CameraApi>
  /** Physical movement (from the reducer) and the shared live positions. */
  movement: Record<OfficeEmployeeId, Movement>
  live: React.RefObject<LiveStore>
  onArrive: (id: OfficeEmployeeId, routeId: number) => void
  onFloorChange: (id: OfficeEmployeeId, floor: FloorId) => void
}

const EMPLOYEE_IDS = officeEmployees.map((e) => e.id)

type LabelElements = Partial<Record<OfficeEmployeeId, HTMLSpanElement | null>>

/**
 * The WebGL office. Loaded with next/dynamic (ssr: false) so three.js never runs
 * on the server and doesn't block the rest of the page.
 *
 * Rendering is on demand: frames are drawn only when something changes or an
 * animation is running, not 60 times a second.
 */
export default function OfficeScene({
  statuses,
  selectedId,
  onSelect,
  view,
  theme,
  reducedMotion,
  cameraRef,
  movement,
  live,
  onArrive,
  onFloorChange,
}: OfficeSceneProps) {
  const [hoveredId, setHoveredId] = useState<OfficeEmployeeId | null>(null)
  const labels = useRef<LabelElements>({})
  const requests = useRef(new Map<string, AmbientRequest>())
  const active = useRef(false)
  const ambient = useMemo<AmbientStore>(() => ({ requests, active }), [])
  const env = environment[theme]
  const floor2Lifted = view === "floor-1"
  /** Current Floor 2 lift offset, written by its FloorGroup each frame. */
  const floor2Offset = useRef(floor2Lifted ? LIFT_HEIGHT : 0)

  // Activity-aware lifecycle: when Next.js hides this route, effects clean up.
  // Pause idle animations and release shared geometry buffers until visible again.
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      geometryCache.disposeAll()
    }
  }, [])

  const renderDesks = (floor: FloorId) =>
    employeesOnFloor(floor).map((employee) => {
      const [x, z] = employee.desk
      const status = statuses[employee.id]
      // Workstation tools animate only while their owner is working at the desk.
      const atDesk = activityOf(movement[employee.id]) === "at-desk"
      return (
        <group key={employee.id} position={[x, 0, z]}>
          <Workstation
            employee={employee}
            status={status}
            animate={status === "working" && atDesk && !reducedMotion}
            onSelect={() => onSelect(employee.id)}
          />
        </group>
      )
    })

  // Characters live at world level so they can walk between floors.
  const renderPeople = () =>
    officeEmployees.map((employee) => (
      <Walker
        key={employee.id}
        id={employee.id}
        live={live}
        floor2Offset={floor2Offset}
      >
        <Character
          employee={employee}
          status={statuses[employee.id]}
          activity={activityOf(movement[employee.id])}
          live={live}
          selected={employee.id === selectedId}
          hovered={hoveredId === employee.id}
          reducedMotion={reducedMotion}
          ambient={ambient}
          onSelect={() => onSelect(employee.id)}
          onHover={(hovering) =>
            setHoveredId((current) =>
              hovering ? employee.id : current === employee.id ? null : current,
            )
          }
        />
      </Walker>
    ))

  return (
    <div className="relative h-full w-full">
      <Canvas
        frameloop="demand"
        // PCF filtering (three r187 dropped PCFSoftShadowMap); softened via shadow radius.
        shadows="percentage"
        dpr={[1, 1.75]}
        gl={{ antialias: true, powerPreference: "default" }}
        aria-hidden="true"
        className="touch-none"
      >
        <SceneMaterialsProvider theme={theme}>
          <StudioEnvironment intensity={theme === "dark" ? 0.55 : 0.42} />
          <PointerCursor active={hoveredId !== null} />
          <LabelProjector
            labels={labels}
            live={live}
            floor2Offset={floor2Offset}
          />
          <AmbientScheduler
            store={ambient}
            ids={EMPLOYEE_IDS}
            enabled={!reducedMotion}
          />

          <hemisphereLight
            args={[env.hemiSky, env.hemiGround, env.hemiIntensity * 0.6]}
          />
          <directionalLight
            position={[8, 14, 9]}
            intensity={env.keyIntensity}
            castShadow
            shadow-mapSize={[1024, 1024]}
            shadow-radius={3}
            shadow-bias={-0.0004}
            shadow-normalBias={0.03}
            shadow-camera-left={-11}
            shadow-camera-right={11}
            shadow-camera-top={11}
            shadow-camera-bottom={-11}
            shadow-camera-near={1}
            shadow-camera-far={40}
          />

          <CameraRig
            ref={cameraRef}
            mode={view}
            focusId={selectedId}
            live={live}
            reducedMotion={reducedMotion}
          />

          <Building floor={1} statuses={statuses} />
          {renderDesks(1)}
          <FloorGroup
            floor={2}
            lifted={floor2Lifted}
            reducedMotion={reducedMotion}
            offsetRef={floor2Offset}
          >
            <Building floor={2} statuses={statuses} />
            {renderDesks(2)}
          </FloorGroup>
          {renderPeople()}
          <MovementSystem
            movement={movement}
            live={live}
            reducedMotion={reducedMotion}
            onArrive={onArrive}
            onFloorChange={onFloorChange}
          />
        </SceneMaterialsProvider>
      </Canvas>

      {/* Decorative nameplates (the DOM list carries the accessible names). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        {officeEmployees.map((employee) => (
          <span
            key={employee.id}
            ref={(el) => {
              labels.current[employee.id] = el
            }}
            className={cn(
              "absolute top-0 left-0 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap opacity-0 shadow-flat ring-1 select-none",
              employee.id === selectedId
                ? "bg-primary text-primary-foreground ring-primary"
                : "bg-surface/90 text-foreground ring-border",
            )}
          >
            {employee.name}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * Local image-based lighting: three's procedural RoomEnvironment rendered to a
 * PMREM once. Gives the glossy toy materials soft reflections with no HDR
 * download.
 */
function StudioEnvironment({ intensity }: { intensity: number }) {
  const get = useThree((s) => s.get)
  useEffect(() => {
    const { gl, scene, invalidate } = get()
    const pmrem = new THREE.PMREMGenerator(gl)
    const room = new RoomEnvironment()
    const texture = pmrem.fromScene(room, 0.04).texture
    scene.environment = texture
    scene.environmentIntensity = intensity
    invalidate()
    return () => {
      scene.environment = null
      texture.dispose()
      room.dispose()
      pmrem.dispose()
    }
  }, [get, intensity])
  return null
}

/**
 * Positions the DOM nameplates under each employee's feet, wherever they are.
 * Runs only on frames that are rendered anyway and writes styles directly: no
 * React state per frame. Floor 2 nameplates follow the floor's lift and hide
 * with it.
 */
function LabelProjector({
  labels,
  live,
  floor2Offset,
}: {
  labels: React.RefObject<LabelElements>
  live: React.RefObject<LiveStore>
  floor2Offset: React.RefObject<number>
}) {
  const projected = useRef(new THREE.Vector3())
  useFrame(({ camera, size }) => {
    for (const [id, e] of live.current) {
      const el = labels.current[id]
      if (!el) continue
      const lift = e.floor === 2 && !e.onStairs ? floor2Offset.current : 0
      if (lift > LIFT_HEIGHT * 0.5) {
        el.style.setProperty("opacity", "0")
        continue
      }
      const p = projected.current
        .set(e.x, e.y + lift + LABEL_HEIGHT, e.z)
        .project(camera)
      const x = (p.x * 0.5 + 0.5) * size.width
      const y = (-p.y * 0.5 + 0.5) * size.height + LABEL_DROP_PX
      el.style.setProperty(
        "transform",
        `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`,
      )
      el.style.setProperty("opacity", "1")
    }
  })
  return null
}

/** Nameplate anchor: just above the feet, then nudged down on screen so it never covers the body. */
const LABEL_HEIGHT = 0.05
const LABEL_DROP_PX = 14

/** Shows a pointer cursor over clickable robots. */
function PointerCursor({ active }: { active: boolean }) {
  const get = useThree((s) => s.get)
  useEffect(() => {
    const { style } = get().gl.domElement
    style.cursor = active ? "pointer" : ""
    return () => {
      style.cursor = ""
    }
  }, [active, get])
  return null
}
