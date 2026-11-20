import {
  clearInteractionState,
  draws,
  expect,
  FLOOR_OF,
  noHorizontalOverflow,
  officeView,
  openOffice,
  SEVEN,
  setDirectState,
  test,
  waitForCameraSettled,
  waitForIdleScene,
} from "./fixtures"

const floorRadio = (n: 1 | 2) => new RegExp(`^Floor ${n}:`)

test.describe("3D office (desktop)", () => {
  test("renders the two-floor office with all seven employees", async ({
    page,
  }) => {
    await openOffice(page)
    const nameplates = officeView(page).locator("[aria-hidden='true'] span")
    await expect(nameplates).toHaveCount(7)
    await expect(nameplates).toHaveText([...SEVEN])
    await expect(
      page.getByRole("radio", { name: "Whole building" }),
    ).toBeChecked()
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
  })

  test("selects each of the seven employees and activates their floor", async ({
    page,
  }) => {
    await openOffice(page)
    for (const name of SEVEN) {
      await page.getByRole("radio", { name: new RegExp(`^${name}`) }).click()
      await expect(page.locator("#employee-details-title")).toHaveText(name)
      await expect(
        page.getByRole("radio", { name: floorRadio(FLOOR_OF[name]) }),
      ).toBeChecked()
      await expect(
        page.locator("p[aria-live='polite'].sr-only").first(),
      ).toContainText(`${name}:`)
    }
  })

  test("keyboard: arrow keys move within a floor, Tab between floors", async ({
    page,
  }) => {
    await openOffice(page)
    await page.getByRole("radio", { name: /^Scout/ }).focus()
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("ArrowDown")
      await page.waitForTimeout(120)
    }
    await page.keyboard.press("Space")
    await expect(page.locator("#employee-details-title")).toHaveText("Vera")
    const outline = await page.evaluate(
      () => getComputedStyle(document.activeElement as Element).outlineStyle,
    )
    expect(outline).toBe("solid")

    // Tab moves into the Floor 2 group (its first item gets focus).
    await page.keyboard.press("Tab")
    await page.keyboard.press("Space")
    await expect(page.locator("#employee-details-title")).toHaveText("Tempo")
    await expect(page.getByRole("radio", { name: floorRadio(2) })).toBeChecked()
  })

  test("supports all five simulated states and records activity", async ({
    page,
  }) => {
    await openOffice(page)
    await page.getByRole("radio", { name: /^Relay/ }).click()
    for (const state of [
      "Idle",
      "Working",
      "Waiting for approval",
      "Completed",
      "Failed",
    ]) {
      await setDirectState(page, state)
      await expect(page.locator("[data-status-badge]")).toHaveText(state)
    }
    await expect(page.locator("[data-activity-id]").first()).toContainText(
      "Relay is now failed",
    )
    await expect(
      page.getByText("(simulated status)", { exact: false }),
    ).toBeAttached()

    // Contextual simulated actions
    await page.getByRole("button", { name: "Retry" }).click()
    await expect(page.locator("[data-status-badge]")).toHaveText("Working")
    await page.getByRole("button", { name: "Request approval" }).click()
    await expect(page.locator("[data-status-badge]")).toHaveText(
      "Waiting for approval",
    )
    await page.getByRole("button", { name: "Approve" }).click()
    await expect(page.locator("[data-status-badge]")).toHaveText("Completed")
  })

  test("floor controls switch between building, Floor 1 and Floor 2", async ({
    page,
  }) => {
    await openOffice(page)
    const tempoPlate = officeView(page).locator("[aria-hidden='true'] span", {
      hasText: "Tempo",
    })

    await page.getByRole("radio", { name: floorRadio(1) }).click()
    await waitForCameraSettled(page)
    // Floor 2 lifts away: its nameplates are hidden.
    await expect(tempoPlate).toHaveCSS("opacity", "0")

    await page.getByRole("radio", { name: floorRadio(2) }).click()
    await waitForCameraSettled(page)
    await expect(tempoPlate).toHaveCSS("opacity", "1")

    await page.getByRole("radio", { name: "Whole building" }).click()
    await expect(
      page.getByRole("radio", { name: "Whole building" }),
    ).toBeChecked()
  })

  test("clicking a robot in the 3D scene selects that employee", async ({
    page,
  }) => {
    await openOffice(page)
    await page.getByRole("radio", { name: floorRadio(1) }).click()
    await waitForCameraSettled(page)
    const plate = officeView(page).locator("[aria-hidden='true'] span", {
      hasText: "Pixel",
    })
    const box = await plate.boundingBox()
    if (!box) throw new Error("Pixel nameplate not positioned")
    // The nameplate sits just under the robot's feet; the robot is right above it.
    await page.mouse.click(box.x + box.width / 2, box.y - 14)
    await expect(page.locator("#employee-details-title")).toHaveText("Pixel")
  })

  test("2D map toggle shows both floors and stays operable", async ({
    page,
  }) => {
    await openOffice(page)
    await page.getByRole("radio", { name: "2D map" }).click()
    await expect(officeView(page).locator("canvas")).toHaveCount(0)
    await expect(
      page.getByRole("heading", { level: 3, name: /Floor 2 · Operations/ }),
    ).toBeVisible()
    await expect(
      page.getByRole("heading", {
        level: 3,
        name: /Floor 1 · Creative Production/,
      }),
    ).toBeVisible()
    await page.getByRole("button", { name: /Ledger/ }).click()
    await expect(page.locator("#employee-details-title")).toHaveText("Ledger")
    await page.getByRole("radio", { name: "3D", exact: true }).click()
    await expect(officeView(page).locator("canvas")).toBeVisible()
  })

  test("light and dark themes both render the office", async ({ page }) => {
    await openOffice(page, { theme: "light" })
    await expect(page.locator("html")).toHaveClass(/light/)
    await page.getByRole("radio", { name: "Dark theme" }).click()
    await expect(page.locator("html")).toHaveClass(/dark/)
    const before = await draws(page)
    await page.getByRole("radio", { name: "Light theme" }).click()
    await expect(page.locator("html")).toHaveClass(/light/)
    await expect.poll(() => draws(page)).toBeGreaterThan(before)
  })
})

