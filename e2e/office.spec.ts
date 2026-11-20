import {
  clearInteractionState,
  draws,
  expect,
  noHorizontalOverflow,
  officeView,
  openOffice,
  ROOM_VIEWS,
  SEVEN,
  setDirectState,
  test,
  waitForCameraSettled,
  waitForIdleScene,
} from "./fixtures"

const roomRadio = (name: (typeof ROOM_VIEWS)[number]) => ({
  name,
  exact: true,
})

test.describe("3D office (desktop)", () => {
  test("renders the single-floor office with all seven employees", async ({
    page,
  }) => {
    await openOffice(page)
    const nameplates = officeView(page).locator("[aria-hidden='true'] span")
    await expect(nameplates).toHaveCount(7)
    await expect(nameplates).toHaveText([...SEVEN])
    await expect(
      page.getByRole("radio", roomRadio("Entire office")),
    ).toBeChecked()
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
  })

  test("selects each of the seven employees", async ({ page }) => {
    await openOffice(page)
    for (const name of SEVEN) {
      await page.getByRole("radio", { name: new RegExp(`^${name}`) }).click()
      await expect(page.locator("#employee-details-title")).toHaveText(name)
      await expect(
        page.getByRole("radio", roomRadio("Entire office")),
      ).toBeChecked()
      await expect(
        page.locator("p[aria-live='polite'].sr-only").first(),
      ).toContainText(`${name}:`)
    }
  })

  test("keyboard: arrow keys move through the whole team", async ({ page }) => {
    await openOffice(page)
    const member = (name: string) =>
      page.getByRole("radio", { name: new RegExp(`^${name}`) })
    await member("Scout").focus()
    // Roving focus: wait until each arrow press has actually moved focus
    // before the next key, instead of sleeping a fixed time.
    for (const name of ["Quill", "Pixel", "Vera"]) {
      await page.keyboard.press("ArrowDown")
      await expect(member(name)).toBeFocused()
    }
    await page.keyboard.press("Space")
    await expect(page.locator("#employee-details-title")).toHaveText("Vera")
    await expect(member("Vera")).toBeFocused()
    const outline = await page.evaluate(
      () => getComputedStyle(document.activeElement as Element).outlineStyle,
    )
    expect(outline).toBe("solid")

    // One group for all seven: the next arrow reaches the second desk row.
    await page.keyboard.press("ArrowDown")
    await expect(member("Tempo")).toBeFocused()
    await page.keyboard.press("Space")
    await expect(page.locator("#employee-details-title")).toHaveText("Tempo")
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

  test("room controls focus each room of the floor", async ({ page }) => {
    await openOffice(page)
    const scoutPlate = officeView(page).locator("[aria-hidden='true'] span", {
      hasText: "Scout",
    })
    const where = () =>
      scoutPlate.evaluate((el) => (el as HTMLElement).style.transform)
    await waitForCameraSettled(page)
    const office = await where()
    for (const room of ROOM_VIEWS.slice(1)) {
      await page.getByRole("radio", roomRadio(room)).click()
      await expect(page.getByRole("radio", roomRadio(room))).toBeChecked()
      await waitForCameraSettled(page)
      expect(await where(), room).not.toBe(office)
    }
    await page.getByRole("radio", roomRadio("Entire office")).click()
    await waitForCameraSettled(page)
    expect(await where()).toBe(office)
  })

  test("clicking a robot in the 3D scene selects that employee", async ({
    page,
  }) => {
    await openOffice(page)
    await page.getByRole("radio", roomRadio("Operations Room")).click()
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

  test("2D map toggle shows the single-floor plan and stays operable", async ({
    page,
  }) => {
    await openOffice(page)
    await page.getByRole("radio", { name: "2D map" }).click()
    await expect(officeView(page).locator("canvas")).toHaveCount(0)
    for (const room of [
      "Operations Room",
      "Pantry",
      "Gaming & Rest Lounge",
      "Meeting Room",
    ])
      await expect(
        page.getByRole("heading", { level: 3, name: new RegExp(`^${room}`) }),
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
      page.getByRole("radiogroup", { name: "Rooms" }),
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
