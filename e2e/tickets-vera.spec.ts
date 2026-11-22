import { test, expect, noHorizontalOverflow } from "./fixtures"
import { seeded, waitRun } from "./vera-support"
const rid = () => crypto.randomUUID()
const CONTROL = "http://127.0.0.1:3212"
test.describe.configure({ mode: "serial", timeout: 300000 })
let t: Awaited<ReturnType<typeof seeded>>,
  deliverableId: string,
  reviewId: string

test("Vera explains missing inputs without offering approval or publishing", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/tickets", {
    data: { requestId: rid(), title: "Vera empty" },
  })
  const ticket = (await response.json()).ticket
  await page.goto(`/tickets/${ticket.id}`)
  const section = page.getByRole("region", { name: "Vera Quality Review" })
  await expect(section.getByText(/No completed Pixel videos/)).toBeVisible()
  await expect(
    section.getByRole("button", { name: /Approve|Publish/ }),
  ).toHaveCount(0)
})
test("selects exact video, starts QA with keyboard and reads persisted scene/disclosure evidence", async ({
  page,
  request,
}) => {
  t = await seeded(request, "Vera genuine video", 3)
  const overview = await (
    await request.get(`/api/tickets/${t.id}/videos`)
  ).json()
  const product = overview.products[0]
  const render = await request.post(`/api/tickets/${t.id}/runs`, {
    data: {
      requestId: rid(),
      ticketVersion: t.version,
      mode: "production",
      workflow: "pixel-render-v1",
      renders: [
        {
          productId: t.productId,
          scriptId: product.scripts[0].scriptId,
          assetIds: product.images.map((a: { assetId: string }) => a.assetId),
        },
      ],
    },
  })
  expect(render.status(), await render.text()).toBe(201)
  await waitRun(request, t.id, "pixel-render-v1")
  deliverableId = (
    await (await request.get(`/api/tickets/${t.id}/videos`)).json()
  ).deliverables[0].id
  await page.goto(`/tickets/${t.id}`)
  const section = page.getByRole("region", { name: "Vera Quality Review" })
  await section.getByRole("combobox").selectOption(deliverableId)
  await expect(
    section.getByText(/Technically Verified · video v1/),
  ).toBeVisible()
  const start = section.getByRole("button", { name: "Start Review" })
  await start.focus()
  await page.keyboard.press("Enter")
  await expect(section.getByRole("status")).toContainText(
    /Review in progress|Review queued/,
  )
  await expect(
    section.getByText("Automated QA Passed · video v1 · review v1", {
      exact: false,
    }),
  ).toBeVisible({ timeout: 120000 })
  await section.getByRole("button", { name: "Read review v1" }).click()
  const detail = section.getByRole("article", { name: "QA review detail" })
  await expect(detail.getByText(/Report checksum verified/)).toBeVisible()
  await expect(
    detail.getByText("Awaiting Human Approval", { exact: true }),
  ).toBeVisible()
  await expect(
    detail.getByText(/Machine verified · disclosure.decoded-masks · scene-1/),
  ).toBeVisible()
  await detail.getByText("Technical evidence", { exact: true }).first().click()
  await expect(detail.locator("pre").first()).toBeVisible()
  const script = detail.getByRole("link", {
    name: "Source Quill script and evidence references",
  })
  const source = await request.get((await script.getAttribute("href"))!)
  expect(source.ok()).toBe(true)
  const qa = await (await request.get(`/api/tickets/${t.id}/reviews`)).json()
  reviewId = qa.history[0].id
})
test("keeps reviews historical after an owner edit and supports rereview without rerendering", async ({
  page,
  request,
}) => {
  let ticket = (await (await request.get(`/api/tickets/${t.id}`)).json()).ticket
  ticket = (
    await (
      await request.patch(`/api/tickets/${t.id}`, {
        data: { version: ticket.version, status: "draft" },
      })
    ).json()
  ).ticket
  ticket = (
    await (
      await request.patch(`/api/tickets/${t.id}/products/${t.productId}`, {
        data: { description: "Changed after original video" },
      })
    ).json()
  ).ticket
  ticket = (
    await (
      await request.patch(`/api/tickets/${t.id}`, {
        data: { version: ticket.version, status: "ready" },
      })
    ).json()
  ).ticket
  t.version = ticket.version
  await page.goto(`/tickets/${t.id}`)
  const section = page.getByRole("region", { name: "Vera Quality Review" })
  await section.getByRole("combobox").selectOption(deliverableId)
  await expect(
    section.getByText(/Historical version: this review applies only/),
  ).toBeVisible()
  await section.getByRole("button", { name: "Read review v1" }).click()
  await expect(
    section.getByText(/Historical product inputs · Report checksum verified/),
  ).toBeVisible()
  await section.getByRole("button", { name: "Start Review" }).click()
  await expect(
    section.getByRole("button", { name: "Read review v2" }),
  ).toBeVisible({ timeout: 120000 })
  expect(
    (await (await request.get(`/api/tickets/${t.id}/videos`)).json())
      .deliverables,
  ).toHaveLength(1)
})
test("API rejects ownership escapes, extra JSON fields, malformed UUIDs and unbounded pagination", async ({
  request,
}) => {
  const other = (
    await (
      await request.post("/api/tickets", {
        data: { requestId: rid(), title: "Other Vera ticket" },
      })
    ).json()
  ).ticket
  expect(
    (
      await request.get(`/api/tickets/${other.id}/reviews/${reviewId}`)
    ).status(),
  ).toBe(404)
  expect(
    (await request.get(`/api/tickets/${t.id}/reviews/not-a-uuid`)).status(),
  ).toBe(404)
  expect(
    (await request.get(`/api/tickets/${t.id}/reviews?limit=1000`)).status(),
  ).toBe(400)
  const invalid = await request.post(`/api/tickets/${t.id}/runs`, {
    data: {
      requestId: rid(),
      ticketVersion: t.version,
      mode: "production",
      workflow: "vera-review-v1",
      reviews: [{ productId: t.productId, deliverableId, file: "/etc/passwd" }],
    },
  })
  expect(invalid.status()).toBe(400)
  const ok = await request.get(`/api/tickets/${t.id}/reviews/${reviewId}`)
  expect(ok.headers()["cache-control"]).toContain("no-store")
  expect(await ok.text()).not.toMatch(/\/tmp\/|\/home\//)
})
test("shows offline worker guidance and recovers a queued review", async ({
  page,
  request,
}) => {
  await request.post(`${CONTROL}/worker/stop`)
  try {
    await page.goto(`/tickets/${t.id}`)
    const section = page.getByRole("region", { name: "Vera Quality Review" })
    await expect(section.getByText(/Worker offline or not seen/)).toBeVisible({
      timeout: 30000,
    })
    await section.getByRole("combobox").selectOption(deliverableId)
    await section.getByRole("button", { name: "Start Review" }).click()
    await expect(section.getByRole("status")).toContainText("Review queued")
    await request.post(`${CONTROL}/worker/start`)
    await expect(
      section.getByRole("button", { name: "Read review v3" }),
    ).toBeVisible({ timeout: 120000 })
  } finally {
    await request.post(`${CONTROL}/worker/start`)
  }
})
for (const width of [360, 375])
  test(`Vera fits ${width}px in light and dark themes with keyboard evidence controls`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto(`/tickets/${t.id}`)
    const section = page.getByRole("region", { name: "Vera Quality Review" })
    await section.getByRole("button", { name: "Read review v1" }).click()
    const summary = section
      .getByRole("article", { name: "QA review detail" })
      .getByText("Technical evidence", { exact: true })
      .first()
    await summary.focus()
    await page.keyboard.press("Enter")
    await expect(section.locator("pre").first()).toBeVisible()
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => {
        document.documentElement.classList.remove("light", "dark")
        document.documentElement.classList.add(theme)
      }, theme)
      await noHorizontalOverflow(page)
    }
  })
