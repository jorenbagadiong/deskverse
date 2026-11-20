"use client"

import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { OrbitControls, OrthographicCamera } from "@react-three/drei"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"

import type { OfficeEmployeeId } from "@/config/office"
import type { LiveStore } from "@/lib/office-live"

import {
  boxCenter,
  FOCUS_ZOOM,
  fitZoom,
  focusTarget,
  framingBox,
  ROTATE_STEP,
  shortestAngle,
  type Vec3,
  type ViewMode,
} from "./camera-framing"
import { frameDelta } from "./frame-delta"

type OrbitControlsImpl = React.ComponentRef<typeof OrbitControls>

/** Imperative camera API used by the DOM control buttons. */
export type CameraApi = {
  reset: () => void
  rotate: (direction: -1 | 1) => void
  zoom: (direction: -1 | 1) => void
}

/** True isometric angle: elevation ≈ 35.26°, i.e. polar = acos(1/√3). */
export const ISO_POLAR = Math.acos(1 / Math.sqrt(3))
export const INITIAL_AZIMUTH = Math.PI / 4

export const CAMERA_LIMITS = {
  // Never flatter than ~24° above the floor, never straight down.
  minPolar: 0.55,
  maxPolar: 1.15,
  // Horizontal rotation is unrestricted (360°); walls facing the camera hide.
  // Relative to the zoom that fits the current view mode.
  minZoomFactor: 0.8,
  maxZoomFactor: 3.2,
} as const

const ORBIT_RADIUS = 40
export { ROTATE_STEP }
const ZOOM_STEP = 1.3

type Goal = {
  azimuth?: number
  polar?: number
  zoom?: number
  target?: THREE.Vector3
}

const clamp = THREE.MathUtils.clamp
const toVector = (v: Vec3) => new THREE.Vector3(v[0], v[1], v[2])

/**
 * OrbitControls keeps drag momentum while damping is on. If a drag ends against
 * an angle limit, the camera can't move, rendering stops (demand mode) and the
 * leftover momentum stays frozen, later nudging programmatic moves such as
 * Reset. One undamped update consumes it; then the pose is restored so the
 * flush is invisible.
 */
function flushMomentum(
  c: OrbitControlsImpl,
  camera: THREE.Camera,
  saved: THREE.Vector3,
  damping: boolean,
) {
  saved.copy(camera.position)
  c.enableDamping = false
  c.update()
  camera.position.copy(saved)
  c.enableDamping = damping
  c.update()
}

