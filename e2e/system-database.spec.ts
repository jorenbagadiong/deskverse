import type { Page } from "@playwright/test"

import {
  DATABASE_HEALTH_ENDPOINT,
  type DatabaseHealthReport,
} from "../src/lib/system/database-health"
import { expect, noHorizontalOverflow, test } from "./fixtures"

/**
 * DV-004A: the "Local PostgreSQL" status on the overview page. Read-only:
 * these tests never write to any database. The suite's own server uses the
 * test database (see playwright.config.ts), so the real-endpoint test
 * accepts whatever state it is in.
 */

const report = (
  status: DatabaseHealthReport["status"],
  message: string,
  schema: DatabaseHealthReport["schema"] = null,
): DatabaseHealthReport => ({
  status,
  message,
  schema,
  checkedAt: "2026-11-21T10:00:00.000Z",
})

/** `null` answers with something that isn't a health report. */
async function mockHealth(page: Page, body: DatabaseHealthReport | null) {
  await page.route(`**${DATABASE_HEALTH_ENDPOINT}`, (route) =>
    route.fulfill({
      json: body ?? { unexpected: true },
      headers: { "cache-control": "no-store" },
    }),
  )
}

const status = (page: Page) => page.locator("[data-database-status]")

test.describe("Local PostgreSQL status", () => {
  for (const [state, label, message] of [
    [
      "ready",
      "Ready",
      "Local PostgreSQL is running and the schema is up to date.",
    ],
    ["unconfigured", "Not configured", "DATABASE_URL isn't set."],
    [
      "offline",
      "Database not running",
      "Start it with: sudo systemctl start postgresql",
    ],
    ["error", "Connection failed", "refused the password"],
  ] as const) {
    test(`shows ${label}`, async ({ page }) => {
      await mockHealth(page, report(state, `… ${message} …`))
      await page.goto("/")
      await expect(status(page)).toHaveAttribute("data-database-status", state)
      const region = page
        .getByRole("status")
        .filter({ hasText: "Local PostgreSQL" })
      await expect(region).toContainText(label)
      await expect(region).toContainText(message)
    })
  }

  test("explains when the server can't be reached, and checks again", async ({
    page,
  }) => {
    await mockHealth(page, null)
    await page.goto("/")
    await expect(status(page)).toHaveAttribute("data-database-status", "error")
    await expect(
      page.getByText("Couldn't ask the Deskverse server."),
    ).toBeVisible()

    await page.unroute(`**${DATABASE_HEALTH_ENDPOINT}`)
    await mockHealth(
      page,
      report(
        "ready",
        "Local PostgreSQL is running and the schema is up to date.",
        "current",
      ),
    )
    await page.getByRole("button", { name: "Check again" }).click()
    await expect(status(page)).toHaveAttribute("data-database-status", "ready")
  })

  test("fits a 360 px screen", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 })
    await mockHealth(
      page,
      report(
        "offline",
        "Local PostgreSQL isn't running. Start it with: sudo systemctl start postgresql",
      ),
    )
    await page.goto("/")
    await status(page).scrollIntoViewIfNeeded()
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
  })

  test("the real endpoint answers with a safe, uncached report", async ({
    page,
    request,
  }) => {
    const response = await request.get(DATABASE_HEALTH_ENDPOINT)
    expect(response.status()).toBe(200)
    expect(response.headers()["cache-control"]).toBe("no-store")
    const body = await response.json()
    expect(Object.keys(body).sort()).toEqual([
      "checkedAt",
      "message",
      "schema",
      "status",
    ])
    expect(["ready", "unconfigured", "offline", "error"]).toContain(body.status)
    const text = JSON.stringify(body)
    for (const leak of [
      "postgresql://",
      "deskverse_app",
      "deskverse_test",
      "5432",
      "password=",
      "/home/",
    ])
      expect(text).not.toContain(leak)

    await page.goto("/")
    await expect(status(page)).toHaveAttribute(
      "data-database-status",
      body.status,
    )
  })

  test("refuses cross-site requests", async ({ request }) => {
    const response = await request.get(DATABASE_HEALTH_ENDPOINT, {
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    })
    expect(response.status()).toBe(403)
  })
})
