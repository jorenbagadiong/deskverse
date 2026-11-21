import { expect, noHorizontalOverflow, test } from "./fixtures"

/**
 * DV-004B: Affiliate Tickets on 360 px and 375 px phones, and by keyboard
 * alone. Database suite only (`yarn test:e2e:db`), on its scratch database.
 */

test.describe.configure({ mode: "serial" })

test("creates and edits a ticket on a phone without sideways scrolling", async ({
  page,
}, testInfo) => {
  await page.goto("/tickets")
  expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
  const nav = page.getByRole("navigation", { name: "Main" })
  await expect(nav.getByRole("link", { name: "Tickets" })).toBeVisible()
  const navBox = (await nav.boundingBox())!
  expect(navBox.x + navBox.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  )

  await page.getByRole("link", { name: "Create Affiliate Ticket" }).click()
  expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
  await page.getByLabel("Title").fill(`Phone ticket ${testInfo.project.name}`)
  await page.getByRole("button", { name: "Save Draft" }).click()
  await expect(page).toHaveURL(/\/tickets\/[0-9a-f-]{36}$/)

  await page.getByRole("button", { name: "Add product" }).click()
  const card = page.locator("article[data-product-id]").first()
  await card.getByLabel("Product name").fill("Travel mug")
  await card.getByLabel("Affiliate link").fill("https://shop.example.com/mug")
  await card.getByRole("button", { name: "Add reference link" }).click()
  await card.getByLabel("Link 1 address").fill("https://maker.example.com/mug")
  await card.getByRole("button", { name: "Save product" }).click()
  await expect(card.getByText("Saved.")).toBeVisible()
  expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
  // Primary actions stay reachable and visible.
  await page
    .getByRole("button", { name: "Mark Ready" })
    .scrollIntoViewIfNeeded()
  await expect(
    page.getByRole("button", { name: "Mark Ready" }),
  ).toBeInViewport()
  await page.getByRole("button", { name: "Mark Ready" }).tap()
  await expect(page.locator("header [data-ticket-status]").first()).toHaveText(
    "Ready",
  )
})
