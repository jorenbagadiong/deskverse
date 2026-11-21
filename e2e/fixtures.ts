import { test as base, expect, type Page } from "@playwright/test"

/** Known third-party noise that is not an app error. */
const IGNORED = [/GL Driver Message/, /GPU stall/]

/**
 * Per-test allowances for console errors a test deliberately provokes,
 * e.g. Chrome's "Failed to load resource: … 503" when a test takes the
 * database down on purpose. Each pattern applies only to the page it was
 * registered for, only in that test, and must actually occur.
 */
const allowances = new WeakMap<Page, { pattern: RegExp; seen: boolean }[]>()

export function allowConsoleError(page: Page, pattern: RegExp) {
  const list = allowances.get(page) ?? []
  list.push({ pattern, seen: false })
  allowances.set(page, list)
}

/**
 * `test` with two extras:
 * - every test fails if the page logs an error or warning (hydration errors included)
 * - WebGL draw calls are counted on window.__draws so tests can verify on-demand rendering
 */
export const test = base.extend<{ consoleProblems: string[] }>({
  consoleProblems: [
    async ({ page }, use) => {
      const problems: string[] = []
      page.on("console", (message) => {
        if (!["error", "warning"].includes(message.type())) return
        const text = message.text()
        if (IGNORED.some((pattern) => pattern.test(text))) return
        const allowed = (allowances.get(page) ?? []).find(
          (a) => message.type() === "error" && a.pattern.test(text),
        )
        if (allowed) {
          allowed.seen = true
          return
        }
        problems.push(`${message.type()}: ${text.slice(0, 300)}`)
      })
      page.on("pageerror", (error) =>
        problems.push(`pageerror: ${error.message}`),
      )
      await page.addInitScript(() => {
        const w = window as unknown as { __draws: number }
        w.__draws = 0
        for (const proto of [
          window.WebGL2RenderingContext?.prototype,
          window.WebGLRenderingContext?.prototype,
        ]) {
          if (!proto) continue
          for (const fn of ["drawElements", "drawArrays"] as const) {
            const original = proto[fn] as (...args: unknown[]) => unknown
            ;(proto as unknown as Record<string, unknown>)[fn] = function (
              this: unknown,
              ...args: unknown[]
            ) {
              w.__draws++
              return original.apply(this, args)
            }
          }
        }
      })
      await use(problems)
      expect(problems, "console errors or warnings").toEqual([])
      const unused = (allowances.get(page) ?? []).filter((a) => !a.seen)
      expect(
        unused.map((a) => String(a.pattern)),
        "allowed console errors that never happened",
      ).toEqual([])
    },
    { auto: true },
  ],
})

export { expect }

export const officeView = (page: Page) =>
  page.getByRole("region", { name: "Office view" })

export async function openOffice(
  page: Page,
  { theme }: { theme?: "light" | "dark" } = {},
) {
  if (theme)
    await page.addInitScript((t) => localStorage.setItem("theme", t), theme)
  await page.goto("/office")
  await expect(officeView(page).locator("canvas")).toBeVisible()
  await page.waitForFunction(
    () => (window as unknown as { __draws: number }).__draws > 0,
  )
}

export const draws = (page: Page) =>
  page.evaluate(() => (window as unknown as { __draws: number }).__draws)

/** Waits until the scene stops rendering (camera and transition tweens finished). */
export async function waitForIdleScene(
  page: Page,
  quietMs = 800,
  timeoutMs = 15_000,
) {
  const start = Date.now()
  let last = await draws(page)
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(quietMs)
    const now = await draws(page)
    if (now === last) return
    last = now
  }
  throw new Error("scene kept rendering")
}

/**
 * Waits until the camera stops moving, judged by the projected nameplates
 * holding still. Works even while working robots keep the scene animating.
 */
export async function waitForCameraSettled(page: Page, timeoutMs = 15_000) {
  const read = () =>
    page.evaluate(() =>
      [
        ...document.querySelectorAll(
          "section[aria-label='Office view'] [aria-hidden='true'] span",
        ),
      ]
        .map((el) => (el as HTMLElement).style.transform)
        .join("|"),
    )
  const start = Date.now()
  let last = await read()
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(400)
    const now = await read()
    if (now === last) return
    last = now
  }
  throw new Error("camera kept moving")
}

/** Removes hover/focus styling from overlays before pixel comparisons. */
export async function clearInteractionState(page: Page) {
  await page.mouse.move(2, 2)
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  )
}

export async function setDirectState(page: Page, label: string) {
  await page
    .getByRole("radiogroup", { name: "Set state directly" })
    .getByRole("radio", { name: label })
    .click()
}

export const SEVEN = [
  "Scout",
  "Quill",
  "Pixel",
  "Vera",
  "Tempo",
  "Relay",
  "Ledger",
] as const
/** Accessible names of the room view buttons. */
export const ROOM_VIEWS = [
  "Entire office",
  "Operations Room",
  "Pantry",
  "Gaming & Rest Lounge",
  "Meeting Room",
] as const

export async function noHorizontalOverflow(page: Page) {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  )
}
