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
  type OfficeEmployee,
  type OfficeEmployeeId,
} from "@/config/office"
import { cn } from "@/lib/utils"

import { Building } from "./building/building"
import { FloorGroup } from "./building/floor-group"
import { floorY, type Vec3, type ViewMode } from "./camera-framing"
import { CameraRig, type CameraApi } from "./camera-rig"
import { Character } from "./character/character"
import { SceneMaterialsProvider } from "./materials"
import { environment, type SceneTheme } from "./palette"
import { geometryCache } from "./shared/geometry-cache"
import {
  AmbientScheduler,
  type AmbientRequest,
  type AmbientStore,
} from "./shared/ambient"
import { CHARACTER_OFFSET_Z, Workstation } from "./workstation/workstation"

export type OfficeSceneProps = {
  statuses: Record<OfficeEmployeeId, EmployeeStatus>
  selectedId: OfficeEmployeeId | null
  onSelect: (id: OfficeEmployeeId) => void
  view: ViewMode
  theme: SceneTheme
  reducedMotion: boolean
  cameraRef: React.Ref<CameraApi>
}

const EMPLOYEE_IDS = officeEmployees.map((e) => e.id)

export function employeePoint(employee: OfficeEmployee): Vec3 {
  return [
    employee.desk[0],
    floorY(employee.floor),
    employee.desk[1] + CHARACTER_OFFSET_Z,
  ]
}

/** Nameplate anchors: just in front of each desk, per floor. */
const LABEL_ANCHORS = officeEmployees.map((e) => ({
  id: e.id,
  floor: e.floor,
  point: new THREE.Vector3(e.desk[0], floorY(e.floor) + 0.28, e.desk[1] + 0.62),
}))

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
}: OfficeSceneProps) {
  const [hoveredId, setHoveredId] = useState<OfficeEmployeeId | null>(null)
  const labels = useRef<LabelElements>({})
  const requests = useRef(new Map<string, AmbientRequest>())
  const active = useRef(false)
  const ambient = useMemo<AmbientStore>(() => ({ requests, active }), [])
  const env = environment[theme]
  const selected = officeEmployees.find((e) => e.id === selectedId) ?? null
  const floor2Lifted = view === "floor-1"

  // Activity-aware lifecycle: when Next.js hides this route, effects clean up.
  // Pause idle animations and release shared geometry buffers until visible again.
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      geometryCache.disposeAll()
    }
  }, [])

  const renderFloor = (floor: FloorId) =>
    employeesOnFloor(floor).map((employee) => {
      const [x, z] = employee.desk
      const status = statuses[employee.id]
      return (
        <group key={employee.id} position={[x, 0, z]}>
          <Workstation
            employee={employee}
            status={status}
            animate={status === "working" && !reducedMotion}
            onSelect={() => onSelect(employee.id)}
          />
          <Character
            employee={employee}
            status={status}
            selected={employee.id === selectedId}
            hovered={hoveredId === employee.id}
            reducedMotion={reducedMotion}
            ambient={ambient}
            position={[0, 0, CHARACTER_OFFSET_Z]}
            onSelect={() => onSelect(employee.id)}
            onHover={(hovering) =>
              setHoveredId((current) =>
                hovering
                  ? employee.id
                  : current === employee.id
                    ? null
                    : current,
              )
            }
          />
        </group>
      )
    })

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
            hiddenFloor={floor2Lifted ? 2 : null}
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
            focus={selected ? employeePoint(selected) : null}
            reducedMotion={reducedMotion}
          />

          <Building floor={1} statuses={statuses} />
          {renderFloor(1)}
          <FloorGroup
            floor={2}
            lifted={floor2Lifted}
            reducedMotion={reducedMotion}
          >
            <Building floor={2} statuses={statuses} />
            {renderFloor(2)}
          </FloorGroup>
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
 * Positions the DOM nameplates over their desks. Runs only on frames that are
 * rendered anyway and writes styles directly: no React state per frame.
 */
function LabelProjector({
  labels,
  hiddenFloor,
}: {
  labels: React.RefObject<LabelElements>
  hiddenFloor: FloorId | null
}) {
  const projected = useRef(new THREE.Vector3())
  useFrame(({ camera, size }) => {
    for (const { id, floor, point } of LABEL_ANCHORS) {
      const el = labels.current[id]
      if (!el) continue
      if (floor === hiddenFloor) {
        el.style.setProperty("opacity", "0")
        continue
      }
      const p = projected.current.copy(point).project(camera)
      const x = (p.x * 0.5 + 0.5) * size.width
      const y = (-p.y * 0.5 + 0.5) * size.height
      el.style.setProperty(
        "transform",
        `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`,
      )
      el.style.setProperty("opacity", "1")
    }
  })
  return null
}

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
