import type { APIRequestContext, Page } from "@playwright/test"

import { FIXTURE_PRODUCTS } from "../scripts/scout/fixture-sites"
import { expect, noHorizontalOverflow, test } from "./fixtures"

/**
 * DV-005B: the Quill Scripts section end to end, with a REAL worker
 * (scripts/e2e/database-server.ts) that researches local fixture sites
 * (Scout) and writes scripts from those reports (Quill, template mode).
 */

test.describe.configure({ mode: "serial", timeout: 180_000 })

const CONTROL = "http://127.0.0.1:3212"
async function control(action: string) {
  expect(
    (await fetch(`${CONTROL}/${action}`, { method: "POST" })).ok,
    action,
  ).toBe(true)
}
const rid = () => crypto.randomUUID()

const NARROW = {
  ...FIXTURE_PRODUCTS.buds,
  name: "Nova Buds X3 (one source)",
  references: [
    { kind: "listing", url: "https://shop.example/p/nova-x3", label: "" },
  ],
}
type Product = {
  name: string
  affiliateUrl: string
  specifications: string
  description: string
  references: readonly { kind: string; url: string; label: string }[]
}

async function makeTicket(
  request: APIRequestContext,
  title: string,
  products: Product[],
  ready = true,
) {
  let ticket = (
    await (
      await request.post("/api/tickets", { data: { requestId: rid(), title } })
    ).json()
  ).ticket
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
    ticket = (await added.json()).ticket
  }
  if (ready)
    ticket = (
      await (
        await request.patch(`/api/tickets/${ticket.id}`, {
          data: { version: ticket.version, status: "ready" },
        })
      ).json()
    ).ticket
  return ticket as { id: string; version: number; products: { id: string }[] }
}

