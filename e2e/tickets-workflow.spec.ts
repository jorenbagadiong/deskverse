import type { APIRequestContext, Page } from "@playwright/test"

import {
  allowConsoleError,
  expect,
  noHorizontalOverflow,
  test,
} from "./fixtures"

/**
 * DV-004C: the ticket Workflow section, end to end with a REAL worker
 * process (scripts/e2e/database-server.ts starts one) on the database
 * suite's scratch database. Runs are deterministic verification runs,
 * labelled as test-only; nothing real is researched, written or rendered.
 */

test.describe.configure({ mode: "serial", timeout: 120_000 })

const CONTROL = "http://127.0.0.1:3212"
async function control(action: string) {
  expect(
    (await fetch(`${CONTROL}/${action}`, { method: "POST" })).ok,
    action,
  ).toBe(true)
}

const rid = () => crypto.randomUUID()

/** A ticket with `n` complete products, via the API. Ready unless `draft`. */
async function makeTicket(
  request: APIRequestContext,
  title: string,
  n = 2,
  draft = false,
) {
  const created = await request.post("/api/tickets", {
    data: { requestId: rid(), title },
  })
  let ticket = (await created.json()).ticket
  for (let i = 0; i < n; i++) {
    const added = await request.post(`/api/tickets/${ticket.id}/products`, {
      data: {
        requestId: rid(),
        name: `${title} item ${i + 1}`,
        affiliateUrl: `https://shop.example.com/${i}`,
      },
    })
    ticket = (await added.json()).ticket
  }
  if (!draft) {
    const ready = await request.patch(`/api/tickets/${ticket.id}`, {
      data: { version: ticket.version, status: "ready" },
    })
    ticket = (await ready.json()).ticket
  }
  return ticket as { id: string; version: number }
}

async function startRun(
  request: APIRequestContext,
  ticket: { id: string; version: number },
  verification?: object,
) {
  const response = await request.post(`/api/tickets/${ticket.id}/runs`, {
    data: {
      requestId: rid(),
      ticketVersion: ticket.version,
      mode: "verification",
      ...(verification ? { verification } : {}),
    },
  })
  expect(response.status()).toBe(201)
  return (await response.json()).runId as string
}

const workflow = (page: Page) => page.getByRole("region", { name: "Workflow" })
const runStatus = (page: Page) => workflow(page).getByTestId("run-status")

test("says the full campaign isn't available; verification is labelled test-only and needs a Ready ticket", async ({
  page,
  request,
}) => {
  const ticket = await makeTicket(request, "Workflow availability", 1, true)
  await page.goto(`/tickets/${ticket.id}`)
  const section = workflow(page)
  await expect(section.getByTestId("automation-unavailable")).toContainText(
    "Full campaign automation isn't available yet.",
  )
  // Scout (DV-005A), Quill (DV-005B) and Pixel (DV-005C) exist; Vera doesn't.
  await expect(section.getByTestId("automation-unavailable")).toContainText(
    "Vera (DV-006A)",
  )
  for (const built of ["Scout (DV-005A)", "Quill (DV-005B)", "Pixel (DV-005C)"])
    await expect(
      section.getByTestId("automation-unavailable"),
    ).not.toContainText(built)
  await expect(
    page.getByRole("button", { name: /start (ai )?processing/i }),
  ).toHaveCount(0)
  const start = section.getByRole("button", {
    name: "Start verification run (test only)",
  })
  await expect(start).toBeDisabled()
  await expect(
    section.getByText("Mark the ticket Ready to start a run."),
  ).toBeVisible()
  await expect(section).toContainText(
    "They don't research, write, render or review anything",
  )
  await expect(section.getByText("No runs yet.")).toBeVisible()

  // A full-campaign run is refused by the server with an actionable reason.
  const refused = await request.post(`/api/tickets/${ticket.id}/runs`, {
    data: {
      requestId: rid(),
      ticketVersion: ticket.version,
      mode: "production",
    },
  })
  expect(refused.status()).toBe(503)
  expect((await refused.json()).message).toMatch(
    /Full campaign automation isn't available yet.*Nothing was started/,
  )
})

test("a verification run executes on the worker and shows persisted status", async ({
  page,
  request,
}) => {
  const ticket = await makeTicket(request, "Workflow run", 2)
  await page.goto(`/tickets/${ticket.id}`)
  const start = workflow(page).getByRole("button", {
    name: "Start verification run (test only)",
  })
  await start.focus()
  await page.keyboard.press("Enter") // keyboard works
  await expect(
    workflow(page).getByRole("heading", {
      name: "Verification run (test only)",
    }),
  ).toBeVisible()
  await expect(runStatus(page)).toHaveText("Completed", { timeout: 60_000 })
  await expect(workflow(page).getByTestId("run-counts")).toContainText(
    "8 of 8 steps finished · 8 completed",
  )
  // Finished: no run controls, and the labels never claim real work.
  await expect(
    workflow(page).getByRole("group", { name: "Run controls" }),
  ).toHaveCount(0)
  await expect(workflow(page)).toContainText("Verification step 3 · Completed")
  await expect(page.locator("body")).not.toContainText(
    /video (is )?ready|script written|research complete/i,
  )
  await page.reload()
  await expect(runStatus(page)).toHaveText("Completed")
  await workflow(page)
    .getByText(/^Task history/)
    .click()
  await expect(
    workflow(page).getByRole("list", { name: "Run history" }),
  ).toContainText("run finished")
})

