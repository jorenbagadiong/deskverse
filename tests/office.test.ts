import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { MAP_FLOORS } from "@/components/office/office-map"
import { frameDelta } from "@/components/office/scene/frame-delta"
import {
  environment,
  glow,
  statusGlow,
} from "@/components/office/scene/palette"
import { EMPLOYEE_STATUSES } from "@/config/employee-status"
import { employees } from "@/config/employees"
import {
  employeesOnFloor,
  FLOORS,
  getOfficeEmployee,
  officeEmployees,
  viewForFloor,
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

describe("floor assignment", () => {
  it("puts the creative team on Floor 1 and operations on Floor 2", () => {
    expect(employeesOnFloor(1).map((e) => e.id)).toEqual([
      "scout",
      "quill",
      "pixel",
      "vera",
    ])
    expect(employeesOnFloor(2).map((e) => e.id)).toEqual([
      "tempo",
      "relay",
      "ledger",
    ])
    expect(FLOORS[1].name).toBe("Creative Production")
    expect(FLOORS[2].name).toBe("Operations & Automation")
  })

  it("gives desks on the same floor enough room (no overlapping stations)", () => {
    for (const floor of [1, 2] as const) {
      const xs = employeesOnFloor(floor)
        .map((e) => e.desk[0])
        .sort((a, b) => a - b)
      for (let i = 1; i < xs.length; i++)
        expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(3)
    }
  })

  it("places Floor 2 desks on the mezzanine and Floor 1 desks in the open atrium", () => {
    for (const e of employeesOnFloor(2)) expect(e.desk[1]).toBeLessThan(-1)
    for (const e of employeesOnFloor(1)) expect(e.desk[1]).toBeGreaterThan(0)
  })

  it("maps each floor to its camera view", () => {
    expect(viewForFloor(1)).toBe("floor-1")
    expect(viewForFloor(2)).toBe("floor-2")
  })
})

describe("2D floor plan data", () => {
  it("covers both floors, upper floor first", () => {
    expect(MAP_FLOORS).toEqual([2, 1])
    const shown = MAP_FLOORS.flatMap((f) =>
      employeesOnFloor(f).map((e) => e.id),
    )
    expect(shown.sort()).toEqual(officeEmployees.map((e) => e.id).sort())
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
  it("starts on the whole building with nothing selected and registry statuses", () => {
    const state = createInitialOfficeState()
    expect(state.selectedId).toBeNull()
    expect(state.view).toBe("building")
    expect(state.statuses).toEqual(
      Object.fromEntries(officeEmployees.map((e) => [e.id, e.initialStatus])),
    )
    expect(state.activity).toEqual([])
  })

  it("selecting an employee activates their floor", () => {
    let state = officeReducer(createInitialOfficeState(), {
      type: "select",
      id: "pixel",
    })
    expect(state).toMatchObject({ selectedId: "pixel", view: "floor-1" })
    state = officeReducer(state, { type: "select", id: "ledger" })
    expect(state).toMatchObject({ selectedId: "ledger", view: "floor-2" })
  })

  it("every one of the seven employees can be selected", () => {
    for (const e of officeEmployees) {
      const state = officeReducer(createInitialOfficeState(), {
        type: "select",
        id: e.id,
      })
      expect(state.selectedId).toBe(e.id)
      expect(state.view).toBe(viewForFloor(e.floor))
    }
  })

  it("deselecting keeps the current floor view", () => {
    let state = officeReducer(createInitialOfficeState(), {
      type: "select",
      id: "relay",
    })
    state = officeReducer(state, { type: "select", id: null })
    expect(state).toMatchObject({ selectedId: null, view: "floor-2" })
  })

  it("switching floors keeps a visible selection and drops one on the other floor", () => {
    let state = officeReducer(createInitialOfficeState(), {
      type: "select",
      id: "scout",
    })
    state = officeReducer(state, { type: "setView", view: "building" })
    expect(state).toMatchObject({ selectedId: "scout", view: "building" })
    state = officeReducer(state, { type: "setView", view: "floor-2" })
    expect(state).toMatchObject({ selectedId: null, view: "floor-2" })
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
