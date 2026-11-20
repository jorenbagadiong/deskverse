import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { brand } from "@/config/brand"
import { EMPLOYEE_STATUSES, statusMeta } from "@/config/employee-status"
import { employees } from "@/config/employees"

const css = readFileSync(path.join(__dirname, "../src/app/globals.css"), "utf8")

describe("brand config", () => {
  it("has a name and is flagged provisional", () => {
    expect(brand.name.length).toBeGreaterThan(0)
    expect(brand.provisional).toBe(true)
  })
})

describe("employee statuses", () => {
  it("defines exactly the five DV-001 states", () => {
    expect([...EMPLOYEE_STATUSES]).toEqual([
      "idle",
      "working",
      "waiting",
      "completed",
      "failed",
    ])
  })

  it.each(EMPLOYEE_STATUSES)(
    "%s has a label, description and a CSS token in both themes",
    (s) => {
      const meta = statusMeta[s]
      expect(meta.label).toBeTruthy()
      expect(meta.description).toBeTruthy()
      const declarations = css.match(new RegExp(`${meta.token}:`, "g")) ?? []
      expect(declarations.length).toBe(2)
    },
  )
})

describe("employee roster", () => {
  it("contains the seven planned employees with unique ids", () => {
    expect(employees.map((e) => e.name)).toEqual([
      "Scout",
      "Quill",
      "Pixel",
      "Vera",
      "Tempo",
      "Relay",
      "Ledger",
    ])
    expect(new Set(employees.map((e) => e.id)).size).toBe(employees.length)
  })

  it("only uses color tokens that exist in globals.css", () => {
    for (const e of employees) {
      expect(css).toContain(`${e.colorToken}:`)
      expect(EMPLOYEE_STATUSES).toContain(e.sampleStatus)
    }
  })
})
