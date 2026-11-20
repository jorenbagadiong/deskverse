import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { MAP_BACK_ROOMS } from "@/components/office/office-map"
import { frameDelta } from "@/components/office/scene/frame-delta"
import {
  environment,
  glow,
  statusGlow,
} from "@/components/office/scene/palette"
import { EMPLOYEE_STATUSES } from "@/config/employee-status"
import { employees } from "@/config/employees"
import {
  getOfficeEmployee,
  OFFICE_BOUNDS,
  officeEmployees,
  ROOM_IDS,
  roomAt,
  ROOMS,
} from "@/config/office"
import {
  MAX_ACTIVITY,
  createInitialOfficeState,
  officeReducer,
  simulatedActions,
} from "@/lib/office-simulation"

const css = readFileSync(path.join(__dirname, "../src/app/globals.css"), "utf8")
const block = (selector: RegExp) => css.match(selector)?.[1] ?? ""
const darkBlock = block(/\n\.dark\s*\{([\s\S]*?)\n\}/)
const lightBlock = block(/:root,\s*\.light\s*\{([\s\S]*?)\n\}/)
const token = (b: string, name: string) =>
  b.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1]?.toLowerCase()

describe("office employee registry", () => {
  it("has all seven employees, in roster order", () => {
    expect(officeEmployees.map((e) => e.id)).toEqual([
      "scout",
      "quill",
      "pixel",
      "vera",
      "tempo",
      "relay",
      "ledger",
    ])
  })

  it("takes names, roles and identity tokens from the shared roster", () => {
    for (const e of officeEmployees) {
      const base = employees.find((r) => r.id === e.id)
      expect(e.name).toBe(base?.name)
      expect(e.role).toBe(base?.role)
      expect(e.colorToken).toBe(`--identity-${e.id}`)
    }
  })

  it("matches the DV-002 identity colors to the dark-theme tokens", () => {
    for (const e of officeEmployees)
      expect(e.glow).toBe(token(darkBlock, e.colorToken))
    expect(getOfficeEmployee("scout").glow).toBe(token(darkBlock, "--primary")) // teal
    expect(getOfficeEmployee("tempo").glow).toBe(
      token(darkBlock, "--secondary"),
    ) // violet
  })

  it("gives every employee a distinct silhouette, not just a different color", () => {
    const signature = (e: (typeof officeEmployees)[number]) =>
      `${e.look.head}/${e.look.headgear}/${e.look.chest}`
    expect(new Set(officeEmployees.map(signature)).size).toBe(7)
    expect(new Set(officeEmployees.map((e) => e.look.headgear)).size).toBe(7)
    expect(new Set(officeEmployees.map((e) => e.look.chest)).size).toBe(7)
    expect(new Set(officeEmployees.map((e) => e.glow)).size).toBe(7)
  })

  it("gives every employee a workstation matching their job", () => {
    const kinds = Object.fromEntries(
      officeEmployees.map((e) => [e.id, e.workstation]),
    )
    expect(kinds).toEqual({
      scout: "research",
      quill: "writing",
      pixel: "video",
      vera: "review",
      tempo: "schedule",
      relay: "publish",
      ledger: "analytics",
    })
  })

  it("describes a simulated task for every status", () => {
    for (const e of officeEmployees)
      for (const s of EMPLOYEE_STATUSES)
        expect(e.tasks[s].length).toBeGreaterThan(0)
  })
})

