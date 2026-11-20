import { describe, expect, it } from "vitest"

import { officeEmployees } from "@/config/office"
import {
  activityOf,
  locationLabel,
  movementOptions,
  type LiveLocation,
  type Movement,
} from "@/lib/office-movement"
import { positionAt, segmentEdge } from "@/lib/office-navigation"
import {
  BREAK_TICKS,
  createInitialOfficeState,
  officeReducer,
  type OfficeAction,
  type OfficeState,
} from "@/lib/office-simulation"

const run = (actions: OfficeAction[], state = createInitialOfficeState()) =>
  actions.reduce(officeReducer, state)

const walking = (state: OfficeState, id: keyof OfficeState["movement"]) => {
  const m = state.movement[id]
  if (m.kind !== "walking") throw new Error(`${id} is not walking (${m.kind})`)
  return m
}

/** Live reading halfway along the current walk, as the scene would report it. */
function liveHalfway(m: Extract<Movement, { kind: "walking" }>): LiveLocation {
  const sample = positionAt(m.route, m.route.total / 2)
  return {
    point: sample.position,
    node: null,
    edge: segmentEdge(m.route, sample.segment),
  }
}

describe("movement state", () => {
  it("starts with everyone at their own desk", () => {
    const state = createInitialOfficeState()
    for (const e of officeEmployees) {
      expect(state.movement[e.id]).toMatchObject({
        kind: "at",
        node: `desk:${e.id}`,
      })
      expect(activityOf(state.movement[e.id])).toBe("at-desk")
    }
  })

  it("walks to the pantry and arrives for a coffee break", () => {
    let state = run([{ type: "goTo", id: "quill", destination: "pantry" }])
    const walk = walking(state, "quill")
    expect(walk.destination).toBe("pantry")
    expect(activityOf(walk)).toBe("walking")
    expect(locationLabel(walk)).toBe("Walking to the pantry")
    state = officeReducer(state, {
      type: "arrive",
      id: "quill",
      routeId: walk.routeId,
    })
    expect(state.movement.quill).toMatchObject({ kind: "at", node: "pantry:1" })
    expect(activityOf(state.movement.quill)).toBe("coffee-break")
    expect(state.activity[0].message).toContain("coffee break")
  })

  it("ignores stale arrivals from an older route", () => {
    let state = run([{ type: "goTo", id: "quill", destination: "pantry" }])
    const first = walking(state, "quill").routeId
    state = officeReducer(state, {
      type: "goTo",
      id: "quill",
      destination: "desk",
      from: liveHalfway(walking(state, "quill")),
    })
    expect(
      officeReducer(state, { type: "arrive", id: "quill", routeId: first }),
    ).toBe(state)
  })

  it("reduced motion moves instantly to the destination", () => {
    const state = run([
      { type: "goTo", id: "vera", destination: "lounge", instant: true },
    ])
    expect(state.movement.vera).toMatchObject({ kind: "at", node: "lounge:1" })
    expect(activityOf(state.movement.vera)).toBe("resting")
  })

  it("gives each break spot to one employee at a time", () => {
    const state = run([
      { type: "goTo", id: "quill", destination: "pantry", instant: true },
      { type: "goTo", id: "vera", destination: "pantry", instant: true },
      { type: "goTo", id: "tempo", destination: "pantry" },
    ])
    const nodes = [state.movement.quill, state.movement.vera].map((m) =>
      m.kind === "at" ? m.node : null,
    )
    expect(new Set(nodes).size).toBe(2)
    expect(walking(state, "tempo").target).toBe("pantry:3")
    expect(
      movementOptions("ledger", "completed", state.movement).find(
        (o) => o.kind === "pantry",
      ),
    ).toMatchObject({
      enabled: false,
      reason: "All spots are taken",
    })
  })
})

