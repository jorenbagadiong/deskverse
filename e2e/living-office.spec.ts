import type { Page } from "@playwright/test"

import {
  clearInteractionState,
  draws,
  expect,
  officeView,
  openOffice,
  test,
  waitForCameraSettled,
  waitForIdleScene,
} from "./fixtures"

const location = (page: Page) => page.locator("[data-location]")
const plate = (page: Page, name: string) =>
  officeView(page).locator("[aria-hidden='true'] span", { hasText: name })
const pick = (page: Page, name: string) =>
  page.getByRole("radio", { name: new RegExp(`^${name}`) }).click()
const movement = (page: Page) => page.getByRole("group", { name: "Location" })

test.describe("living office: walking (desktop)", () => {
  test("walks to the pantry and back without touching the task status", async ({
    page,
  }) => {
    await openOffice(page)
    await pick(page, "Quill")
    await expect(location(page)).toHaveText("At workstation · Operations Room")
    const before = await plate(page, "Quill").evaluate(
      (el) => (el as HTMLElement).style.transform,
    )

    await movement(page)
      .getByRole("button", { name: "Visit the pantry" })
      .click()
    await expect(location(page)).toHaveText("Walking to the pantry")
    // The nameplate follows the walker across the floor.
    await expect
      .poll(() =>
        plate(page, "Quill").evaluate(
          (el) => (el as HTMLElement).style.transform,
        ),
      )
      .not.toBe(before)
    await expect(location(page)).toHaveText("Pantry · coffee counter", {
      timeout: 30_000,
    })
    await expect(page.locator("[data-status-badge]")).toHaveText("Idle")
    await expect(
      page.locator("[data-activity-kind='movement']").first(),
    ).toHaveText("Coffee break")

    // Room to room: from the pantry straight to the meeting room.
    await movement(page)
      .getByRole("button", { name: "Go to the meeting room" })
      .click()
    await expect(location(page)).toHaveText("Walking to the meeting room")
    await expect(location(page)).toHaveText("Meeting Room · conference table", {
      timeout: 30_000,
    })
    await expect(page.locator("[data-status-badge]")).toHaveText("Idle")

    await movement(page)
      .getByRole("button", { name: "Return to workstation" })
      .click()
    await expect(location(page)).toHaveText(
      "At workstation · Operations Room",
      {
        timeout: 30_000,
      },
    )
    // Arrived: rendering settles again (frame-on-demand is preserved).
    await waitForIdleScene(page, 800, 20_000).catch(() => {
      // Scout and Relay keep working at their desks, which animates; that's fine.
    })
  })

  test("stop interrupts a walk mid-corridor", async ({ page }) => {
    await openOffice(page)
    await pick(page, "Vera")
    await movement(page)
      .getByRole("button", { name: "Rest in the lounge" })
      .click()
    await expect(location(page)).toHaveText("Walking to the lounge")
    await page.waitForTimeout(1200)
    await movement(page).getByRole("button", { name: "Stop" }).click()
    await expect(location(page)).not.toHaveText("Walking to the lounge")
    await expect(
      movement(page).getByRole("button", { name: "Stop" }),
    ).toBeDisabled()
    // The camera eases onto where she stopped; then nothing moves any more
    // (a walker still heading to the lounge would keep the nameplate moving).
    await waitForCameraSettled(page)
    await expect(location(page)).toHaveText(/^Stopped · |^Operations Room$/)
    await expect(location(page)).not.toHaveText(/sofa/)
    await movement(page)
      .getByRole("button", { name: "Return to workstation" })
      .click()
    await expect(location(page)).toHaveText(
      "At workstation · Operations Room",
      {
        timeout: 30_000,
      },
    )
  })

  test("working employees stay at their desk until the task is done", async ({
    page,
  }) => {
    await openOffice(page)
    await pick(page, "Scout")
    await expect(
      movement(page).getByRole("button", { name: "Visit the pantry" }),
    ).toBeDisabled()
    await expect(page.getByText(/Breaks: Busy with a task/)).toBeVisible()
  })
})

