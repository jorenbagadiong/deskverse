import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { brandColors, statusColors } from "@/config/design-tokens"

const css = readFileSync(path.join(__dirname, "../src/app/globals.css"), "utf8")

/** Extracts `--name: #hex` declarations from the first block whose selector matches. */
function readBlock(selectorPattern: RegExp): Record<string, string> {
  const match = css.match(selectorPattern)
  if (!match) throw new Error(`Block not found: ${selectorPattern}`)
  const vars: Record<string, string> = {}
  for (const [, name, value] of match[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    vars[name] = value.trim()
  }
  return vars
}

const light = readBlock(/:root,\s*\.light\s*\{([\s\S]*?)\n\}/)
const dark = readBlock(/\n\.dark\s*\{([\s\S]*?)\n\}/)
const themes = { light, dark } as const

/** Resolves `var(--x)` aliases within a theme (dark inherits unset tokens from light). */
function resolve(theme: "light" | "dark", token: string): string {
  const vars = theme === "dark" ? { ...light, ...dark } : light
  let value = vars[token]
  for (let i = 0; i < 5 && value?.startsWith("var("); i++) {
    value = vars[value.slice(4, -1)]
  }
  if (!value) throw new Error(`Unresolved token ${token} (${theme})`)
  return value.toLowerCase()
}

function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe("design tokens", () => {
  it("required brand values match the DV-001 spec", () => {
    expect(resolve("dark", "--background")).toBe("#080f1c")
    expect(resolve("dark", "--surface")).toBe("#111d2e")
    expect(resolve("dark", "--primary")).toBe("#2dd4bf")
    expect(resolve("dark", "--secondary")).toBe("#a78bfa")
    expect(resolve("dark", "--accent")).toBe("#ffb86b")
    expect(resolve("dark", "--foreground")).toBe("#eaf3ff")
    expect(resolve("dark", "--muted-foreground")).toBe("#9eb2c9")
    expect(resolve("light", "--background")).toBe("#f5f8fc")
    expect(resolve("light", "--foreground")).toBe("#17202e")
    expect(resolve("light", "--primary")).toBe("#087d76")
    expect(resolve("light", "--accent")).toBe("#9a4a0a")
  })

  it.each([...brandColors, ...statusColors])(
    "showcase metadata for $token matches globals.css",
    (color) => {
      expect(resolve("dark", color.token)).toBe(color.dark)
      expect(resolve("light", color.token)).toBe(color.light)
    },
  )

  const textPairs: [fg: string, bg: string][] = [
    ["--foreground", "--background"],
    ["--foreground", "--surface"],
    ["--foreground", "--surface-raised"],
    ["--muted-foreground", "--background"],
    ["--muted-foreground", "--surface"],
    ["--muted-foreground", "--muted"],
    ["--primary-foreground", "--primary"],
    ["--secondary-foreground", "--secondary"],
    ["--accent-foreground", "--accent"],
    ["--primary", "--surface"],
    ["--primary", "--background"],
    ["--accent", "--background"],
    ["--destructive", "--surface"],
    ["--status-idle", "--surface"],
    ["--status-working", "--surface"],
    ["--status-waiting", "--surface"],
    ["--status-completed", "--surface"],
    ["--status-failed", "--surface"],
    ["--status-info", "--surface"],
  ]

  for (const theme of Object.keys(themes) as (keyof typeof themes)[]) {
    it.each(textPairs)(`${theme}: %s on %s meets WCAG AA (4.5:1)`, (fg, bg) => {
      expect(
        contrast(resolve(theme, fg), resolve(theme, bg)),
      ).toBeGreaterThanOrEqual(4.5)
    })

    it(`${theme}: focus ring and input borders meet 3:1 non-text contrast`, () => {
      for (const bg of ["--background", "--surface"]) {
        expect(
          contrast(resolve(theme, "--ring"), resolve(theme, bg)),
        ).toBeGreaterThanOrEqual(3)
        expect(
          contrast(resolve(theme, "--input"), resolve(theme, bg)),
        ).toBeGreaterThanOrEqual(3)
      }
    })
  }
})
