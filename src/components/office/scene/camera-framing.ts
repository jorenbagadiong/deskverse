/**
 * Camera framing as pure math (no three.js): which box each view mode must
 * show, and the orthographic zoom that fits it. Unit-tested in tests/camera.test.ts.
 */
import {
  OFFICE_BOUNDS,
  ROOMS,
  type RoomBounds,
  type ViewMode,
} from "@/config/office"

export type { ViewMode }

export const VIEW_MODES: readonly ViewMode[] = [
  "office",
  "operations",
  "pantry",
  "lounge",
  "meeting",
]

/** One floor: footprint from the room layout, walls one story high. */
export const OFFICE = {
  width: OFFICE_BOUNDS.x1 - OFFICE_BOUNDS.x0,
  depth: OFFICE_BOUNDS.z1 - OFFICE_BOUNDS.z0,
  wallHeight: 3.0,
} as const

export type Vec3 = readonly [number, number, number]
export type Box = { min: Vec3; max: Vec3 }

const boxOf = (b: RoomBounds, height: number): Box => ({
  min: [b.x0, 0, b.z0],
  max: [b.x1, height, b.z1],
})

/** The region each view must keep in view. */
export function framingBox(mode: ViewMode): Box {
  // People and furniture stand about 2.2 units tall; walls are taller.
  if (mode === "office") return boxOf(OFFICE_BOUNDS, OFFICE.wallHeight)
  return boxOf(ROOMS[mode].bounds, 2.2)
}

export const boxCenter = (box: Box): Vec3 => [
  (box.min[0] + box.max[0]) / 2,
  (box.min[1] + box.max[1]) / 2,
  (box.min[2] + box.max[2]) / 2,
]

/** Camera basis for an orbit at (polar, azimuth), matching three.js Spherical. */
export function cameraAxes(polar: number, azimuth: number) {
  const d: Vec3 = [
    Math.sin(polar) * Math.sin(azimuth),
    Math.cos(polar),
    Math.sin(polar) * Math.cos(azimuth),
  ]
  // Looking along -d with world-up (0,1,0).
  const rl = Math.hypot(d[2], d[0])
  const right: Vec3 = [d[2] / rl, 0, -d[0] / rl]
  const f: Vec3 = [-d[0], -d[1], -d[2]]
  const up: Vec3 = [
    right[1] * f[2] - right[2] * f[1],
    right[2] * f[0] - right[0] * f[2],
    right[0] * f[1] - right[1] * f[0],
  ]
  return { forward: f, right, up }
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Orthographic zoom (px per unit) that fits `box` in a `width × height` viewport. */
export function fitZoom(
  box: Box,
  width: number,
  height: number,
  polar: number,
  azimuth: number,
  margin = 1.08,
) {
  const { right, up } = cameraAxes(polar, azimuth)
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const x of [box.min[0], box.max[0]])
    for (const y of [box.min[1], box.max[1]])
      for (const z of [box.min[2], box.max[2]]) {
        const p: Vec3 = [x, y, z]
        const px = dot(p, right)
        const py = dot(p, up)
        minX = Math.min(minX, px)
        maxX = Math.max(maxX, px)
        minY = Math.min(minY, py)
        maxY = Math.max(maxY, py)
      }
  const spanX = (maxX - minX) * margin
  const spanY = (maxY - minY) * margin
  return Math.max(4, Math.min(width / spanX, height / spanY))
}

/**
 * Where to look when an employee is selected: most of the way toward them
 * (so they come forward), at about chest height.
 */
export function focusTarget(mode: ViewMode, point: Vec3 | null): Vec3 {
  const center = boxCenter(framingBox(mode))
  if (!point) return center
  const k = 0.7
  return [
    center[0] + (point[0] - center[0]) * k,
    point[1] + 0.8,
    center[2] + (point[2] - center[2]) * k,
  ]
}

/** Extra zoom applied when focusing a single employee. */
export const FOCUS_ZOOM = 1.45

/**
 * Signed shortest rotation from angle `from` to `to`, in (-π, π].
 * Lets the camera (and walkers) turn the short way across the 0°/360° seam.
 */
export function shortestAngle(from: number, to: number) {
  let d = (to - from) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d <= -Math.PI) d += Math.PI * 2
  return d
}

/** One press of "Rotate left/right": 18°, so 20 presses make a full turn. */
export const ROTATE_STEP = Math.PI / 10

/**
 * How much a wall faces the camera (cosine between the wall's outward x/z
 * normal and the direction from the orbit target to the camera). Positive
 * means the camera is behind the wall, looking through it.
 */
export function wallFacesCamera(
  outward: readonly [number, number],
  camX: number,
  camZ: number,
) {
  const len = Math.hypot(camX, camZ) || 1
  return (outward[0] * camX + outward[1] * camZ) / len
}

/** Hide/show thresholds; the gap between them avoids flicker while orbiting. */
export const WALL_HIDE_AT = 0.12
export const WALL_SHOW_AT = 0.02

export function nextWallHidden(hidden: boolean, facing: number) {
  if (!hidden && facing > WALL_HIDE_AT) return true
  if (hidden && facing < WALL_SHOW_AT) return false
  return hidden
}

export const BACK_WALL: readonly [number, number] = [0, -1]
export const LEFT_WALL: readonly [number, number] = [-1, 0]
