import { describe, expect, it } from "vitest"

import {
  BACK_WALL,
  focusTarget,
  LEFT_WALL,
  nextWallHidden,
  ROTATE_STEP,
  shortestAngle,
  wallFacesCamera,
} from "@/components/office/scene/camera-framing"
import {
  activityPose,
  basePose,
  COFFEE_POSE,
  gait,
  SEATED_POSE,
  sipAmount,
  STRIDE_LENGTH,
} from "@/components/office/scene/character/pose"
import { officeEmployees } from "@/config/office"
import { createLiveStore, entryFor, liveLocation } from "@/lib/office-live"
import { activityOf } from "@/lib/office-movement"
import {
  createInitialOfficeState,
  officeReducer,
} from "@/lib/office-simulation"

const TAU = Math.PI * 2
const wrap = (a: number) => ((a % TAU) + TAU) % TAU

describe("360° camera", () => {
  it("shortestAngle always takes the short way across the 0°/360° seam", () => {
    expect(shortestAngle(0.1, TAU - 0.1)).toBeCloseTo(-0.2)
    expect(shortestAngle(TAU - 0.1, 0.1)).toBeCloseTo(0.2)
    expect(shortestAngle(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2)
    for (let i = 0; i < 200; i++) {
      const from = (i * 0.37) % 20
      const to = ((i * 1.91) % 20) - 10
      const d = shortestAngle(from, to)
      expect(d).toBeGreaterThan(-Math.PI - 1e-9)
      expect(d).toBeLessThanOrEqual(Math.PI + 1e-9)
      expect(wrap(from + d)).toBeCloseTo(wrap(to))
    }
  })

  it("rotation is unbounded: 20 steps make exactly one full turn", () => {
    const start = Math.PI / 4
    let azimuth = start
    // Each press targets 18° further; the rig unwraps the goal next to the
    // current angle, exactly as the camera does frame by frame.
    for (let i = 0; i < 20; i++) {
      const goal = azimuth + ROTATE_STEP
      azimuth += shortestAngle(azimuth, goal)
    }
    expect(azimuth - start).toBeCloseTo(TAU)
    expect(wrap(azimuth)).toBeCloseTo(wrap(start))
    // …and it keeps going past 360° without hitting a limit.
    for (let i = 0; i < 25; i++)
      azimuth += shortestAngle(azimuth, azimuth - ROTATE_STEP)
    expect(azimuth - start).toBeCloseTo(TAU - 25 * ROTATE_STEP)
  })

  it("focus follows a walker's live position", () => {
    const a = focusTarget("building", [1, 0, 1])
    const b = focusTarget("building", [4, 0, -2])
    expect(a).not.toEqual(b)
    expect(focusTarget("floor-2", [4, 3.6, -2])[1]).toBeGreaterThan(3)
  })
})

describe("camera-aware wall hiding", () => {
  it("hides the back wall only when the camera is behind it", () => {
    // Default iso view (camera at +x, +z): both walls are in the background.
    expect(wallFacesCamera(BACK_WALL, 1, 1)).toBeLessThan(0)
    expect(wallFacesCamera(LEFT_WALL, 1, 1)).toBeLessThan(0)
    // Orbit round to the back (-z): the back wall would block the view.
    expect(wallFacesCamera(BACK_WALL, 0.2, -1)).toBeGreaterThan(0.9)
    expect(wallFacesCamera(LEFT_WALL, -1, 0.3)).toBeGreaterThan(0.9)
  })

  it("uses hysteresis so slow orbits don't flicker", () => {
    let hidden = false
    hidden = nextWallHidden(hidden, 0.1)
    expect(hidden).toBe(false)
    hidden = nextWallHidden(hidden, 0.2)
    expect(hidden).toBe(true)
    hidden = nextWallHidden(hidden, 0.05) // inside the band: stays hidden
    expect(hidden).toBe(true)
    hidden = nextWallHidden(hidden, 0.0)
    expect(hidden).toBe(false)
  })
})

describe("walking and break animations", () => {
  it("gait is driven by distance walked, so feet don't slide", () => {
    expect(gait(0).leftLeg).toBeCloseTo(0)
    expect(gait(STRIDE_LENGTH / 4).leftLeg).toBeCloseTo(0.55)
    // One stride later the pose repeats exactly.
    const a = gait(1.234)
    const b = gait(1.234 + STRIDE_LENGTH)
    expect(b.leftLeg).toBeCloseTo(a.leftLeg)
    expect(b.bob).toBeCloseTo(a.bob)
    // Legs and arms swing in opposition.
    expect(a.leftLeg).toBeCloseTo(-a.rightLeg)
    expect(Math.sign(a.leftArm)).toBe(-Math.sign(a.leftLeg))
    expect(gait(0.4, 0).leftLeg).toBeCloseTo(0)
  })

  it("picks the pose from the activity away from the desk", () => {
    expect(activityPose("coffee-break", "idle", "research")).toBe(COFFEE_POSE)
    expect(activityPose("resting", "completed", "writing")).toBe(SEATED_POSE)
    // At the desk the task status still decides.
    expect(activityPose("at-desk", "working", "video")).toEqual(
      basePose("working", "video"),
    )
    // Working poses need the workstation: standing in a corridor relaxes.
    expect(activityPose("standing", "working", "video")).not.toEqual(
      basePose("working", "video"),
    )
  })

  it("sips rise and fall within the glance window", () => {
    expect(sipAmount(-1)).toBe(0)
    expect(sipAmount(0)).toBe(0)
    expect(sipAmount(0.5)).toBeGreaterThan(0)
    expect(sipAmount(99)).toBe(0)
  })
})

describe("live positions", () => {
  it("starts every walker at their own desk on the right floor", () => {
    const store = createLiveStore(createInitialOfficeState().movement)
    for (const e of officeEmployees) {
      const entry = store.get(e.id)!
      expect(entry.floor).toBe(e.floor)
      expect(entry.moving).toBe(false)
      expect(entry.x).toBeCloseTo(e.desk[0])
    }
  })

  it("resolves a stop command to the walker's live point", () => {
    let state = createInitialOfficeState()
    state = officeReducer(state, {
      type: "goTo",
      id: "quill",
      destination: "pantry",
    })
    const store = createLiveStore(state.movement)
    const m = state.movement.quill
    if (m.kind !== "walking") throw new Error("expected a walk")
    // Mid-route reading as the scene would write it.
    const mid = m.route.points[1]
    store.set("quill", {
      ...entryFor(m),
      x: mid.x,
      z: mid.z,
      node: mid.node ?? null,
    })
    const at = liveLocation(store, "quill")!
    state = officeReducer(state, { type: "stop", id: "quill", at })
    const stopped = state.movement.quill
    // A reading exactly on a node settles there; otherwise they stop mid-corridor.
    expect(stopped.kind === "stopped" || stopped.kind === "at").toBe(true)
    if (stopped.kind === "stopped") expect(stopped.point[0]).toBeCloseTo(mid.x)
    expect(activityOf(stopped)).not.toBe("walking")
    expect(state.statuses.quill).toBe("idle")
  })
})