test("pause, resume and cancel are offered only when valid", async ({
  page,
  request,
}) => {
  const ticket = await makeTicket(request, "Workflow controls", 3)
  await startRun(request, ticket, { durationMs: 1_500 })
  await page.goto(`/tickets/${ticket.id}`)
  const controls = workflow(page).getByRole("group", { name: "Run controls" })
  await expect(runStatus(page)).toHaveText(/Queued|Running/)
  await expect(controls.getByRole("button", { name: "Resume" })).toHaveCount(0)
  await controls.getByRole("button", { name: "Pause" }).click()
  await expect(runStatus(page)).toHaveText("Paused", { timeout: 20_000 })
  await expect(controls.getByRole("button", { name: "Pause" })).toHaveCount(0)
  await controls.getByRole("button", { name: "Resume" }).click()
  await expect(runStatus(page)).toHaveText(/Running|Queued/)
  await controls.getByRole("button", { name: "Cancel run" }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Cancel run" })
    .click()
  await expect(runStatus(page)).toHaveText("Cancelled", { timeout: 20_000 })
  await expect(
    workflow(page).getByRole("group", { name: "Run controls" }),
  ).toHaveCount(0)
  await expect(
    workflow(page).locator('[data-task-status="completed"]').first(),
  ).toBeVisible()
})

test("a failed step blocks only its own product and can be retried", async ({
  page,
  request,
}) => {
  const ticket = await makeTicket(request, "Workflow failure", 2)
  await startRun(request, ticket, {
    durationMs: 100,
    faults: [{ product: 0, stage: "verify.compute", kind: "permanent" }],
  })
  await page.goto(`/tickets/${ticket.id}`)
  await expect(runStatus(page)).toHaveText("Completed with errors", {
    timeout: 60_000,
  })
  const first = workflow(page).getByRole("list", {
    name: "Workflow failure item 1: steps",
  })
  await expect(first.locator('[data-task-status="failed"]')).toHaveCount(1)
  await expect(first.locator('[data-task-status="blocked"]')).toHaveCount(2)
  const second = workflow(page).getByRole("list", {
    name: "Workflow failure item 2: steps",
  })
  await expect(second.locator('[data-task-status="completed"]')).toHaveCount(4)
  await first
    .getByRole("button", { name: /^Retry Verification step 2/ })
    .click()
  // The injected fault is permanent, so the retry fails again: attempt 2.
  await expect(
    first.getByText(/Verification step 2 · Failed \(attempt 2\)/),
  ).toBeVisible({ timeout: 30_000 })
  await expect(runStatus(page)).toHaveText("Completed with errors")
})

test("protects the inputs of an unfinished run and explains why", async ({
  page,
  request,
}) => {
  allowConsoleError(
    page,
    /Failed to load resource: the server responded with a status of 409/,
  )
  const ticket = await makeTicket(request, "Workflow retention", 1)
  const runId = await startRun(request, ticket, { durationMs: 3_000 })
  await page.goto(`/tickets/${ticket.id}`)
  const card = page.locator("article[data-product-id]").first()
  const toggle = card.locator("header button[aria-expanded]")
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click()
  await card.getByRole("button", { name: "Remove product" }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Remove product" })
    .click()
  await expect(
    card.getByText(/part of a workflow run that hasn't finished/),
  ).toBeVisible()
  await expect(page.locator("article[data-product-id]")).toHaveCount(1)
  await request.post(`/api/tickets/${ticket.id}/runs/${runId}/cancel`, {
    data: { requestId: rid() },
  })
})

test("explains a database outage in the workflow section", async ({
  page,
  request,
}) => {
  allowConsoleError(
    page,
    /Failed to load resource: the server responded with a status of 503/,
  )
  const ticket = await makeTicket(request, "Workflow outage", 1)
  await page.goto(`/tickets/${ticket.id}`)
  await expect(
    workflow(page).getByRole("button", {
      name: "Start verification run (test only)",
    }),
  ).toBeEnabled()
  await control("database/offline")
  try {
    await workflow(page)
      .getByRole("button", { name: "Start verification run (test only)" })
      .click()
    await expect(workflow(page).getByRole("alert").first()).toContainText(
      "Local PostgreSQL isn't running",
    )
  } finally {
    await control("database/online")
  }
  await page.reload()
  await expect(workflow(page).getByText("No runs yet.")).toBeVisible()
})

test("fits a 360 px screen", async ({ page, request }) => {
  const ticket = await makeTicket(request, "Workflow phone", 2)
  await startRun(request, ticket, { durationMs: 50 })
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto(`/tickets/${ticket.id}`)
  await expect(runStatus(page)).toHaveText("Completed", { timeout: 60_000 })
  await workflow(page).scrollIntoViewIfNeeded()
  expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
})
