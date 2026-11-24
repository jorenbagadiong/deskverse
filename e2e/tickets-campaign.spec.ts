import { test, expect, noHorizontalOverflow } from "./fixtures"
import { seeded, waitRun } from "./vera-support"
import type { RunDetail } from "../src/lib/orchestrator/types"

test("starts one real campaign with keyboard-selected images and leaves QA for human approval", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000)
  const title = "Automatic campaign browser fixture"
  const ticket = await seeded(request, title, 3, "owned", false)
  const base = `/api/tickets/${ticket.id}`
  const availability = async () =>
    (await (await request.get(`${base}/runs`)).json()).availability
  await expect
    .poll(async () => (await availability()).campaignTesting)
    .toBe(true)

  const omittedWorkflow = await request.post(`${base}/runs`, {
    data: {
      requestId: crypto.randomUUID(),
      ticketVersion: ticket.version,
      mode: "production",
    },
  })
  expect(omittedWorkflow.status()).toBe(503)
  const missingSelection = await request.post(`${base}/runs`, {
    data: {
      requestId: crypto.randomUUID(),
      ticketVersion: ticket.version,
      mode: "production",
      workflow: "campaign-v1",
    },
  })
  expect(missingSelection.status()).toBe(400)

  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto(`/tickets/${ticket.id}`)
  const group = page.getByRole("group", {
    name: "Automatic campaign",
    exact: true,
  })
  const start = group.getByRole("button", { name: "Start Automatic Campaign" })
  await expect(start).toBeDisabled()
  const product = group.getByRole("checkbox", {
    name: "Acme SteelBoil Kettle K200",
    exact: true,
  })
  await product.focus()
  await expect(product).toBeFocused()
  await page.keyboard.press("Space")
  const images = group.getByRole("group", { name: /Images for Acme/ })
  await expect(images.getByRole("checkbox", { checked: true })).toHaveCount(0)
  for (const n of [2, 0, 1]) {
    await images
      .getByRole("checkbox", { name: new RegExp(`photo-${n}\\.png`) })
      .focus()
    await page.keyboard.press("Space")
  }
  const confirmed = group.getByRole("checkbox", {
    name: /I confirm that I may use the selected images/,
  })
  await expect(confirmed).not.toBeChecked()
  await confirmed.check()
  await images.getByRole("button", { name: /Move photo-0.png earlier/ }).click()
  await expect(confirmed).not.toBeChecked()
  await expect(start).toBeDisabled()
  await confirmed.focus()
  await page.keyboard.press("Space")
  expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)

  await page.setViewportSize({ width: 375, height: 740 })
  await page.emulateMedia({ colorScheme: "dark" })
  expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
  await expect(start).toBeEnabled()
  const submission = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith(`${base}/runs`),
  )
  await start.focus()
  await expect(start).toBeFocused()
  await page.keyboard.press("Enter")
  const body = (await submission).postDataJSON()
  expect(body.campaign).toEqual([
    {
      productId: ticket.productId,
      assetIds: [ticket.assetIds[0], ticket.assetIds[2], ticket.assetIds[1]],
      rightsAcknowledged: true,
    },
  ])
  await waitRun(request, ticket.id, "campaign-v1")
  const listed = await (await request.get(`${base}/runs`)).json()
  expect(listed.runs).toHaveLength(1)
  const run = listed.runs[0]
  const detail: RunDetail = await (
    await request.get(`${base}/runs/${run.id}`)
  ).json()
  expect(
    detail.products[0].tasks.map((task) => [task.stage, task.status]),
  ).toEqual([
    ["scout.research", "completed"],
    ["quill.script", "completed"],
    ["pixel.render", "completed"],
    ["vera.review", "completed"],
  ])
  const workflow = page.getByRole("region", { name: "Workflow" })
  await expect(
    workflow.getByRole("link", { name: "Vera QA passed" }),
  ).toBeVisible()
  const deliverable = detail.products[0].tasks[2].result!.artifactId
  const approval = await (
    await request.get(`/api/approvals/${deliverable}`)
  ).json()
  expect(approval.decision).toBeNull()
  expect(approval.eligibility).toMatchObject({
    canApprove: true,
    eligible: false,
  })
  await workflow.getByRole("link", { name: "Review in Approval Inbox" }).click()
  const candidates = page.getByRole("region", { name: "Candidates" })
  await candidates.getByLabel("Ticket or product").fill(title)
  await candidates.getByRole("button", { name: "Apply filters" }).click()
  await candidates.getByRole("button", { name: /Pixel v1/ }).click()
  await expect(
    page
      .getByRole("article", { name: "Selected video review" })
      .getByText("v1 · Automated QA Passed"),
  ).toBeVisible()
})
