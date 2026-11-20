import {
  expect,
  noHorizontalOverflow,
  officeView,
  openOffice,
  SEVEN,
  test,
} from "./fixtures"

test.describe("3D office (mobile)", () => {
  test("fits the screen with simplified controls and no overlap", async ({
    page,
  }) => {
    await openOffice(page)
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)

    // Full-width simulation, cards stacked below it.
    const view = await officeView(page).boundingBox()
    const cards = await page
      .getByRole("region", { name: "Employees" })
      .boundingBox()
    const width = page.viewportSize()!.width
    expect(view && cards && cards.y >= view.y + view.height).toBeTruthy()
    expect(view!.width).toBeGreaterThan(width - 40)
    expect(view!.height).toBeGreaterThanOrEqual(22 * 16 - 1)

    await expect(page.getByRole("button", { name: "Rotate left" })).toBeHidden()
    await expect(page.getByRole("button", { name: "Zoom in" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Reset view" })).toBeVisible()
    await expect(
      page.getByRole("radio", { name: "Whole building" }),
    ).toBeVisible()
  })

  test("every employee can be selected by tapping the list", async ({
    page,
  }) => {
    await openOffice(page)
    for (const name of SEVEN) {
      await page.getByRole("radio", { name: new RegExp(`^${name}`) }).tap()
      await expect(page.locator("#employee-details-title")).toHaveText(name)
    }
  })

  test("floor switcher works on touch", async ({ page }) => {
    await openOffice(page)
    await page.getByRole("radio", { name: /^Floor 2:/ }).tap()
    await expect(page.getByRole("radio", { name: /^Floor 2:/ })).toBeChecked()
  })
})
