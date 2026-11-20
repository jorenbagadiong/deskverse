import { describe, expect, it } from "vitest"

import {
  BUILDING,
  cameraAxes,
  fitZoom,
  floorY,
  focusTarget,
  framingBox,
  VIEW_MODES,
} from "@/components/office/scene/camera-framing"

const ISO = Math.acos(1 / Math.sqrt(3))
const AZ = Math.PI / 4

describe("camera framing", () => {
  it("stacks Floor 2 physically above Floor 1", () => {
    expect(floorY(1)).toBe(0)
    expect(floorY(2)).toBe(BUILDING.floorHeight)
  })

  it("frames each mode around the right part of the building", () => {
    const building = framingBox("building")
    const f1 = framingBox("floor-1")
    const f2 = framingBox("floor-2")
    expect(building.max[1]).toBe(BUILDING.wallHeight)
    expect(f1.max[1]).toBeLessThan(BUILDING.floorHeight)
    expect(f2.min[1]).toBe(BUILDING.floorHeight)
    expect(f2.max[2]).toBeLessThanOrEqual(BUILDING.mezzanineEdge + 1)
  })

  it("zooms in further for a single floor than for the whole building", () => {
    const [w, h] = [900, 640]
    const building = fitZoom(framingBox("building"), w, h, ISO, AZ)
    expect(fitZoom(framingBox("floor-1"), w, h, ISO, AZ)).toBeGreaterThan(
      building,
    )
    expect(fitZoom(framingBox("floor-2"), w, h, ISO, AZ)).toBeGreaterThan(
      building,
    )
  })

  it("fits responsively: larger viewports get proportionally larger zoom", () => {
    for (const mode of VIEW_MODES) {
      const small = fitZoom(framingBox(mode), 360, 420, ISO, AZ)
      const large = fitZoom(framingBox(mode), 1440, 1680, ISO, AZ)
      expect(large / small).toBeCloseTo(4, 5)
    }
  })

  it("keeps every corner of the framed box inside the viewport", () => {
    const [w, h] = [700, 520]
    for (const mode of VIEW_MODES) {
      const box = framingBox(mode)
      const zoom = fitZoom(box, w, h, ISO, AZ)
      const { right, up } = cameraAxes(ISO, AZ)
      const c = [
        (box.min[0] + box.max[0]) / 2,
        (box.min[1] + box.max[1]) / 2,
        (box.min[2] + box.max[2]) / 2,
      ]
      for (const x of [box.min[0], box.max[0]])
        for (const y of [box.min[1], box.max[1]])
          for (const z of [box.min[2], box.max[2]]) {
            const d = [x - c[0], y - c[1], z - c[2]]
            const sx =
              (d[0] * right[0] + d[1] * right[1] + d[2] * right[2]) * zoom
            const sy = (d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) * zoom
            expect(Math.abs(sx)).toBeLessThanOrEqual(w / 2 + 0.5)
            expect(Math.abs(sy)).toBeLessThanOrEqual(h / 2 + 0.5)
          }
    }
  })

  it("moves the focus toward a selected employee and stays on their floor", () => {
    const point = [5, BUILDING.floorHeight, -3] as const
    const t = focusTarget("floor-2", point)
    const center = focusTarget("floor-2", null)
    expect(Math.abs(t[0] - point[0])).toBeLessThan(
      Math.abs(center[0] - point[0]),
    )
    expect(t[1]).toBeGreaterThanOrEqual(BUILDING.floorHeight)
  })

  it("uses an orthonormal camera basis", () => {
    const { right, up, forward } = cameraAxes(ISO, AZ)
    const dot = (a: readonly number[], b: readonly number[]) =>
      a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    expect(dot(right, up)).toBeCloseTo(0)
    expect(dot(right, forward)).toBeCloseTo(0)
    expect(dot(up, up)).toBeCloseTo(1)
    expect(up[1]).toBeGreaterThan(0)
  })
})
