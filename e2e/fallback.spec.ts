import { expect, officeView, SEVEN, setDirectState, test } from "./fixtures"

/** Runs in the "no-webgl" project: Chrome launched with WebGL disabled. */
test.describe("WebGL unavailable", () => {
  test("shows the 2D floor plan of both floors, fully operable", async ({
    page,
  }) => {
    await page.goto("/office")
    await expect(page.getByText(/doesn't support WebGL/)).toBeVisible()
    await expect(page.locator("canvas")).toHaveCount(0)
    await expect(
      page.getByRole("heading", { level: 3, name: /Floor 2 · Operations/ }),
    ).toBeVisible()
    await expect(
      page.getByRole("heading", {
        level: 3,
        name: /Floor 1 · Creative Production/,
      }),
    ).toBeVisible()

    const deskButtons = officeView(page).getByRole("button")
    await expect(deskButtons).toHaveCount(7)

    for (const name of SEVEN) {
      await officeView(page)
        .getByRole("button", { name: new RegExp(name) })
        .click()
      await expect(page.locator("#employee-details-title")).toHaveText(name)
    }
    await setDirectState(page, "Failed")
    await expect(page.locator("[data-status-badge]")).toHaveText("Failed")
    await expect(
      officeView(page).getByRole("button", { name: /Ledger/ }),
    ).toContainText("Failed")
  })
})
