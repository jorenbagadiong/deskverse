import { expect, noHorizontalOverflow, test } from "./fixtures"

/** Smoke tests: non-office pages (DV-001 and the DV-003A studio) render cleanly without three.js. */
test.describe("existing pages", () => {
  for (const path of ["/", "/brand", "/studio/pixel"]) {
    test(`${path} renders without errors or three.js`, async ({ page }) => {
      const scripts: string[] = []
      page.on("response", (response) => {
        if (response.url().endsWith(".js")) scripts.push(response.url())
      })
      await page.goto(path)
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
      expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
      const loadsThree = await page.evaluate(async (urls) => {
        const bodies = await Promise.all(
          urls.map(async (u) => (await fetch(u)).text()),
        )
        return bodies.some((b) => b.includes("WebGLRenderer"))
      }, scripts)
      expect(loadsThree).toBe(false)
    })
  }

  test("theme switch persists across reload", async ({ page }) => {
    await page.goto("/brand")
    await page.getByRole("radio", { name: "Light theme" }).first().click()
    await page.reload()
    await expect(page.locator("html")).toHaveClass(/light/)
  })
})
