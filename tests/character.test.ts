import { describe, expect, it } from "vitest"

import { expressionFor } from "@/components/office/scene/character/expression"
import {
  basePose,
  blinkOpenness,
  BLINK_SECONDS,
  glanceYaw,
  GLANCE_SECONDS,
  NO_TRANSIENT,
  pulse,
  RELAXED,
  smoothSquare,
  transient,
  TRANSIENT_SECONDS,
  workingMotion,
} from "@/components/office/scene/character/pose"
import {
  AMBIENT_INTERVAL_MS,
  ambientRequestFor,
} from "@/components/office/scene/shared/ambient"
import { EMPLOYEE_STATUSES } from "@/config/employee-status"
import { officeEmployees, type WorkstationKind } from "@/config/office"

const KINDS: WorkstationKind[] = [
  "research",
  "writing",
  "video",
  "review",
  "schedule",
  "publish",
  "analytics",
]

describe("character poses", () => {
  it("gives every status a distinct pose", () => {
    const poses = EMPLOYEE_STATUSES.map((s) =>
      JSON.stringify(basePose(s, "video")),
    )
    expect(new Set(poses).size).toBe(EMPLOYEE_STATUSES.length)
  })

  it("gives every role a distinct working pose", () => {
    const poses = KINDS.map((k) => JSON.stringify(basePose("working", k)))
    expect(new Set(poses).size).toBe(KINDS.length)
  })

  it("raises a hand while waiting and slumps when failed, keeping the face visible", () => {
    expect(basePose("waiting", "research").right.raise).toBeGreaterThan(2)
    const failed = basePose("failed", "research")
    expect(failed.lean).toBeGreaterThan(0)
    expect(failed.headRoll).toBeGreaterThan(0)
    expect(failed.headPitch).toBeLessThan(0.25) // not hidden from the camera
  })

  it("idle is the relaxed pose", () => {
    expect(basePose("idle", "analytics")).toEqual(RELAXED)
  })

  it("working motion is deterministic, bounded and role-specific", () => {
    for (const kind of KINDS) {
      expect(workingMotion(kind, 1.234)).toEqual(workingMotion(kind, 1.234))
      for (const t of [0, 0.5, 1.7, 3.3, 10]) {
        const m = workingMotion(kind, t)
        for (const v of [m.lean, m.twist, m.headPitch, m.headYaw, m.headRoll])
          expect(Math.abs(v)).toBeLessThan(0.6)
      }
    }
    const signatures = KINDS.map((k) => JSON.stringify(workingMotion(k, 0.77)))
    expect(new Set(signatures).size).toBe(KINDS.length)
  })

  it("helpers stay in range", () => {
    for (let t = 0; t < 10; t += 0.37) {
      expect(Math.abs(smoothSquare(t, 3))).toBeLessThanOrEqual(1)
      expect(pulse(t, 5, 1)).toBeGreaterThanOrEqual(0)
      expect(pulse(t, 5, 1)).toBeLessThanOrEqual(1)
    }
  })
})

describe("one-off reactions (animation state transitions)", () => {
  it("celebrates once on completion, then settles", () => {
    const mid = transient("completed", TRANSIENT_SECONDS.completed! / 2)
    expect(mid.hop).toBeGreaterThan(0.2)
    expect(mid.armsUp).toBeGreaterThan(0.9)
    expect(transient("completed", TRANSIENT_SECONDS.completed! + 0.01)).toEqual(
      NO_TRANSIENT,
    )
  })

  it("shakes briefly on failure", () => {
    const values = [0.03, 0.1, 0.2].map((t) =>
      Math.abs(transient("failed", t).shake),
    )
    expect(Math.max(...values)).toBeGreaterThan(0.01)
    expect(transient("failed", 1)).toEqual(NO_TRANSIENT)
  })

  it("waves when asking for approval", () => {
    expect(Math.abs(transient("waiting", 0.1).wave)).toBeGreaterThan(0.05)
    expect(transient("waiting", 2)).toEqual(NO_TRANSIENT)
  })

  it("has no one-off reaction for idle or working, and none before the change", () => {
    expect(transient("idle", 0.2)).toEqual(NO_TRANSIENT)
    expect(transient("working", 0.2)).toEqual(NO_TRANSIENT)
    expect(transient("completed", -1)).toEqual(NO_TRANSIENT)
  })

  it("blinks and glances are short and return to rest", () => {
    expect(blinkOpenness(BLINK_SECONDS / 2)).toBeLessThan(0.3)
    expect(blinkOpenness(BLINK_SECONDS + 0.01)).toBe(1)
    expect(Math.abs(glanceYaw(GLANCE_SECONDS / 2, 1))).toBeGreaterThan(0.3)
    expect(glanceYaw(GLANCE_SECONDS + 0.01, -1)).toBe(0)
  })
})

describe("facial expressions", () => {
  it("shows each employee's resting personality when idle", () => {
    for (const e of officeEmployees) {
      const x = expressionFor("idle", e.look)
      expect(x).toEqual({
        eyes: e.look.eyes,
        mouth: e.look.mouth,
        alert: false,
      })
    }
  })

  it("is happy when completed and visibly upset (red) when failed", () => {
    const look = officeEmployees[0].look
    expect(expressionFor("completed", look)).toEqual({
      eyes: "happy",
      mouth: "grin",
      alert: false,
    })
    expect(expressionFor("failed", look)).toEqual({
      eyes: "sad",
      mouth: "frown",
      alert: true,
    })
  })

  it("looks attentive while waiting and focused while working", () => {
    for (const e of officeEmployees) {
      expect(expressionFor("waiting", e.look).mouth).toBe("o")
      expect(["round", "half"]).toContain(expressionFor("working", e.look).eyes)
    }
  })
})

describe("ambient idle scheduler", () => {
  const ids = officeEmployees.map((e) => e.id)

  it("visits every employee in a fixed round-robin order", () => {
    const visited = Array.from(
      { length: ids.length },
      (_, i) => ambientRequestFor(i, ids)[0],
    )
    expect(visited).toEqual(ids)
    expect(ambientRequestFor(ids.length, ids)[0]).toBe(ids[0])
  })

  it("mostly blinks, glancing every third tick, at a relaxed interval", () => {
    const kinds = Array.from(
      { length: 9 },
      (_, i) => ambientRequestFor(i, ids)[1],
    )
    expect(kinds.filter((k) => k === "glance")).toHaveLength(3)
    expect(AMBIENT_INTERVAL_MS).toBeGreaterThanOrEqual(2000)
  })
})