describe("interruption and return to desk", () => {
  it("stops mid-corridor and resumes from there", () => {
    let state = run([{ type: "goTo", id: "quill", destination: "pantry" }])
    const live = liveHalfway(walking(state, "quill"))
    state = officeReducer(state, { type: "stop", id: "quill", at: live })
    expect(state.movement.quill).toMatchObject({
      kind: "stopped",
      point: live.point,
    })
    expect(activityOf(state.movement.quill)).toBe("standing")
    state = officeReducer(state, {
      type: "goTo",
      id: "quill",
      destination: "desk",
    })
    const back = walking(state, "quill")
    expect(back.route.points[0]).toMatchObject({
      x: live.point[0],
      z: live.point[2],
    })
    expect(back.target).toBe("desk:quill")
  })

  it("can turn around mid-walk using the live position", () => {
    let state = run(
      [{ type: "goTo", id: "scout", destination: "lounge" }].map(
        (a) => a as OfficeAction,
      ),
    )
    // Scout starts working, so a break is refused…
    expect(state.movement.scout.kind).toBe("at")
    state = run([{ type: "goTo", id: "quill", destination: "lounge" }])
    const live = liveHalfway(walking(state, "quill"))
    state = officeReducer(state, {
      type: "goTo",
      id: "quill",
      destination: "desk",
      from: live,
    })
    expect(walking(state, "quill").route.points[0].x).toBeCloseTo(live.point[0])
  })

  it("a new working task while away sends the employee back to their desk", () => {
    let state = run([
      { type: "goTo", id: "quill", destination: "pantry", instant: true },
    ])
    state = officeReducer(state, {
      type: "setStatus",
      id: "quill",
      status: "working",
    })
    expect(state.statuses.quill).toBe("working")
    expect(walking(state, "quill").target).toBe("desk:quill")
  })

  it("working employees don't leave for breaks, but may return to the desk", () => {
    const state = createInitialOfficeState() // Scout and Relay start working
    expect(
      officeReducer(state, {
        type: "goTo",
        id: "scout",
        destination: "pantry",
      }),
    ).toBe(state)
    const options = movementOptions("scout", "working", state.movement)
    expect(options.find((o) => o.kind === "pantry")).toMatchObject({
      enabled: false,
    })
    expect(options.find((o) => o.kind === "lounge")?.reason).toMatch(/Busy/)
  })
})

describe("task status independence", () => {
  it("walking never changes the task status", () => {
    const before = createInitialOfficeState()
    const after = run(
      [
        { type: "goTo", id: "quill", destination: "lounge" },
        { type: "goTo", id: "ledger", destination: "pantry" },
      ],
      before,
    )
    expect(after.statuses).toEqual(before.statuses)
  })

  it("status changes (other than starting work) never move anyone", () => {
    let state = run([
      { type: "goTo", id: "vera", destination: "lounge", instant: true },
    ])
    for (const status of ["waiting", "completed", "failed", "idle"] as const) {
      state = officeReducer(state, { type: "setStatus", id: "vera", status })
      expect(state.movement.vera).toMatchObject({
        kind: "at",
        node: "lounge:1",
      })
    }
  })

  it("logs movement and status changes as separate activity entries", () => {
    const state = run([
      { type: "goTo", id: "quill", destination: "pantry", instant: true },
      { type: "setStatus", id: "quill", status: "completed" },
    ])
    expect(state.activity.map((a) => a.kind)).toEqual(["status", "movement"])
  })
})

describe("movement options", () => {
  it("offers return / pantry / lounge / gaming / meeting / stop with clear availability", () => {
    const state = createInitialOfficeState()
    const options = movementOptions("vera", "idle", state.movement)
    expect(options.map((o) => o.kind)).toEqual([
      "desk",
      "pantry",
      "lounge",
      "gaming",
      "meeting",
      "stop",
    ])
    expect(options.find((o) => o.kind === "desk")).toMatchObject({
      enabled: false,
      reason: "Already at the workstation",
    })
    for (const kind of ["pantry", "lounge", "gaming", "meeting"] as const)
      expect(options.find((o) => o.kind === kind)?.enabled, kind).toBe(true)
    expect(options.find((o) => o.kind === "stop")?.enabled).toBe(false)
  })
})

