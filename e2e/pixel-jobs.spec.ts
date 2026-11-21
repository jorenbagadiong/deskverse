import type { APIRequestContext, Page } from "@playwright/test"

import type {
  JobHistory,
  JobSummary,
  StorageSummary,
} from "../src/lib/video/render-api"
import { expect, test } from "./fixtures"
import {
  fillValidStoryboard,
  openStudio,
  READY_REPORT,
  STUDIO_PATH,
} from "./pixel-studio-helpers"

/** DV-003D1: render history, cancel, retry, delete, storage summary. */

const history = (page: Page) =>
  page.getByRole("list", { name: "Render history" })
const row = (page: Page, name: string) =>
  history(page).getByRole("listitem").filter({ hasText: name })

const summary = (
  overrides: Omit<Partial<JobSummary>, "jobId"> & { jobId: string },
): JobSummary => ({
  state: "completed",
  createdAt: "2026-11-21T09:00:00.000Z",
  updatedAt: "2026-11-21T09:00:10.000Z",
  productName: "Aurora desk lamp",
  audioMode: "none",
  effects: { motion: "gentle-zoom", transition: "crossfade" },
  imageCount: 3,
  durationSeconds: 15,
  sizeBytes: 1_450_000,
  error: null,
  progress: null,
  videoUrl: null,
  downloadUrl: null,
  actions: { cancel: false, retry: false, delete: true, preview: false },
  ...overrides,
  jobId: overrides.jobId as JobSummary["jobId"],
})
const STORAGE: StorageSummary = {
  totalBytes: 24_000_000,
  uploadBytes: 18_000_000,
  outputBytes: 6_000_000,
  workBytes: 0,
  otherBytes: 0,
  jobs: 4,
  completed: 1,
  failed: 1,
  interrupted: 1,
  cancelled: 1,
  drafts: 1,
  active: 0,
  unreadable: 0,
}

/** Serves a mutable mocked history and storage summary. */
async function mockJobs(page: Page, jobs: JobSummary[], storage = STORAGE) {
  const state = { jobs: [...jobs], calls: [] as string[] }
  await page.route(/\/api\/studio\/pixel\/jobs(\?.*)?$/, (route) => {
    if (route.request().method() !== "GET") return route.fallback()
    const body: JobHistory = {
      jobs: state.jobs,
      total: state.jobs.length,
      limit: 30,
    }
    return route.fulfill({ json: body })
  })
  await page.route("**/api/studio/pixel/storage", (route) =>
    route.fulfill({ json: storage }),
  )
  return state
}

