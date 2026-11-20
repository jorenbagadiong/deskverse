/**
 * Camera framing as pure math (no three.js): which box each view mode must
 * show, and the orthographic zoom that fits it. Unit-tested in tests/camera.test.ts.
 */
import type { FloorId, ViewMode } from "@/config/office"

export type { ViewMode }

export const VIEW_MODES: readonly ViewMode[] = [
  "building",
  "floor-1",
  "floor-2",
]

export const BUILDING = {
  /** x extent: [-7, 7] */
  width: 14,
  /** z extent: [-5, 5] */
  depth: 10,
  /** Floor 2 sits this high above Floor 1. */
  floorHeight: 3.6,
  /** Floor 2 is a mezzanine over the back of the building: z ∈ [-5, MEZZANINE_EDGE]. */
  mezzanineEdge: -0.5,
  wallHeight: 7.3,
} as const

export const floorY = (floor: FloorId) =>
  floor === 1 ? 0 : BUILDING.floorHeight

export type Vec3 = readonly [number, number, number]
export type Box = { min: Vec3; max: Vec3 }

/** The region each mode must keep in view. */
export function framingBox(mode: ViewMode): Box {
  const halfW = BUILDING.width / 2
  const halfD = BUILDING.depth / 2
  switch (mode) {
    case "floor-1":
      return { min: [-halfW, 0, -halfD], max: [halfW, 2.2, halfD] }
    case "floor-2":
      return {
        min: [-halfW, BUILDING.floorHeight, -halfD],
        max: [halfW, BUILDING.floorHeight + 2.4, BUILDING.mezzanineEdge + 0.6],
      }
    default:
      return {
        min: [-halfW, 0, -halfD],
        max: [halfW, BUILDING.wallHeight, halfD],
      }
  }
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
 * (so they come forward) while staying inside their floor.
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
