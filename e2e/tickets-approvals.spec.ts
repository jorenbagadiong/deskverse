import type { APIRequestContext, Page } from "@playwright/test"
import { test, expect, noHorizontalOverflow } from "./fixtures"
import { seeded, waitRun } from "./vera-support"

test.describe.configure({ mode: "serial", timeout: 300000 })
const rid = () => crypto.randomUUID()
const candidates: { id: string; ticketId: string; title: string }[] = []

async function prepare(page: Page, request: APIRequestContext, title: string) {
  const ticket = await seeded(request, title, 3)
  const runs = `/api/tickets/${ticket.id}/runs`
  const common = { ticketVersion: ticket.version, mode: "production" }
  await page.goto(`/tickets/${ticket.id}`)
  const pixel = page.getByRole("region", { name: "Pixel Videos" })
  const rights = pixel.getByRole("checkbox", {
    name: /I confirm I may use these images in a published video/,
  })
  await expect(rights).not.toBeChecked()
  await rights.check()
  await pixel.getByRole("button", { name: "Start render", exact: true }).click()
  await waitRun(request, ticket.id, "pixel-render-v1")
  const { id } = (
    await (await request.get(`/api/tickets/${ticket.id}/videos`)).json()
  ).deliverables[0]
  const review = await request.post(runs, {
    data: {
      ...common,
      requestId: rid(),
      workflow: "vera-review-v1",
      reviews: [{ productId: ticket.productId, deliverableId: id }],
    },
  })
  expect(review.status(), await review.text()).toBe(201)
  await waitRun(request, ticket.id, "vera-review-v1")
  return { id, ticketId: ticket.id, title }
}

test("opens an approval review by keyboard, downloads the MP4 and records an explicit approval and withdrawal", async ({
  page,
  request,
}, testInfo) => {
  const candidate = await prepare(page, request, "Approval browser fixture")
  candidates.push(candidate)
  await page.goto("/tickets")
  await page.getByRole("link", { name: "Approvals", exact: true }).click()
  const candidatesRegion = page.getByRole("region", { name: "Candidates" })
  await candidatesRegion.getByLabel("Ticket or product").fill(candidate.title)
  await candidatesRegion.getByRole("button", { name: "Apply filters" }).click()
  const video = candidatesRegion.getByRole("button", { name: /Pixel v1/ })
  await expect(video).toHaveCount(1)
  await video.focus()
  await page.keyboard.press("Enter")
  const detail = page.getByRole("article", { name: "Selected video review" })
  await expect(detail.getByText("v1 · Automated QA Passed")).toBeVisible()
  await detail.getByText("Quill script v1").click()
  await expect(detail.getByText(/^Narration —/).first()).toBeVisible()
  await detail.getByText(/^Findings \(/).click()
  await expect(detail.getByText(/disclosure ·/).first()).toBeVisible()
  const download = detail.getByRole("link", { name: "Download MP4" })
  const response = await request.get((await download.getAttribute("href"))!)
  expect(response.headers()["content-disposition"]).toContain("attachment")
  expect(response.headers()["content-type"]).toBe("video/mp4")
  expect((await response.body()).length).toBeGreaterThan(1000)
  if (testInfo.project.use.channel === "chrome") {
    const preview = detail.locator("video")
    await preview.evaluate(async (video: HTMLVideoElement) => {
      video.muted = true
      await video.play()
    })
    await expect
      .poll(() =>
        preview.evaluate(
          (video: HTMLVideoElement) =>
            video.currentTime > 0 &&
            video.getVideoPlaybackQuality().totalVideoFrames > 0,
        ),
      )
      .toBe(true)
    await preview.evaluate((video: HTMLVideoElement) => video.pause())
  }
  const decision = detail.getByRole("combobox", {
    name: "Decision",
    exact: true,
  })
  await expect(
    decision.getByRole("option", { name: "Approve", exact: true }),
  ).toHaveCount(1)
  await decision.selectOption("approved")
  const checks = detail
    .getByRole("group", { name: "Human checklist" })
    .getByRole("checkbox")
  expect(await checks.count()).toBeGreaterThan(0)
  for (const check of await checks.all()) {
    await expect(check).not.toBeChecked()
    await check.focus()
    await page.keyboard.press("Space")
  }
  await detail.getByRole("button", { name: "Review decision" }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirm decision" })
    .click()
  await expect(
    detail.getByText("Human Approved — Not Scheduled", { exact: true }).first(),
  ).toBeVisible()
  await decision.selectOption("withdrawn")
  await detail
    .getByLabel("Reason", { exact: true })
    .fill("Reconsider the intended platform.")
  await detail.getByRole("button", { name: "Review decision" }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirm decision" })
    .click()
  await expect(
    detail.getByText("Withdrawn", { exact: true }).first(),
  ).toBeVisible()
  await detail.getByText("Decision history", { exact: true }).click()
  await expect(
    detail.getByText("Reconsider the intended platform."),
  ).toBeVisible()
})

test("supports reviews on 360px and 375px in light and dark mode", async ({
  page,
}) => {
  for (const width of [360, 375]) {
    await page.setViewportSize({ width, height: 800 })
    await page.goto("/approvals")
    await page.getByLabel("Ticket or product").fill(candidates[0].title)
    await page.getByRole("button", { name: "Apply filters" }).click()
    await page.getByRole("button", { name: /Pixel v1.*Withdrawn/ }).click()
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => {
        document.documentElement.classList.remove("light", "dark")
        document.documentElement.classList.add(theme)
      }, theme)
      await noHorizontalOverflow(page)
      await expect(
        page.getByRole("link", { name: "Download MP4" }),
      ).toBeVisible()
    }
  }
})