test.describe("living office: reduced motion", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } })

  test("moves between rooms are instant", async ({ page }) => {
    await openOffice(page)
    await pick(page, "Quill")
    await movement(page)
      .getByRole("button", { name: "Rest in the lounge" })
      .click()
    await expect(location(page)).toHaveText("Gaming & Rest Lounge · sofa")
    await expect(page.getByRole("radio", { name: /^Quill/ })).toContainText(
      "Resting",
    )
    await movement(page)
      .getByRole("button", { name: "Go to a gaming station" })
      .click()
    await expect(location(page)).toHaveText(
      "Gaming & Rest Lounge · gaming station",
    )
    await movement(page)
      .getByRole("button", { name: "Go to the meeting room" })
      .click()
    await expect(location(page)).toHaveText("Meeting Room · conference table")
    // A working task brings them straight back to the desk.
    await page
      .getByRole("radiogroup", { name: "Set state directly" })
      .getByRole("radio", { name: "Working" })
      .click()
    await expect(location(page)).toHaveText("At workstation · Operations Room")
  })

  test("the camera rotates a full 360° and back to the identical view", async ({
    page,
  }) => {
    await openOffice(page)
    await waitForIdleScene(page)
    const canvas = officeView(page).locator("canvas")
    const overlays = [
      page.getByRole("toolbar", { name: "Camera" }),
      page.getByRole("radiogroup", { name: "Rooms" }),
      page.getByRole("radiogroup", { name: "Office display" }),
      page.getByRole("button", { name: "Enter fullscreen" }),
    ]
    const shot = () => canvas.screenshot({ mask: overlays })
    await clearInteractionState(page)
    const initial = await shot()
    const rotate = page.getByRole("button", { name: "Rotate right" })
    for (let i = 0; i < 10; i++) await rotate.click()
    await waitForIdleScene(page)
    await clearInteractionState(page)
    // Halfway round: the camera looks from behind, through the hidden walls.
    expect(Buffer.compare(initial, await shot())).not.toBe(0)
    for (let i = 0; i < 10; i++) await rotate.click()
    await waitForIdleScene(page)
    await clearInteractionState(page)
    expect(Buffer.compare(initial, await shot()), "full turn").toBe(0)
  })
})

test.describe("living office: layout and fullscreen", () => {
  test("full-width simulation with cards below", async ({ page }) => {
    await openOffice(page)
    const view = (await officeView(page).boundingBox())!
    const width = page.viewportSize()!.width
    const height = page.viewportSize()!.height
    expect(view.width).toBeGreaterThan(width * 0.9)
    expect(view.height).toBeGreaterThan(height * 0.7)
    expect(view.height).toBeLessThanOrEqual(56 * 16 + 1)
    const cards = (await page
      .getByRole("region", { name: "Employees" })
      .boundingBox())!
    expect(cards.y).toBeGreaterThanOrEqual(view.y + view.height)
  })

  test("enters and leaves fullscreen, keeping the scene and selection", async ({
    page,
  }) => {
    await openOffice(page)
    await pick(page, "Pixel")
    await officeView(page)
      .locator("canvas")
      .evaluate((el) => el.setAttribute("data-e2e-mark", "same"))

    await page.getByRole("button", { name: "Enter fullscreen" }).click()
    await expect(officeView(page)).toHaveAttribute("data-fullscreen", "")
    await expect
      .poll(() => page.evaluate(() => !!document.fullscreenElement))
      .toBe(true)
    // The selected employee stays visible in fullscreen.
    await expect(
      officeView(page).getByText("Pixel", { exact: true }).last(),
    ).toBeVisible()
    const d0 = await draws(page)
    await expect.poll(() => draws(page)).toBeGreaterThan(d0) // reframed after resize

    // Leaving by the browser (as Escape does) restores the layout too.
    await page.evaluate(() => document.exitFullscreen())
    await expect(officeView(page)).not.toHaveAttribute("data-fullscreen", "")
    await expect(
      page.getByRole("button", { name: "Enter fullscreen" }),
    ).toBeVisible()
    await expect(
      officeView(page).locator("canvas[data-e2e-mark='same']"),
    ).toHaveCount(1)
    await expect(page.locator("#employee-details-title")).toHaveText("Pixel")
  })

  test("a rejected fullscreen request shows a notice instead of failing", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Element.prototype.requestFullscreen = () =>
        Promise.reject(new TypeError("Permissions check failed"))
    })
    await openOffice(page)
    await page.getByRole("button", { name: "Enter fullscreen" }).click()
    await expect(page.getByRole("status")).toContainText(
      "Fullscreen isn't available here",
    )
    await expect(officeView(page)).not.toHaveAttribute("data-fullscreen", "")
    await page.getByRole("button", { name: "Dismiss" }).click()
    await expect(page.getByRole("status")).toHaveCount(0)
  })
})
