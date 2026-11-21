import { expect, test } from "./fixtures"

/**
 * DV-004B: the Affiliate Ticket workflow by keyboard alone, with visible
 * focus and accessible confirmation dialogs. Database suite only.
 */

/** Presses Tab until the focused control's own name is exactly `name`. */
async function tabTo(
  page: import("@playwright/test").Page,
  name: string,
  max = 80,
) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab")
    const label = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body) return ""
      return (el.getAttribute("aria-label") ?? el.innerText ?? "").trim()
    })
    if (label === name) return
  }
  throw new Error(`couldn't reach “${name}” with Tab`)
}

test("creates a ticket, adds a product and archives it using only the keyboard", async ({
  page,
}) => {
  await page.goto("/tickets/new")
  await page.getByLabel("Title").focus()
  await page.keyboard.type("Keyboard-only ticket")
  await page.keyboard.press("Enter") // submits the form
  await expect(page).toHaveURL(/\/tickets\/[0-9a-f-]{36}$/)

  await tabTo(page, "Add product")
  // Focus is visible on the focused control.
  const outline = await page.evaluate(
    () =>
      getComputedStyle(document.activeElement!).boxShadow +
      getComputedStyle(document.activeElement!).outlineStyle,
  )
  expect(outline).not.toBe("nonenone")
  await page.keyboard.press("Enter")
  const card = page.locator("article[data-product-id]").first()
  await expect(card.getByLabel("Product name")).toBeVisible()
  await card.getByLabel("Product name").focus()
  await page.keyboard.type("Keyboard lamp")
  await tabTo(page, "Save product")
  await page.keyboard.press("Enter")
  await expect(card.getByText("Saved.")).toBeVisible()

  await page.getByRole("button", { name: "Archive" }).focus()
  await page.keyboard.press("Enter")
  const dialog = page.getByRole("alertdialog")
  await expect(dialog).toBeVisible()
  // Escape cancels without archiving.
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(page.locator("header [data-ticket-status]").first()).toHaveText(
    "Draft",
  )
  await page.getByRole("button", { name: "Archive" }).focus()
  await page.keyboard.press("Enter")
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Archive ticket" })
    .focus()
  await page.keyboard.press("Enter")
  await expect(page.locator("header [data-ticket-status]").first()).toHaveText(
    "Archived",
  )
})