describe("single-floor layout", () => {
  it("defines the four rooms inside one footprint, with Operations the largest", () => {
    expect([...ROOM_IDS].sort()).toEqual(
      ["lounge", "meeting", "operations", "pantry"].sort(),
    )
    const area = (id: (typeof ROOM_IDS)[number]) => {
      const b = ROOMS[id].bounds
      return (b.x1 - b.x0) * (b.z1 - b.z0)
    }
    for (const id of ROOM_IDS) {
      const b = ROOMS[id].bounds
      expect(b.x0).toBeGreaterThanOrEqual(OFFICE_BOUNDS.x0)
      expect(b.x1).toBeLessThanOrEqual(OFFICE_BOUNDS.x1)
      expect(b.z0).toBeGreaterThanOrEqual(OFFICE_BOUNDS.z0)
      expect(b.z1).toBeLessThanOrEqual(OFFICE_BOUNDS.z1)
      if (id !== "operations")
        expect(area("operations")).toBeGreaterThan(area(id) * 2)
    }
    expect(ROOMS.lounge.name).toBe("Gaming & Rest Lounge")
  })

  it("puts all seven workstations in the Operations Room", () => {
    for (const e of officeEmployees)
      expect(roomAt(e.desk[0], e.desk[1]), e.id).toBe("operations")
  })

  it("gives every desk enough room (no overlapping stations)", () => {
    for (const a of officeEmployees)
      for (const b of officeEmployees) {
        if (a === b) continue
        const dx = Math.abs(a.desk[0] - b.desk[0])
        const dz = Math.abs(a.desk[1] - b.desk[1])
        expect(dx >= 3 || dz >= 3, `${a.id} / ${b.id}`).toBe(true)
      }
  })
})

describe("2D floor plan data", () => {
  it("shows the three back rooms in plan order above the Operations Room", () => {
    expect(MAP_BACK_ROOMS).toEqual(["meeting", "pantry", "lounge"])
    const xs = MAP_BACK_ROOMS.map((r) => ROOMS[r].bounds.x0)
    expect([...xs].sort((a, b) => a - b)).toEqual(xs)
  })
})