export function CameraRig({
  ref,
  mode,
  focusId,
  live,
  reducedMotion,
}: {
  ref: React.Ref<CameraApi>
  mode: ViewMode
  /** Selected employee: the camera frames their live position and follows walks. */
  focusId: OfficeEmployeeId | null
  live: React.RefObject<LiveStore>
  reducedMotion: boolean
}) {
  const controls = useRef<OrbitControlsImpl>(null)
  // Read the camera from the store at use time: drei's makeDefault swaps it in after mount.
  const get = useThree((s) => s.get)
  const size = useThree((s) => s.size)
  const invalidate = useThree((s) => s.invalidate)
  const goal = useRef<Goal | null>(null)
  const zoomRatio = useRef(1)

  const base = fitZoom(
    framingBox(mode),
    size.width,
    size.height,
    ISO_POLAR,
    INITIAL_AZIMUTH,
  )
  const baseRef = useRef(base)
  useLayoutEffect(() => {
    baseRef.current = base
  }, [base])

  // Initial camera pose (props are applied once; later moves are tweens).
  const [initial] = useState(() => {
    const target = boxCenter(framingBox(mode))
    const position = new THREE.Vector3()
      .setFromSpherical(
        new THREE.Spherical(ORBIT_RADIUS, ISO_POLAR, INITIAL_AZIMUTH),
      )
      .add(toVector(target))
    return { target, position: position.toArray(), zoom: base }
  })

  // Viewport resize (including fullscreen): keep the user's relative zoom, no tween.
  const lastSize = useRef({ width: size.width, height: size.height })
  useLayoutEffect(() => {
    if (
      lastSize.current.width === size.width &&
      lastSize.current.height === size.height
    )
      return
    lastSize.current = { width: size.width, height: size.height }
    const camera = get().camera
    camera.zoom = baseRef.current * zoomRatio.current
    camera.updateProjectionMatrix()
    invalidate()
  }, [size.width, size.height, get, invalidate])

  // Mode or selection changed: glide to the employee's actual position.
  useEffect(() => {
    const e = focusId ? live.current.get(focusId) : undefined
    const point: Vec3 | null = e ? [e.x, e.y, e.z] : null
    goal.current = {
      ...goal.current,
      target: toVector(focusTarget(mode, point)),
      zoom: baseRef.current * (point ? FOCUS_ZOOM : 1),
    }
    invalidate()
  }, [mode, focusId, live, invalidate])

  useImperativeHandle(
    ref,
    () => ({
      reset() {
        const e = focusId ? live.current.get(focusId) : undefined
        const point: Vec3 | null = e ? [e.x, e.y, e.z] : null
        goal.current = {
          azimuth: INITIAL_AZIMUTH,
          polar: ISO_POLAR,
          zoom: baseRef.current * (point ? FOCUS_ZOOM : 1),
          target: toVector(focusTarget(mode, point)),
        }
        invalidate()
      },
      rotate(direction) {
        const c = controls.current
        if (!c) return
        // Unbounded: tweens always take the short way across the 0°/360° seam.
        const from = goal.current?.azimuth ?? c.getAzimuthalAngle()
        goal.current = {
          ...goal.current,
          azimuth: from + direction * ROTATE_STEP,
        }
        invalidate()
      },
      zoom(direction) {
        const from = goal.current?.zoom ?? get().camera.zoom
        const b = baseRef.current
        goal.current = {
          ...goal.current,
          zoom: clamp(
            direction > 0 ? from * ZOOM_STEP : from / ZOOM_STEP,
            b * CAMERA_LIMITS.minZoomFactor,
            b * CAMERA_LIMITS.maxZoomFactor,
          ),
        }
        invalidate()
      },
    }),
    [mode, focusId, live, get, invalidate],
  )

  const savedPosition = useRef(new THREE.Vector3())
  const spherical = useRef(new THREE.Spherical())
  const offset = useRef(new THREE.Vector3())

  useFrame(({ camera }, rawDelta) => {
    const c = controls.current
    if (!c) return
    // Follow the selected employee while they walk.
    if (focusId) {
      const e = live.current.get(focusId)
      if (e?.moving)
        goal.current = {
          ...goal.current,
          target: toVector(focusTarget(mode, [e.x, e.y, e.z])),
        }
    }
    const g = goal.current
    if (!g) return
    flushMomentum(c, camera, savedPosition.current, !reducedMotion)
    const delta = frameDelta(rawDelta)
    const step = (from: number, to: number) =>
      reducedMotion ? to : THREE.MathUtils.damp(from, to, 6, delta)

    const currentAzimuth = c.getAzimuthalAngle()
    // Unwrap the goal next to the current angle so the camera never spins the long way.
    const goalAzimuth =
      g.azimuth === undefined
        ? currentAzimuth
        : currentAzimuth + shortestAngle(currentAzimuth, g.azimuth)
    const azimuth = step(currentAzimuth, goalAzimuth)
    const polar = step(c.getPolarAngle(), g.polar ?? c.getPolarAngle())
    const zoom = step(camera.zoom, g.zoom ?? camera.zoom)
    if (g.target) {
      c.target.set(
        step(c.target.x, g.target.x),
        step(c.target.y, g.target.y),
        step(c.target.z, g.target.z),
      )
    }

    spherical.current.set(ORBIT_RADIUS, polar, azimuth)
    offset.current.setFromSpherical(spherical.current)
    camera.position.copy(c.target).add(offset.current)
    camera.zoom = zoom
    camera.updateProjectionMatrix()
    c.update()

    const settled =
      Math.abs(azimuth - goalAzimuth) < 2e-3 &&
      Math.abs(polar - (g.polar ?? polar)) < 2e-3 &&
      Math.abs(zoom - (g.zoom ?? zoom)) < 0.25 &&
      (!g.target || c.target.distanceTo(g.target) < 5e-3)

    if (settled) {
      // Snap exactly onto the goal so tweens end cleanly (and reset is exact).
      if (g.target) c.target.copy(g.target)
      spherical.current.set(ORBIT_RADIUS, g.polar ?? polar, goalAzimuth)
      offset.current.setFromSpherical(spherical.current)
      camera.position.copy(c.target).add(offset.current)
      camera.zoom = g.zoom ?? zoom
      camera.updateProjectionMatrix()
      c.update()
      zoomRatio.current = camera.zoom / baseRef.current
      goal.current = null
    }
    invalidate()
  })

  return (
    <>
      <OrthographicCamera
        makeDefault
        position={initial.position}
        zoom={initial.zoom}
        near={0.1}
        far={120}
      />
      <OrbitControls
        ref={controls}
        makeDefault
        target={initial.target as [number, number, number]}
        enablePan={false}
        enableDamping={!reducedMotion}
        dampingFactor={0.12}
        rotateSpeed={0.6}
        zoomSpeed={0.7}
        minPolarAngle={CAMERA_LIMITS.minPolar}
        maxPolarAngle={CAMERA_LIMITS.maxPolar}
        minZoom={base * CAMERA_LIMITS.minZoomFactor}
        maxZoom={base * CAMERA_LIMITS.maxZoomFactor}
        // The user takes over: drop any programmatic tween in progress.
        onStart={() => {
          goal.current = null
        }}
        onEnd={() => {
          zoomRatio.current = get().camera.zoom / baseRef.current
        }}
      />
    </>
  )
}