describe("walking between rooms", () => {
  it("reaches every room and sits down where there is a seat", () => {
    const expected = {
      pantry: "coffee-break",
      lounge: "resting",
      gaming: "gaming",
      meeting: "meeting",
    } as const
    for (const [destination, activity] of Object.entries(expected)) {
      let state = run([
        { type: "goTo", id: "pixel", destination } as OfficeAction,
      ])
      const walk = walking(state, "pixel")
      expect(walk.route.total, destination).toBeGreaterThan(2)
      state = officeReducer(state, {
        type: "arrive",
        id: "pixel",
        routeId: walk.routeId,
      })
      expect(activityOf(state.movement.pixel), destination).toBe(activity)
      expect(state.statuses.pixel).toBe("waiting")
    }
  })

  it("walks from one room straight to another without passing the desk", () => {
    let state = run([
      { type: "goTo", id: "vera", destination: "pantry", instant: true },
      { type: "goTo", id: "vera", destination: "meeting" },
    ])
    const walk = walking(state, "vera")
    expect(walk.route.points[0].node).toMatch(/^pantry:/)
    expect(walk.route.points.map((p) => p.node)).not.toContain("desk:vera")
    state = officeReducer(state, {
      type: "arrive",
      id: "vera",
      routeId: walk.routeId,
    })
    expect(locationLabel(state.movement.vera)).toBe(
      "Meeting Room · conference table",
    )
  })

  it("keeps meeting seats and gaming stations one per person", () => {
    const ids = ["quill", "pixel", "vera", "tempo", "ledger"] as const
    let state = createInitialOfficeState()
    for (const id of ids)
      state = officeReducer(state, {
        type: "goTo",
        id,
        destination: "gaming",
        instant: true,
      })
    const seats = ids
      .map((id) => state.movement[id])
      .filter((m) => m.kind === "at" && m.node.startsWith("gaming:"))
    // Three gaming stations: the fourth and fifth player stay put.
    expect(seats).toHaveLength(3)
    expect(
      new Set(seats.map((m) => (m.kind === "at" ? m.node : ""))).size,
    ).toBe(3)
    expect(
      movementOptions("ledger", "completed", state.movement).find(
        (o) => o.kind === "gaming",
      ),
    ).toMatchObject({ enabled: false, reason: "All spots are taken" })
  })
})

describe("selection follows the real location", () => {
  it("selecting someone in the lounge from the Pantry view shows the entire office", () => {
    const state = run([
      { type: "goTo", id: "quill", destination: "lounge", instant: true },
      { type: "setView", view: "pantry" },
      { type: "select", id: "quill" },
    ])
    expect(state.view).toBe("office")
  })

  it("selecting someone in the room being framed keeps that room", () => {
    const state = run([
      { type: "goTo", id: "quill", destination: "lounge", instant: true },
      { type: "setView", view: "lounge" },
      { type: "select", id: "quill" },
    ])
    expect(state).toMatchObject({ view: "lounge", selectedId: "quill" })
  })

  it("uses the scene's live room for a walker", () => {
    const state = run([
      { type: "goTo", id: "quill", destination: "pantry" },
      { type: "setView", view: "pantry" },
      { type: "select", id: "quill", room: "pantry" },
    ])
    expect(state.view).toBe("pantry")
  })
})

describe("ambient wandering (optional, off by default)", () => {
  it("does nothing unless enabled", () => {
    const state = createInitialOfficeState()
    expect(officeReducer(state, { type: "ambientTick" })).toBe(state)
  })

  it("sends one idle employee on a break per tick and brings them back later", () => {
    let state = run([{ type: "setWander", on: true }])
    state = officeReducer(state, { type: "ambientTick", instant: true })
    const away = Object.entries(state.movement).filter(
      ([, m]) => m.kind === "at" && !m.node.startsWith("desk:"),
    )
    expect(away).toHaveLength(1)
    const [id] = away[0]
    // Working employees are never picked.
    expect(["scout", "relay"]).not.toContain(id)
    for (let i = 0; i < BREAK_TICKS + 2; i++)
      state = officeReducer(state, { type: "ambientTick", instant: true })
    expect(state.movement[id as keyof typeof state.movement]).toMatchObject({
      kind: "at",
      node: `desk:${id}`,
    })
  })
})