describe("3D palette and themes", () => {
  it("glow colors match the dark-theme brand tokens", () => {
    expect(glow.primary).toBe(token(darkBlock, "--primary"))
    expect(glow.secondary).toBe(token(darkBlock, "--secondary"))
    expect(glow.accent).toBe(token(darkBlock, "--accent"))
    for (const s of EMPLOYEE_STATUSES)
      expect(statusGlow[s]).toBe(token(darkBlock, `--status-${s}`))
  })

  it("defines the same environment keys for the dark and light office", () => {
    expect(Object.keys(environment.light).sort()).toEqual(
      Object.keys(environment.dark).sort(),
    )
  })

  it("defines every identity token in both themes", () => {
    for (const e of officeEmployees) {
      expect(token(darkBlock, e.colorToken)).toMatch(/^#[0-9a-f]{6}$/)
      expect(token(lightBlock, e.colorToken)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})

describe("simulated actions", () => {
  it("offers at least one action from every state, each leading to a different state", () => {
    for (const s of EMPLOYEE_STATUSES) {
      expect(simulatedActions[s].length).toBeGreaterThan(0)
      for (const action of simulatedActions[s]) {
        expect(EMPLOYEE_STATUSES).toContain(action.next)
        expect(action.next).not.toBe(s)
      }
    }
  })

  it("can reach every state from idle", () => {
    const seen = new Set<string>(["idle"])
    const queue = ["idle"] as (typeof EMPLOYEE_STATUSES)[number][]
    while (queue.length) {
      const s = queue.shift()!
      for (const a of simulatedActions[s]) {
        if (!seen.has(a.next)) {
          seen.add(a.next)
          queue.push(a.next)
        }
      }
    }
    expect([...seen].sort()).toEqual([...EMPLOYEE_STATUSES].sort())
  })
})

describe("office reducer", () => {
  it("starts on the entire office with nothing selected and registry statuses", () => {
    const state = createInitialOfficeState()
    expect(state.selectedId).toBeNull()
    expect(state.view).toBe("office")
    expect(state.statuses).toEqual(
      Object.fromEntries(officeEmployees.map((e) => [e.id, e.initialStatus])),
    )
    expect(state.activity).toEqual([])
  })

  it("selecting an employee keeps the whole office in view", () => {
    let state = officeReducer(createInitialOfficeState(), {
      type: "select",
      id: "pixel",
    })
    expect(state).toMatchObject({ selectedId: "pixel", view: "office" })
    state = officeReducer(state, { type: "select", id: "ledger" })
    expect(state).toMatchObject({ selectedId: "ledger", view: "office" })
  })

  it("every one of the seven employees can be selected", () => {
    for (const e of officeEmployees) {
      const state = officeReducer(createInitialOfficeState(), {
        type: "select",
        id: e.id,
      })
      expect(state.selectedId).toBe(e.id)
    }
  })

  it("selecting someone outside the framed room returns to the entire office", () => {
    let state = officeReducer(createInitialOfficeState(), {
      type: "setView",
      view: "operations",
    })
    state = officeReducer(state, { type: "select", id: "relay" })
    expect(state).toMatchObject({ selectedId: "relay", view: "operations" })
    state = officeReducer(state, { type: "setView", view: "pantry" })
    state = officeReducer(state, { type: "select", id: "relay" })
    expect(state).toMatchObject({ selectedId: "relay", view: "office" })
  })

  it("deselecting keeps the current view", () => {
    let state = officeReducer(createInitialOfficeState(), {
      type: "setView",
      view: "operations",
    })
    state = officeReducer(state, { type: "select", id: "relay" })
    state = officeReducer(state, { type: "select", id: null })
    expect(state).toMatchObject({ selectedId: null, view: "operations" })
  })

  it("room views keep a selection inside the room and drop one elsewhere", () => {
    let state = officeReducer(createInitialOfficeState(), {
      type: "select",
      id: "scout",
    })
    state = officeReducer(state, { type: "setView", view: "operations" })
    expect(state).toMatchObject({ selectedId: "scout", view: "operations" })
    state = officeReducer(state, { type: "setView", view: "office" })
    expect(state).toMatchObject({ selectedId: "scout", view: "office" })
    state = officeReducer(state, { type: "setView", view: "meeting" })
    expect(state).toMatchObject({ selectedId: null, view: "meeting" })
  })

  it("changes status and records simulated activity", () => {
    const state = officeReducer(createInitialOfficeState(), {
      type: "setStatus",
      id: "tempo",
      status: "failed",
    })
    expect(state.statuses.tempo).toBe("failed")
    expect(state.activity[0]).toMatchObject({
      employeeId: "tempo",
      status: "failed",
    })
    expect(state.activity[0].message).toContain("Tempo is now failed")
  })

  it("supports all five simulated states for every employee", () => {
    for (const e of officeEmployees) {
      let state = createInitialOfficeState()
      for (const status of EMPLOYEE_STATUSES) {
        state = officeReducer(state, { type: "setStatus", id: e.id, status })
        expect(state.statuses[e.id]).toBe(status)
      }
    }
  })

  it("ignores no-op status changes", () => {
    const initial = createInitialOfficeState()
    expect(
      officeReducer(initial, {
        type: "setStatus",
        id: "scout",
        status: "working",
      }),
    ).toBe(initial)
  })

  it("keeps only the latest activity entries, newest first, with unique ids", () => {
    let state = createInitialOfficeState()
    for (const status of [
      "completed",
      "idle",
      "working",
      "failed",
      "idle",
      "working",
    ] as const) {
      state = officeReducer(state, { type: "setStatus", id: "scout", status })
    }
    expect(state.activity).toHaveLength(MAX_ACTIVITY)
    expect(state.activity[0].status).toBe("working")
    expect(new Set(state.activity.map((a) => a.id)).size).toBe(MAX_ACTIVITY)
  })
})

describe("frameDelta", () => {
  it("treats a long idle gap as one 60 fps frame", () => {
    expect(frameDelta(3.2)).toBeCloseTo(1 / 60)
  })
  it("keeps real frame time on slow devices, capped at 100 ms", () => {
    expect(frameDelta(0.12)).toBe(0.1)
    expect(frameDelta(0.05)).toBe(0.05)
    expect(frameDelta(1 / 60)).toBeCloseTo(1 / 60)
  })
})
