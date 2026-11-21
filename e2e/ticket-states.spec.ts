import type { Page } from "@playwright/test"

import type { TicketList } from "../src/lib/tickets/types"
import {
  allowConsoleError,
  expect,
  noHorizontalOverflow,
  test,
} from "./fixtures"

/**
 * DV-004B: the Affiliate Ticket list's states, with the API mocked. Part of
 * the ORDINARY suite (no database writes, safe on a reused server).
 */

const empty: TicketList = { tickets: [], total: 0, page: 1, pageSize: 20 }

async function mockList(
  page: Page,
  respond: (url: URL) => { status: number; json: unknown },
) {
  await page.route("**/api/tickets?**", (route) => {
    const { status, json } = respond(new URL(route.request().url()))
    return route.fulfill({
      status,
      json,
      headers: { "cache-control": "no-store" },
    })
  })
}

test.describe("Affiliate Ticket list states (mocked)", () => {
  test("shows the empty state with a create action", async ({ page }) => {
    await mockList(page, () => ({ status: 200, json: empty }))
    await page.goto("/tickets")
    await expect(page.getByText("No active Affiliate Tickets.")).toBeVisible()
    await expect(
      page.getByRole("link", { name: "Create Affiliate Ticket" }),
    ).toHaveAttribute("href", "/tickets/new")
  })

  test("explains a database outage and retries", async ({ page }) => {
    // The mocked 503 is logged by Chrome as a failed request.
    allowConsoleError(
      page,
      /Failed to load resource: the server responded with a status of 503/,
    )
    let calls = 0
    await mockList(page, () =>
      ++calls === 1
        ? {
            status: 503,
            json: {
              error: "database-unavailable",
              message:
                "Local PostgreSQL isn't running. Start it with: sudo systemctl start postgresql Nothing was saved; your changes are still on this page.",
            },
          }
        : { status: 200, json: empty },
    )
    await page.goto("/tickets")
    await expect(
      page.getByText("Affiliate Tickets are unavailable right now."),
    ).toBeVisible()
    await expect(
      page.getByText(/sudo systemctl start postgresql/),
    ).toBeVisible()
    await page.getByRole("button", { name: "Try again" }).click()
    await expect(page.getByText("No active Affiliate Tickets.")).toBeVisible()
  })

  test("sends search, status and page to the server and paginates", async ({
    page,
  }) => {
    const seen: URL[] = []
    await mockList(page, (url) => {
      seen.push(url)
      const pageNo = Number(url.searchParams.get("page"))
      return {
        status: 200,
        json: {
          total: 45,
          page: pageNo,
          pageSize: 20,
          tickets: Array.from({ length: pageNo === 3 ? 5 : 20 }, (_, i) => ({
            id: `00000000-0000-4000-8000-${String(pageNo * 100 + i).padStart(12, "0")}`,
            number: pageNo * 100 + i,
            displayNumber: `AFT-${String(pageNo * 100 + i).padStart(4, "0")}`,
            title: `Ticket ${pageNo}-${i}`,
            status: "draft",
            priority: "normal",
            platform: "tiktok",
            productCount: i,
            createdAt: "2026-11-21T10:00:00.000Z",
            updatedAt: "2026-11-21T10:00:00.000Z",
          })),
        },
      }
    })
    await page.goto("/tickets")
    await expect(page.getByText("Page 1 of 3")).toBeVisible()
    await page.getByRole("button", { name: "Next" }).click()
    await expect(page.getByText("Ticket 2-0")).toBeVisible()
    await page.getByRole("radio", { name: "Ready" }).click()
    await page.getByLabel("Search tickets").fill("lamp")
    await expect.poll(() => seen.at(-1)?.searchParams.get("q")).toBe("lamp")
    const last = seen.at(-1)!
    expect(last.searchParams.get("status")).toBe("ready")
    expect(last.searchParams.get("page")).toBe("1")
  })

  test("fits a 360 px screen", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 })
    await mockList(page, () => ({ status: 200, json: empty }))
    await page.goto("/tickets")
    await expect(page.getByText("No active Affiliate Tickets.")).toBeVisible()
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
    await page.goto("/tickets/new")
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
  })
})