test.describe("reduced motion", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } })

  test("renders on demand only and the camera reset is exact", async ({
    page,
  }) => {
    await openOffice(page)
    await waitForIdleScene(page)
    const d0 = await draws(page)
    await page.waitForTimeout(2500)
    expect(await draws(page), "no continuous rendering").toBe(d0)

    const canvas = officeView(page).locator("canvas")
    // Compare only the 3D render: mask the overlay controls drawn on top of it.
    const overlays = [
      page.getByRole("toolbar", { name: "Camera" }),
      page.getByRole("radiogroup", { name: "Floors" }),
      page.getByRole("radiogroup", { name: "Office display" }),
      page.getByRole("button", { name: "Enter fullscreen" }),
    ]
    const shot = () => canvas.screenshot({ mask: overlays })
    await clearInteractionState(page)
    const initial = await shot()
    await page.getByRole("button", { name: "Zoom in" }).click()
    await page.getByRole("button", { name: "Rotate left" }).click()
    await waitForIdleScene(page)
    await clearInteractionState(page)
    expect(Buffer.compare(initial, await shot())).not.toBe(0)
    await page.getByRole("button", { name: "Reset view" }).click()
    await waitForIdleScene(page)
    await clearInteractionState(page)
    expect(
      Buffer.compare(initial, await shot()),
      "reset restores the view",
    ).toBe(0)
  })

  test("status changes are instant (no Anime.js transforms)", async ({
    page,
  }) => {
    await openOffice(page)
    await page.getByRole("radio", { name: /^Quill/ }).click()
    await setDirectState(page, "Completed")
    await expect(page.locator("[data-status-badge]")).toHaveText("Completed")
    expect(
      await page.locator("[data-status-badge]").getAttribute("style"),
    ).toBeNull()
  })
})