async function research(
  request: APIRequestContext,
  ticket: { id: string; version: number },
) {
  const r = await request.post(`/api/tickets/${ticket.id}/runs`, {
    data: {
      requestId: rid(),
      ticketVersion: ticket.version,
      mode: "production",
      workflow: "scout-research-v1",
    },
  })
  expect(r.status(), await r.text()).toBe(201)
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/tickets/${ticket.id}/research`)).json())
          .latestRun?.status,
      { timeout: 90_000 },
    )
    .toMatch(/^completed/)
}

const quill = (page: Page) =>
  page.getByRole("region", { name: "Quill Scripts" })
const runStatus = (page: Page) => quill(page).getByTestId("quill-run-status")
const taskCard = (page: Page, name: string) =>
  quill(page)
    .getByRole("list", { name: "Scripts by product" })
    .locator("li[data-quill-task-status]")
    .filter({ has: page.getByText(name, { exact: true }) })

test("explains what Quill needs before scripts can be written", async ({
  page,
  request,
}) => {
  const ticket = await makeTicket(
    request,
    "Quill availability",
    [FIXTURE_PRODUCTS.kettle],
    false,
  )
  await page.goto(`/tickets/${ticket.id}`)
  const section = quill(page)
  await expect(section.getByTestId("quill-availability")).toContainText(
    "Scriptwriting only",
  )
  await expect(section.getByTestId("quill-mode")).toContainText(
    "templates (no AI model)",
  )
  await expect(section.getByText("No Scout research yet.")).toBeVisible()
  await expect(
    section.getByRole("button", { name: "Start scriptwriting" }),
  ).toBeDisabled()
  await expect(section.getByTestId("quill-blocked")).toHaveText(
    "Mark the ticket Ready to write scripts.",
  )
  await expect(section.getByText("No scripts yet.")).toBeVisible()
})

test("writes evidence-linked scripts from chosen research; a product without enough facts needs input", async ({
  page,
  request,
}) => {
  page.on("dialog", (d) => {
    throw new Error(`unexpected dialog: ${d.message()}`)
  })
  const ticket = await makeTicket(request, "Quill batch", [
    FIXTURE_PRODUCTS.kettle,
    NARROW,
  ])
  await research(request, ticket)
  await page.goto(`/tickets/${ticket.id}`)
  const kettleSelect = quill(page).getByLabel(FIXTURE_PRODUCTS.kettle.name, {
    exact: true,
  })
  await expect(kettleSelect).toHaveValue(/[0-9a-f-]{36}/)
  await expect(kettleSelect.locator("option:checked")).toContainText(
    "matches the current product",
  )
  // The narrow product's only report has too few usable facts: no default choice.
  await expect(quill(page).getByTestId("quill-no-usable")).toContainText(
    "Quill needs 2",
  )
  // Choose it anyway through the API to see Quill's own answer.
  const overview = await (
    await request.get(`/api/tickets/${ticket.id}/scripts`)
  ).json()
  const narrowReport = overview.products[1].reports[0].reportId
  const run = await request.post(`/api/tickets/${ticket.id}/runs`, {
    data: {
      requestId: rid(),
      ticketVersion: ticket.version,
      mode: "production",
      workflow: "quill-script-v1",
      scripts: [
        {
          productId: overview.products[0].productId,
          reportId: overview.products[0].reports[0].reportId,
        },
        { productId: overview.products[1].productId, reportId: narrowReport },
      ],
    },
  })
  expect(run.status(), await run.text()).toBe(201)
  await page.reload()
  await expect(runStatus(page)).toHaveText("Completed with errors", {
    timeout: 90_000,
  })
  await expect(
    page
      .getByRole("region", { name: "Workflow" })
      .getByRole("heading", { name: "Scriptwriting run (Quill only)" }),
  ).toBeVisible()
  await expect(
    taskCard(page, NARROW.name).getByTestId("quill-task-message"),
  ).toContainText(/Quill needs 2.*run Scout again/)

  const kettle = taskCard(page, FIXTURE_PRODUCTS.kettle.name)
  await kettle.getByText("Script", { exact: true }).click()
  const script = kettle.getByTestId("quill-script")
  await expect(script.getByTestId("script-integrity")).toHaveText(
    "Checksum verified",
  )
  await expect(script).toContainText("Template (no AI model)")
  const scenes = script.getByRole("list", { name: "Scenes" }).locator("> li")
  await expect(scenes.first()).toHaveAttribute("data-scene-kind", "hook")
  await expect(scenes.last()).toHaveAttribute(
    "data-scene-kind",
    "call-to-action",
  )
  const capacity = scenes.filter({ hasText: "Capacity: 1.7 L" })
  await expect(capacity).toHaveAttribute("data-scene-kind", "benefit")
  await expect(capacity).toContainText("The capacity is 1.7 L.")
  await expect(capacity.locator("[data-evidence-key]").first()).toContainText(
    "acme.example",
  )
  await expect(scenes.first()).toContainText("No product facts in this scene.")
  await expect(script.getByTestId("script-disclosure")).toContainText(
    "#ad · I may earn a commission",
  )
  await expect(script.getByTestId("script-pixel")).toContainText(
    "Pixel text limits: compatible",
  )
  await expect(script.getByTestId("script-pixel")).toContainText(
    "needs 3–6 product images",
  )
  await script.getByText(/^Not used in the script/).click()
  await expect(script.getByTestId("script-excluded")).toContainText(
    "Warranty: 5 years: No source supports it.",
  )
  await expect(script.getByTestId("script-excluded")).toContainText(
    "Sensitive (price)",
  )
  // Nothing sensitive, invented or unsafe in the script text itself.
  const text = (
    await script.getByRole("list", { name: "Scenes" }).innerText()
  ).toLowerCase()
  expect(text).not.toMatch(
    /49\.99|4\.6|best|warranty|guarantee|i tested|in stock|<img/,
  )

  // Read API: ownership, bounded listing, no-store.
  const runs = await (
    await request.get(`/api/tickets/${ticket.id}/runs`)
  ).json()
  const runId = runs.runs[0].id
  const listed = await request.get(
    `/api/tickets/${ticket.id}/runs/${runId}/scripts?limit=1`,
  )
  expect(listed.headers()["cache-control"]).toBe("no-store")
  const scriptId = (await listed.json()).scripts[0].id
  expect(
    (
      await request.get(
        `/api/tickets/${ticket.id}/runs/${runId}/scripts?limit=500`,
      )
    ).status(),
  ).toBe(400)
  const other = await makeTicket(
    request,
    "Quill other",
    [FIXTURE_PRODUCTS.kettle],
    false,
  )
  expect(
    (
      await request.get(
        `/api/tickets/${other.id}/runs/${runId}/scripts/${scriptId}`,
      )
    ).status(),
  ).toBe(404)
  const body = await (
    await request.get(
      `/api/tickets/${ticket.id}/runs/${runId}/scripts/${scriptId}`,
    )
  ).json()
  expect(JSON.stringify(body)).not.toMatch(
    /\/home\/|postgres(ql)?:\/\/|password/i,
  )
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
  expect((await campaign.json()).message).toMatch(/result handoffs/)

  // Scripts survive an application restart.
  await control("restart")
  await page.reload()
  await taskCard(page, FIXTURE_PRODUCTS.kettle.name)
    .getByText("Script", { exact: true })
    .click()
  await expect(
    taskCard(page, FIXTURE_PRODUCTS.kettle.name).getByTestId(
      "script-integrity",
    ),
  ).toHaveText("Checksum verified")
})

test("refuses research made before the product changed", async ({
  page,
  request,
}) => {
  const ticket = await makeTicket(request, "Quill stale", [
    FIXTURE_PRODUCTS.kettle,
  ])
  await research(request, ticket)
  const detail = (await (await request.get(`/api/tickets/${ticket.id}`)).json())
    .ticket
  const productId = detail.products[0].id
  const old = (
    await (await request.get(`/api/tickets/${ticket.id}/scripts`)).json()
  ).products[0].reports[0].reportId
  const edited = (
    await (
      await request.patch(`/api/tickets/${ticket.id}/products/${productId}`, {
        data: { description: "Updated after research." },
      })
    ).json()
  ).ticket
  const ready = (
    await (
      await request.patch(`/api/tickets/${ticket.id}`, {
        data: { version: edited.version, status: "ready" },
      })
    ).json()
  ).ticket
  await page.goto(`/tickets/${ticket.id}`)
  const select = quill(page).getByLabel(FIXTURE_PRODUCTS.kettle.name, {
    exact: true,
  })
  await expect(select).toHaveValue("")
  await expect(select.locator("option").nth(1)).toBeDisabled()
  await expect(quill(page).getByTestId("quill-no-usable")).toHaveText(
    "The product changed since this research; run Scout again.",
  )
  await expect(
    quill(page).getByRole("button", { name: "Start scriptwriting" }),
  ).toBeDisabled()
  const refused = await request.post(`/api/tickets/${ticket.id}/runs`, {
    data: {
      requestId: rid(),
      ticketVersion: ready.version,
      mode: "production",
      workflow: "quill-script-v1",
      scripts: [{ productId, reportId: old }],
    },
  })
  expect(refused.status()).toBe(409)
  expect((await refused.json()).message).toMatch(
    /changed since Scout researched it.*Run Scout again/,
  )
})

test("works with the keyboard only", async ({ page, request }) => {
  const ticket = await makeTicket(request, "Quill keyboard", [
    FIXTURE_PRODUCTS.kettle,
    FIXTURE_PRODUCTS.buds,
  ])
  await research(request, ticket)
  await page.goto(`/tickets/${ticket.id}`)
  const buds = quill(page).getByLabel(FIXTURE_PRODUCTS.buds.name, {
    exact: true,
  })
  await buds.focus()
  await page.keyboard.press("Home") // "Don't write a script for this product"
  await expect(buds).toHaveValue("")
  const start = quill(page).getByRole("button", { name: "Start scriptwriting" })
  await start.focus()
  await page.keyboard.press("Enter")
  await expect(runStatus(page)).toHaveText("Completed", { timeout: 90_000 })
  await expect(
    quill(page)
      .getByRole("list", { name: "Scripts by product" })
      .locator("li[data-quill-task-status]"),
  ).toHaveCount(1)
  const summary = taskCard(page, FIXTURE_PRODUCTS.kettle.name).getByText(
    "Script",
    { exact: true },
  )
  await summary.focus()
  await page.keyboard.press("Enter")
  await expect(
    taskCard(page, FIXTURE_PRODUCTS.kettle.name).getByTestId("quill-script"),
  ).toBeVisible()
})

for (const width of [360, 375])
  test(`fits a ${width} px screen with a script open`, async ({
    page,
    request,
  }) => {
    const ticket = await makeTicket(request, `Quill ${width}`, [
      FIXTURE_PRODUCTS.kettle,
    ])
    await research(request, ticket)
    await page.setViewportSize({ width, height: 800 })
    await page.goto(`/tickets/${ticket.id}`)
    await quill(page)
      .getByRole("button", { name: "Start scriptwriting" })
      .click()
    await expect(runStatus(page)).toHaveText("Completed", { timeout: 90_000 })
    await taskCard(page, FIXTURE_PRODUCTS.kettle.name)
      .getByText("Script", { exact: true })
      .click()
    await expect(quill(page).getByTestId("quill-script")).toBeVisible()
    await quill(page).scrollIntoViewIfNeeded()
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
  })
