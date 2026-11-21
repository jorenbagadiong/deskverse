import type { APIRequestContext, Page } from "@playwright/test"

import { FIXTURE_PRODUCTS } from "../scripts/scout/fixture-sites"
import { expect, noHorizontalOverflow, test } from "./fixtures"

/**
 * DV-005A: the Scout Research section, end to end with a REAL worker
 * process doing real retrieval and extraction (scripts/e2e/database-server.ts)
 * against local FIXTURE sites through Scout's test network (scratch test
 * database only). No real website is contacted.
 */

test.describe.configure({ mode: "serial", timeout: 150_000 })

const CONTROL = "http://127.0.0.1:3212"
async function control(action: string) {
  expect(
    (await fetch(`${CONTROL}/${action}`, { method: "POST" })).ok,
    action,
  ).toBe(true)
}
const rid = () => crypto.randomUUID()

type Fixture = (typeof FIXTURE_PRODUCTS)[keyof typeof FIXTURE_PRODUCTS]

async function makeTicket(
  request: APIRequestContext,
  title: string,
  products: Fixture[],
  ready = true,
) {
  const created = await request.post("/api/tickets", {
    data: { requestId: rid(), title },
  })
  let ticket = (await created.json()).ticket
  for (const p of products) {
    const added = await request.post(`/api/tickets/${ticket.id}/products`, {
      data: {
        requestId: rid(),
        name: p.name,
        affiliateUrl: p.affiliateUrl,
        specifications: p.specifications,
        description: p.description,
        references: p.references,
      },
    })
    expect(added.status(), await added.text()).toBe(201)
    ticket = (await added.json()).ticket
  }
  if (ready) {
    const r = await request.patch(`/api/tickets/${ticket.id}`, {
      data: { version: ticket.version, status: "ready" },
    })
    ticket = (await r.json()).ticket
  }
  return ticket as { id: string; version: number; products: { id: string }[] }
}

const research = (page: Page) =>
  page.getByRole("region", { name: "Scout Research" })
const runStatus = (page: Page) =>
  research(page).getByTestId("research-run-status")

async function startResearch(page: Page) {
  await research(page).getByRole("button", { name: "Start research" }).click()
  const dialog = page.getByRole("alertdialog")
  await expect(dialog).toContainText("Start Scout research?")
  await dialog.getByRole("button", { name: "Start research" }).click()
}

const productCard = (page: Page, name: string) =>
  research(page)
    .getByRole("list", { name: "Research by product" })
    .locator("li[data-research-task-status]")
    .filter({ has: page.getByText(name, { exact: true }) })

test("shows that research is on, what it does, and that it needs a Ready ticket", async ({
  page,
  request,
}) => {
  const ticket = await makeTicket(
    request,
    "Research availability",
    [FIXTURE_PRODUCTS.kettle],
    false,
  )
  await page.goto(`/tickets/${ticket.id}`)
  const section = research(page)
  await expect(section.getByTestId("research-availability")).toContainText(
    "Research only",
  )
  await expect(section.getByTestId("research-availability")).toContainText(
    "never visits affiliate links",
  )
  await expect(section.getByTestId("worker-status")).toContainText("running")
  await expect(section.getByTestId("extraction-status")).toContainText(
    "deterministic",
  )
  await expect(
    section.getByRole("button", { name: "Start research" }),
  ).toBeDisabled()
  await expect(section.getByTestId("research-blocked")).toHaveText(
    "Mark the ticket Ready to start research.",
  )
  await expect(section.getByText("No research yet.")).toBeVisible()
})