test.describe("render history (mocked)", () => {
  test("shows an informative empty state and the storage summary", async ({
    page,
  }) => {
    await mockJobs(page, [], {
      ...STORAGE,
      jobs: 0,
      completed: 0,
      failed: 0,
      interrupted: 0,
      cancelled: 0,
      drafts: 0,
      totalBytes: 0,
      uploadBytes: 0,
      outputBytes: 0,
    })
    await openStudio(page, READY_REPORT)
    await expect(page.getByText("No renders yet")).toBeVisible()
    await expect(page.getByTestId("storage-total")).toContainText("0 B")
  })

  test("offers the right actions per state and confirms before deleting", async ({
    page,
  }) => {
    const state = await mockJobs(page, [
      summary({
        jobId: `job_${"1".repeat(32)}`,
        productName: "Done lamp",
        videoUrl: "/x.mp4",
        downloadUrl: "/x.mp4?download=1",
        actions: { cancel: false, retry: false, delete: true, preview: true },
      }),
      summary({
        jobId: `job_${"2".repeat(32)}`,
        productName: "Broken mug",
        state: "failed",
        durationSeconds: null,
        sizeBytes: null,
        error: {
          code: "interrupted",
          message:
            "The server stopped before this render finished. Select Retry to render it again.",
        },
        actions: { cancel: false, retry: true, delete: true, preview: false },
      }),
      summary({
        jobId: `job_${"3".repeat(32)}`,
        productName: "Busy bottle",
        state: "rendering",
        durationSeconds: null,
        sizeBytes: null,
        progress: {
          phase: "encoding",
          fraction: 0.4,
          encodedSeconds: 6,
          totalSeconds: 15,
        },
        actions: { cancel: true, retry: false, delete: false, preview: false },
      }),
      summary({
        jobId: `job_${"4".repeat(32)}`,
        productName: "Stopped stand",
        state: "cancelled",
        durationSeconds: null,
        sizeBytes: null,
      }),
      summary({
        jobId: `job_${"5".repeat(32)}`,
        productName: null,
        state: "draft",
        audioMode: null,
        durationSeconds: null,
        sizeBytes: null,
      }),
    ])
    let deleted = ""
    await page.route("**/api/studio/pixel/jobs/job_*", (route) => {
      if (route.request().method() !== "DELETE") return route.fallback()
      deleted = route.request().url().split("/").pop()!
      state.jobs = state.jobs.filter((j) => j.jobId !== deleted)
      return route.fulfill({ json: { deleted: true } })
    })
    await openStudio(page, READY_REPORT)
    await page.route("**/x.mp4*", (route) =>
      route.fulfill({ status: 200, contentType: "video/mp4", body: "" }),
    )

    await expect(
      row(page, "Done lamp").getByRole("button", { name: "Preview Done lamp" }),
    ).toBeVisible()
    await expect(
      row(page, "Done lamp").getByRole("link", { name: "Download Done lamp" }),
    ).toBeVisible()
    await expect(row(page, "Broken mug").getByText("Interrupted")).toBeVisible()
    await expect(
      row(page, "Broken mug").getByRole("button", { name: "Retry Broken mug" }),
    ).toBeVisible()
    await expect(
      row(page, "Busy bottle").getByText("Encoding 40%"),
    ).toBeVisible()
    await expect(
      row(page, "Busy bottle").getByRole("progressbar"),
    ).toHaveAttribute("aria-valuenow", "40")
    await expect(
      row(page, "Busy bottle").getByRole("button", {
        name: "Cancel Busy bottle",
      }),
    ).toBeVisible()
    await expect(
      row(page, "Busy bottle").getByRole("button", { name: /Delete/ }),
    ).toHaveCount(0)
    await expect(
      row(page, "Stopped stand").getByRole("button", {
        name: "Delete Stopped stand",
      }),
    ).toBeVisible()
    await expect(
      row(page, "Untitled draft").getByRole("button", {
        name: "Delete Untitled draft",
      }),
    ).toBeVisible()
    await expect(page.getByTestId("storage-counts")).toHaveText(
      "4 jobs · 1 video · 1 failed (1 interrupted) · 1 cancelled · 1 draft",
    )

    // Delete asks first; "Keep it" changes nothing.
    await row(page, "Stopped stand")
      .getByRole("button", { name: "Delete Stopped stand" })
      .click()
    const dialog = page.getByRole("alertdialog")
    await expect(dialog).toContainText("Delete “Stopped stand”?")
    await dialog.getByRole("button", { name: "Keep it" }).click()
    await expect(dialog).toHaveCount(0)
    expect(deleted).toBe("")

    // Keyboard: open the dialog with Enter and confirm.
    await row(page, "Stopped stand")
      .getByRole("button", { name: "Delete Stopped stand" })
      .focus()
    await page.keyboard.press("Enter")
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete permanently" })
      .click()
    await expect(row(page, "Stopped stand")).toHaveCount(0)
    expect(deleted).toBe(`job_${"4".repeat(32)}`)
  })

  test("retries a failed job and shows the server's failure messages", async ({
    page,
  }) => {
    const failed = summary({
      jobId: `job_${"6".repeat(32)}`,
      productName: "Retry me",
      state: "failed",
      durationSeconds: null,
      sizeBytes: null,
      error: {
        code: "render-failed",
        message: "The libx264 encoder failed while encoding the video.",
      },
      actions: { cancel: false, retry: true, delete: true, preview: false },
    })
    const state = await mockJobs(page, [failed])
    let retries = 0
    await page.route(
      `**/api/studio/pixel/jobs/${failed.jobId}/retry`,
      (route) => {
        retries++
        // The retry is accepted; the job then fails again with a new reason.
        state.jobs = [
          {
            ...failed,
            error: {
              code: "render-failed",
              message:
                "FFmpeg couldn't prepare scene 2. Check that the image opens on your computer, or try a different one.",
            },
          },
        ]
        return route.fulfill({ status: 202, json: {} })
      },
    )
    await openStudio(page, READY_REPORT)
    await expect(row(page, "Retry me")).toContainText(
      "The libx264 encoder failed",
    )
    await row(page, "Retry me")
      .getByRole("button", { name: "Retry Retry me" })
      .click()
    await expect(row(page, "Retry me")).toContainText(
      "FFmpeg couldn't prepare scene 2",
    )
    await expect(
      row(page, "Retry me").getByRole("button", { name: "Retry Retry me" }),
    ).toBeEnabled()
    expect(retries).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Real FFmpeg
// ---------------------------------------------------------------------------

async function ffmpegReady(request: APIRequestContext) {
  const response = await request.get("/api/studio/pixel/capabilities")
  return response.ok() && (await response.json()).status === "ready"
}

async function startRender(page: Page, name: string, benefits = 1) {
  await page.goto(STUDIO_PATH)
  await expect(page.getByText("Ready", { exact: true })).toBeVisible()
  await fillValidStoryboard(page)
  await page.getByLabel("Product name").fill(name)
  for (let i = 1; i < benefits; i++) {
    await page.getByRole("button", { name: "Add benefit" }).click()
    await page
      .getByLabel(`Benefit ${i + 1}`, { exact: true })
      .fill(`Benefit number ${i + 1}`)
  }
  await page.getByRole("button", { name: "Render MP4" }).click()
}

const unique = (label: string) => `${label} ${Date.now().toString(36)}`

test.describe("real job management", () => {
  test.describe.configure({ timeout: 240_000 })

  test("cancels a real render from the render panel; nothing is downloadable", async ({
    page,
    request,
  }) => {
    test.skip(
      !(await ffmpegReady(request)),
      "FFmpeg isn't installed on this machine",
    )
    const name = unique("Cancel lamp")
    await startRender(page, name, 5)
    await page.getByRole("button", { name: "Cancel render" }).click()
    await expect(
      page.getByText(/Render cancelled\. Nothing was saved as a video/),
    ).toBeVisible({ timeout: 30_000 })
    await expect(row(page, name).getByText("Cancelled")).toBeVisible()
    const jobs: JobHistory = await (
      await request.get("/api/studio/pixel/jobs")
    ).json()
    const job = jobs.jobs.find((j) => j.productName === name)!
    expect(job).toMatchObject({ state: "cancelled", videoUrl: null })
    expect(
      (await request.get(`/api/studio/pixel/jobs/${job.jobId}/video`)).status(),
    ).toBe(404)
    // Clean up: delete it, then it's gone everywhere.
    expect(
      (await request.delete(`/api/studio/pixel/jobs/${job.jobId}`)).status(),
    ).toBe(200)
    expect(
      (await request.get(`/api/studio/pixel/jobs/${job.jobId}`)).status(),
    ).toBe(404)
  })

  test("keeps completed videos in the history across a refresh, with preview and download", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      !(await ffmpegReady(request)),
      "FFmpeg isn't installed on this machine",
    )
    const name = unique("History mug")
    await startRender(page, name)
    await expect(
      page.getByText("Video ready and verified by FFprobe."),
    ).toBeVisible({ timeout: 180_000 })
    await page.reload()
    const item = row(page, name)
    await expect(item.getByText("Completed")).toBeVisible()
    await expect(item).toContainText(/15\.0 s/)
    await item.getByRole("button", { name: `Preview ${name}` }).click()
    await expect(
      page.getByLabel(`Preview of ${name}`, { exact: true }),
    ).toHaveAttribute("src", /\/video$/)
    const downloadPromise = page.waitForEvent("download")
    await item.getByRole("link", { name: `Download ${name}` }).click()
    const file = testInfo.outputPath("from-history.mp4")
    await (await downloadPromise).saveAs(file)
    const { statSync } = await import("node:fs")
    expect(statSync(file).size).toBeGreaterThan(10_000)
    await expect(page.getByTestId("storage-total")).not.toContainText(/^0 B/)

    // Delete with confirmation; it disappears and its video is gone.
    const jobs: JobHistory = await (
      await request.get("/api/studio/pixel/jobs")
    ).json()
    const job = jobs.jobs.find((j) => j.productName === name)!
    await item.getByRole("button", { name: `Delete ${name}` }).click()
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete permanently" })
      .click()
    await expect(row(page, name)).toHaveCount(0)
    expect(
      (await request.get(`/api/studio/pixel/jobs/${job.jobId}/video`)).status(),
    ).toBe(404)
  })

  test("finds a still-running render after a refresh and cancels it from the history", async ({
    page,
    request,
  }) => {
    test.skip(
      !(await ffmpegReady(request)),
      "FFmpeg isn't installed on this machine",
    )
    const name = unique("Refresh bottle")
    await startRender(page, name, 5)
    await expect(
      page.getByRole("button", { name: "Cancel render" }),
    ).toBeVisible()
    await page.reload()
    const item = row(page, name)
    await expect(item.getByText(/Rendering|Queued/)).toBeVisible()
    await expect(item.getByRole("progressbar")).toBeVisible()
    await item.getByRole("button", { name: `Cancel ${name}` }).click()
    await expect(item.getByText("Cancelled")).toBeVisible({ timeout: 30_000 })
    const jobs: JobHistory = await (
      await request.get("/api/studio/pixel/jobs")
    ).json()
    const job = jobs.jobs.find((j) => j.productName === name)!
    await request.delete(`/api/studio/pixel/jobs/${job.jobId}`)
  })

  test("refuses invalid management requests", async ({ request }) => {
    const id = `job_${"0".repeat(32)}`
    expect(
      (await request.post(`/api/studio/pixel/jobs/${id}/cancel`)).status(),
    ).toBe(404)
    expect(
      (await request.post(`/api/studio/pixel/jobs/${id}/retry`)).status(),
    ).toBeGreaterThanOrEqual(404)
    expect(
      (await request.delete(`/api/studio/pixel/jobs/${id}`)).status(),
    ).toBe(404)
    expect(
      (await request.delete(`/api/studio/pixel/jobs/..%2F..%2Fetc`)).status(),
    ).toBe(404)
    expect(
      (await request.get("/api/studio/pixel/jobs?limit=1000")).status(),
    ).toBe(400)
    expect(
      (
        await request.post(`/api/studio/pixel/storage/cleanup`, {
          data: { path: "/" },
        })
      ).status(),
    ).toBe(400)
    expect(
      (
        await request.get("/api/studio/pixel/storage", {
          headers: { host: "evil.example" },
        })
      ).status(),
    ).toBe(403)
    const draft = (await (await request.post("/api/studio/pixel/jobs")).json())
      .jobId
    expect(
      (await request.post(`/api/studio/pixel/jobs/${draft}/cancel`)).status(),
    ).toBe(409)
    expect(
      (await request.post(`/api/studio/pixel/jobs/${draft}/retry`)).status(),
    ).toBe(409)
    expect(
      (await request.delete(`/api/studio/pixel/jobs/${draft}`)).status(),
    ).toBe(200)
  })
})
