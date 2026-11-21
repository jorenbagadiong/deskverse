import { expect, noHorizontalOverflow, test } from "./fixtures"
import {
  fillValidStoryboard,
  makeWavNode,
  MISSING_REPORT,
  openStudio,
  READY_REPORT,
} from "./pixel-studio-helpers"

/** DV-003A Pixel Studio at phone widths (375px and 360px projects). */
test.describe("Pixel Studio (mobile)", () => {
  test("fits the screen in one column with the header intact", async ({
    page,
  }) => {
    await openStudio(page, MISSING_REPORT)
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)

    const width = page.viewportSize()!.width
    const theme = await page.getByLabel("Color theme").boundingBox()
    expect(theme!.x + theme!.width).toBeLessThanOrEqual(width)
    await expect(
      page
        .getByRole("navigation", { name: "Main" })
        .getByRole("link", { name: "Studio" }),
    ).toBeVisible()

    // Form first, storyboard below it, both full width.
    const form = await page
      .getByRole("form", { name: "Video details" })
      .boundingBox()
    const board = await page
      .getByRole("list", { name: "Storyboard scenes" })
      .boundingBox()
    expect(board!.y).toBeGreaterThan(form!.y + form!.height)
    expect(form!.width).toBeGreaterThan(width - 80)

    await expect(page.getByText("Not installed")).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Render MP4" }),
    ).toBeDisabled()
  })

  test("completes a storyboard by touch without overflow", async ({ page }) => {
    await openStudio(page)
    await fillValidStoryboard(page)
    await page.getByRole("button", { name: "Check storyboard" }).tap()
    await expect(
      page.getByRole("status").filter({ hasText: "Storyboard complete" }),
    ).toBeVisible()
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
    const frame = await page.getByTestId("scene-frame").first().boundingBox()
    expect(frame!.width / frame!.height).toBeCloseTo(9 / 16, 2)
  })

  test("audio section fits with a chosen voiceover and its preview", async ({
    page,
  }) => {
    await openStudio(page, READY_REPORT)
    await page.getByRole("radio", { name: /^Voiceover \+ music/ }).tap()
    await page.getByLabel("Voiceover file", { exact: true }).setInputFiles({
      name: "voice.wav",
      mimeType: "audio/wav",
      buffer: makeWavNode(4),
    })
    await expect(page.getByLabel("Preview voiceover file")).toBeVisible()
    await expect(
      page.getByRole("radio", { name: "Low (recommended)" }),
    ).toBeVisible()
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
    const player = await page.getByLabel("Preview voiceover file").boundingBox()
    expect(player!.x + player!.width).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    )
  })

  test("render history and storage fit on a phone", async ({ page }) => {
    await page.route(/\/api\/studio\/pixel\/jobs(\?.*)?$/, (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            json: {
              total: 1,
              limit: 30,
              jobs: [
                {
                  jobId: `job_${"7".repeat(32)}`,
                  state: "failed",
                  createdAt: "2026-11-21T09:00:00.000Z",
                  updatedAt: "2026-11-21T09:00:10.000Z",
                  productName:
                    "A rather long product name for a small phone screen",
                  audioMode: "voiceover-and-music",
                  effects: { motion: "gentle-zoom", transition: "crossfade" },
                  narration: {
                    startSeconds: 2,
                    endSeconds: 14,
                    trimStartSeconds: 3,
                    trimEndSeconds: 15,
                    videoSeconds: 23,
                  },
                  imageCount: 6,
                  durationSeconds: null,
                  sizeBytes: null,
                  error: {
                    code: "interrupted",
                    message:
                      "The server stopped before this render finished. Select Retry to render it again.",
                  },
                  progress: null,
                  videoUrl: null,
                  downloadUrl: null,
                  actions: {
                    cancel: false,
                    retry: true,
                    delete: true,
                    preview: false,
                  },
                },
              ],
            },
          })
        : route.fallback(),
    )
    await openStudio(page, READY_REPORT)
    const list = page.getByRole("list", { name: "Render history" })
    await expect(list.getByText("Interrupted")).toBeVisible()
    await list.getByRole("button", { name: /^Retry/ }).scrollIntoViewIfNeeded()
    await expect(list.getByRole("button", { name: /^Retry/ })).toBeVisible()
    await expect(page.getByTestId("storage-total")).toBeVisible()
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
  })
})