test("researches a batch: evidence-backed claims, conflicts, and honest needs-input reasons", async ({
  page,
  request,
}) => {
  page.on("dialog", (d) => {
    throw new Error(`unexpected dialog: ${d.message()}`)
  })
  const ticket = await makeTicket(request, "Research batch", [
    FIXTURE_PRODUCTS.kettle,
    FIXTURE_PRODUCTS.buds,
    FIXTURE_PRODUCTS.lamp,
    FIXTURE_PRODUCTS.fan,
  ])
  await page.goto(`/tickets/${ticket.id}`)
  await expect(
    research(page).getByTestId("research-missing-references"),
  ).toContainText("Orbit Fan F1")
  await research(page).getByRole("button", { name: "Start research" }).click()
  await expect(page.getByRole("alertdialog")).toContainText("acme.example")
  await expect(page.getByRole("alertdialog")).not.toContainText("affiliate")
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Start research" })
    .click()
  await expect(runStatus(page)).toHaveText("Completed with errors", {
    timeout: 90_000,
  })
  // The Workflow section shows the same run, labelled research-only.
  await expect(
    page
      .getByRole("region", { name: "Workflow" })
      .getByRole("heading", { name: "Research run (Scout only)" }),
  ).toBeVisible()

  // Inaccessible sources: the reasons, not invented facts.
  const lamp = productCard(page, FIXTURE_PRODUCTS.lamp.name)
  await expect(lamp).toHaveAttribute("data-research-task-status", "needs_input")
  await expect(lamp.getByTestId("research-task-message")).toContainText(
    "couldn't use any reference",
  )
  const problems = lamp.getByRole("list", {
    name: `${FIXTURE_PRODUCTS.lamp.name}: source problems`,
  })
  for (const text of [
    "Not allowed by robots.txt",
    "Access refused (HTTP 403)",
    "CAPTCHA or bot check",
    "Needs JavaScript",
    "Login required",
  ])
    await expect(problems).toContainText(text)
  await expect(
    productCard(page, FIXTURE_PRODUCTS.fan.name).getByTestId(
      "research-task-message",
    ),
  ).toContainText("No research references")

  // Supported, unverified and sensitive claims, each with evidence.
  const kettle = productCard(page, FIXTURE_PRODUCTS.kettle.name)
  await kettle.getByText("Research brief").click()
  const brief = kettle.getByTestId("research-report")
  await expect(brief.getByTestId("report-integrity")).toHaveText(
    "Checksum verified",
  )
  const supported = brief.getByTestId("research-supported")
  const capacity = supported
    .locator("li[data-claim-status=supported]")
    .filter({ hasText: "Capacity: 1.7 L" })
  // JSON-LD and the spec table on the manufacturer page (S1), and the shop's list (S2).
  await expect(capacity.locator("[data-relationship=supports]")).toHaveCount(3)
  await expect(
    capacity.locator("[data-evidence-key]").filter({ hasText: "· S1" }),
  ).toHaveCount(2)
  await expect(
    capacity.locator("[data-evidence-key]").filter({ hasText: "· S2" }),
  ).toHaveCount(1)
  await expect(capacity).toContainText("Capacity: 1.7 L")
  await expect(capacity.locator("blockquote").first()).toContainText("1.7")
  const unverified = brief.getByTestId("research-unverified")
  await expect(unverified).toContainText("Keeps water hot for 2 hours.")
  await expect(
    unverified.locator("li").filter({ hasText: "Warranty: 5 years" }),
  ).toContainText("Sensitive: warranty")
  await expect(
    unverified
      .locator("li")
      .filter({ hasText: "The best kettle on the market." }),
  ).toContainText("Sensitive: comparative claim")
  await expect(
    brief.getByRole("region", { name: "Time-sensitive information" }),
  ).toContainText("may have changed")
  await expect(
    brief.getByRole("region", { name: "Factual selling points" }),
  ).not.toContainText("49.99")

  // Source text is shown as text: a literal <img onerror> stays text.
  await expect(brief).toContainText(
    "Brushed steel <img src=x onerror=alert(1)>",
  )
  await expect(brief.locator("img")).toHaveCount(0)
  // External source links are safe.
  const link = brief.getByTestId("research-sources").getByRole("link").first()
  await expect(link).toHaveAttribute("target", "_blank")
  await expect(link).toHaveAttribute("rel", /noopener/)
  await expect(link).toHaveAttribute("rel", /noreferrer/)
  await expect(link).toHaveAttribute("href", /^https:\/\/acme\.example\//)

  // Conflicting sources.
  const buds = productCard(page, FIXTURE_PRODUCTS.buds.name)
  await buds.getByText("Research brief").click()
  const conflicts = buds
    .getByTestId("research-report")
    .getByTestId("research-conflicts")
  const battery = conflicts
    .locator("li[data-claim-status=conflicting]")
    .filter({ hasText: "Battery life: 30 hours" })
  await expect(battery).toContainText("S2 states 24 hours")
  await expect(battery.locator("[data-relationship=contradicts]")).toHaveCount(
    1,
  )
  await expect(battery.locator("[data-relationship=supports]")).toHaveCount(1)

  // The report API: exact ownership, bounded evidence pages, strict input.
  const runs = await (
    await request.get(`/api/tickets/${ticket.id}/runs`)
  ).json()
  const runId = runs.runs[0].id
  const detail = await (
    await request.get(`/api/tickets/${ticket.id}/runs/${runId}`)
  ).json()
  const snapshot = detail.products[0].snapshotId
  const base = `/api/tickets/${ticket.id}/runs/${runId}/research/${snapshot}`
  const page1 = await request.get(`${base}?evidenceLimit=1`)
  expect(page1.status()).toBe(200)
  expect(page1.headers()["cache-control"]).toBe("no-store")
  const body = await page1.json()
  expect(body.evidence.items).toHaveLength(1)
  expect(body.evidence.total).toBeGreaterThan(1)
  expect(JSON.stringify(body)).not.toMatch(
    /\/home\/|postgres(ql)?:\/\/|password/i,
  )
  expect((await request.get(`${base}?evidenceLimit=1000`)).status()).toBe(400)
  expect((await request.get(`${base}?other=1`)).status()).toBe(400)
  expect(
    (
      await request.get(
        `/api/tickets/${ticket.id}/runs/${runId}/research/${detail.products[2].snapshotId}`,
      )
    ).status(),
  ).toBe(404)
  const other = await makeTicket(
    request,
    "Research other",
    [FIXTURE_PRODUCTS.kettle],
    false,
  )
  expect(
    (
      await request.get(
        `/api/tickets/${other.id}/runs/${runId}/research/${snapshot}`,
      )
    ).status(),
  ).toBe(404)

  // The full campaign stays refused.
  const campaign = await request.post(`/api/tickets/${ticket.id}/runs`, {
    data: {
      requestId: rid(),
      ticketVersion: ticket.version,
      mode: "production",
      workflow: "campaign-v1",
    },
  })
  expect(campaign.status()).toBe(503)
  expect((await campaign.json()).message).toMatch(
    /Full campaign automation isn't available yet/,
  )
})

test("waits for a worker when none is running, then finishes once one starts", async ({
  page,
  request,
}) => {
  const ticket = await makeTicket(request, "Research waits", [
    FIXTURE_PRODUCTS.kettle,
  ])
  await control("worker/stop")
  try {
    await page.goto(`/tickets/${ticket.id}`)
    await expect(research(page).getByTestId("worker-status")).toContainText(
      "not running",
    )
    await startResearch(page)
    await expect(runStatus(page)).toHaveText("Queued")
    await expect(
      research(page).getByTestId("research-needs-worker"),
    ).toContainText("yarn worker:start")
  } finally {
    await control("worker/start")
  }
  await expect(runStatus(page)).toHaveText("Completed", { timeout: 90_000 })
})

test("an owner edit needs a new run; earlier research versions stay available", async ({
  page,
  request,
}) => {
  const ticket = await makeTicket(request, "Research versions", [
    FIXTURE_PRODUCTS.buds,
  ])
  await page.goto(`/tickets/${ticket.id}`)
  await startResearch(page)
  await expect(runStatus(page)).toHaveText("Completed", { timeout: 90_000 })
  // Edit the claim (the ticket returns to Draft), mark it Ready, research again.
  const current = await (await request.get(`/api/tickets/${ticket.id}`)).json()
  const productId = current.ticket.products[0].id
  const edited = await request.patch(
    `/api/tickets/${ticket.id}/products/${productId}`,
    {
      data: { specifications: "Battery life: 24 hours" },
    },
  )
  expect(edited.status(), await edited.text()).toBe(200)
  const draft = (await edited.json()).ticket
  expect(draft.status).toBe("draft")
  await request.patch(`/api/tickets/${ticket.id}`, {
    data: { version: draft.version, status: "ready" },
  })
  await page.reload()
  await expect(
    research(page).getByText(/the ticket changed since/),
  ).toBeVisible()
  await startResearch(page)
  await expect(runStatus(page)).toHaveText("Completed", { timeout: 90_000 })
  const history = research(page).getByTestId("research-history")
  await history.locator("summary").click()
  await expect(history).toContainText("version 1")
  await history.getByRole("button", { name: "View" }).click()
  await expect(history.getByTestId("research-report")).toContainText(
    "Battery life: 30 hours",
  )
  const latest = productCard(page, FIXTURE_PRODUCTS.buds.name)
  await latest.getByText("Research brief").click()
  await expect(latest.getByTestId("research-report")).toContainText("Version 2")
  await expect(
    latest.getByTestId("research-report").getByTestId("research-unverified"),
  ).not.toContainText("30 hours")
})

for (const width of [360, 375])
  test(`fits a ${width} px screen with a brief open`, async ({
    page,
    request,
  }) => {
    const ticket = await makeTicket(request, `Research ${width}`, [
      FIXTURE_PRODUCTS.kettle,
    ])
    await page.setViewportSize({ width, height: 800 })
    await page.goto(`/tickets/${ticket.id}`)
    await startResearch(page)
    await expect(runStatus(page)).toHaveText("Completed", { timeout: 90_000 })
    await productCard(page, FIXTURE_PRODUCTS.kettle.name)
      .getByText("Research brief")
      .click()
    await expect(research(page).getByTestId("research-report")).toBeVisible()
    await research(page).scrollIntoViewIfNeeded()
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
  })
