import { execFileSync } from "node:child_process"

import type { APIRequestContext, Page } from "@playwright/test"

import type { JobHistory, RenderRequest } from "../src/lib/video/render-api"
import { expect, noHorizontalOverflow, test } from "./fixtures"
import {
  fillValidStoryboard,
  makeJpeg,
  NO_EFFECTS_REPORT,
  openStudio,
  READY_REPORT,
  STUDIO_PATH,
} from "./pixel-studio-helpers"

/** DV-003D2: visual effects (gentle zoom, crossfades) in Pixel Studio. */

const motion = (page: Page, name: string) =>
  page
    .getByRole("group", { name: "Product motion" })
    .getByRole("radio", { name: new RegExp(`^${name}`) })
const transition = (page: Page, name: string) =>
  page
    .getByRole("group", { name: "Scene transitions" })
    .getByRole("radio", { name: new RegExp(`^${name}`) })

async function ffmpegReady(request: APIRequestContext) {
  const response = await request.get("/api/studio/pixel/capabilities")
  if (!response.ok()) return false
  const report = await response.json()
  return (
    report.status === "ready" &&
    ["perspective", "pad", "xfade"].every((name) =>
      report.filters.some(
        (f: { name: string; available: boolean }) =>
          f.name === name && f.available,
      ),
    )
  )
}

test.describe("Visual effects", () => {
  test("new projects start with gentle zoom and crossfades; the storyboard says so", async ({
    page,
  }) => {
    await openStudio(page, READY_REPORT)
    await expect(motion(page, "Gentle zoom")).toBeChecked()
    await expect(transition(page, "Crossfade")).toBeChecked()
    const label = page.getByTestId("storyboard-effects")
    await expect(label).toContainText("Gentle zoom · Crossfade")
    await expect(label).toContainText("Shown still here")
    // The preview stays a labeled static plan.
    await expect(
      page.getByText("A static plan of the video, not a render."),
    ).toBeVisible()
    // Explanations sit with each choice.
    await expect(page.getByText(/slowly grows by about 5\s%/)).toBeVisible()
    await expect(
      page.getByText(/dissolves into the next over 0\.3\ss/),
    ).toBeVisible()
  })

  test("can be switched to a fully static video by keyboard", async ({
    page,
  }) => {
    await openStudio(page, READY_REPORT)
    await motion(page, "Gentle zoom").focus()
    await page.keyboard.press("ArrowLeft")
    await expect(motion(page, "None")).toBeChecked()
    await motion(page, "None").press("Tab")
    await expect(transition(page, "Crossfade")).toBeFocused()
    await page.keyboard.press("ArrowLeft")
    await expect(transition(page, "Cuts")).toBeChecked()
    await expect(page.getByTestId("storyboard-effects")).toContainText(
      "Still photos · Cuts (a fully static video)",
    )
  })

  test("disables effects this FFmpeg can't render and blocks rendering until changed", async ({
    page,
  }) => {
    await openStudio(page, NO_EFFECTS_REPORT)
    await expect(motion(page, "Gentle zoom")).toBeDisabled()
    await expect(transition(page, "Crossfade")).toBeDisabled()
    await expect(
      page.getByText(
        "This FFmpeg build lacks the filters for gentle zoom and crossfades. Still photos and cuts always work.",
      ),
    ).toBeVisible()
    await fillValidStoryboard(page)
    await page.getByRole("button", { name: "Check storyboard" }).click()
    await expect(
      page.getByRole("link", {
        name: "Gentle zoom needs FFmpeg filters this computer lacks. Choose Product motion: None.",
      }),
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Render MP4" }),
    ).toBeDisabled()
    await motion(page, "None").check()
    await transition(page, "Cuts").check()
    await expect(
      page.getByRole("status").filter({ hasText: "Storyboard complete" }),
    ).toBeVisible()
    await expect(page.getByRole("button", { name: "Render MP4" })).toBeEnabled()
  })

  test("respects reduced motion in the page itself", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    await openStudio(page, READY_REPORT)
    const card = page
      .getByRole("group", { name: "Product motion" })
      .locator("label")
      .first()
    // The site's reduced-motion rule shortens transitions to (near) zero.
    const duration = await card.evaluate(
      (el) => getComputedStyle(el).transitionDuration,
    )
    expect(parseFloat(duration)).toBeLessThan(0.001)
  })

  test("fits phone widths without overflow", async ({ page }) => {
    for (const width of [360, 375]) {
      await page.setViewportSize({ width, height: 800 })
      await openStudio(page, READY_REPORT)
      await page
        .getByRole("group", { name: "Scene transitions" })
        .scrollIntoViewIfNeeded()
      expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
      const box = await page
        .getByRole("group", { name: "Scene transitions" })
        .boundingBox()
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    }
  })
})

/** Inserts an EXIF APP1 segment (orientation only) after a JPEG's SOI. */
function withOrientation(jpeg: Buffer, orientation: number) {
  const tiff = Buffer.alloc(26)
  tiff.write("MM", 0, "latin1")
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4)
  tiff.writeUInt16BE(1, 8)
  tiff.writeUInt16BE(0x0112, 10)
  tiff.writeUInt16BE(3, 12)
  tiff.writeUInt32BE(1, 14)
  tiff.writeUInt16BE(orientation, 18)
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff])
  const header = Buffer.from([0xff, 0xe1, 0, 0])
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)])
}

test.describe("EXIF orientation", () => {
  test("the studio preview and the server agree on a sideways phone photo's upright size", async ({
    page,
    request,
  }) => {
    await openStudio(page, READY_REPORT)
    // Stored 1600 × 1200 (landscape) with "rotate 90° clockwise": upright 1200 × 1600.
    const sideways = withOrientation(await makeJpeg(page, 1600, 1200, 30), 6)
    await page.getByLabel("Product images").setInputFiles({
      name: "phone.jpg",
      mimeType: "image/jpeg",
      buffer: sideways,
    })
    const preview = page.getByRole("img", { name: /Product image 1/ })
    await expect(preview).toBeVisible()
    await expect(page.getByText(/1200×1600/)).toBeVisible()
    expect(
      await preview.evaluate((img: HTMLImageElement) => [
        img.naturalWidth,
        img.naturalHeight,
      ]),
    ).toEqual([1200, 1600])

    const job = await request.post("/api/studio/pixel/jobs")
    const { jobId } = await job.json()
    const upload = await request.post(
      `/api/studio/pixel/jobs/${jobId}/assets`,
      {
        headers: { "content-type": "image/jpeg", "x-file-name": "phone.jpg" },
        data: sideways,
      },
    )
    test.skip(
      upload.status() === 503,
      "FFmpeg isn't installed on this machine (uploads are verified with FFprobe)",
    )
    expect(upload.status()).toBe(201)
    expect((await upload.json()).asset).toMatchObject({
      width: 1200,
      height: 1600,
    })
    await request.delete(`/api/studio/pixel/jobs/${jobId}`)
  })
})

test.describe("Visual effects: real rendering", () => {
  test.describe.configure({ timeout: 300_000 })

  test("renders gentle zoom + crossfades, previews, downloads, and lists them in history after a reload", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      !(await ffmpegReady(request)),
      "FFmpeg with perspective and xfade isn't installed on this machine",
    )
    const name = `Effects mug ${Date.now().toString(36)}`
    await page.goto(STUDIO_PATH)
    await expect(page.getByText("Ready", { exact: true })).toBeVisible()
    await fillValidStoryboard(page)
    await page.getByLabel("Product name").fill(name)
    await expect(motion(page, "Gentle zoom")).toBeChecked()
    await expect(transition(page, "Crossfade")).toBeChecked()

    const sent = page.waitForRequest(
      (r) => r.method() === "POST" && /\/render$/.test(r.url()),
    )
    await page.getByRole("button", { name: "Render MP4" }).click()
    const body = (await sent).postDataJSON() as RenderRequest
    // Only names: no durations, zoom amounts or filters leave the browser.
    expect(body.effects).toEqual({
      motion: "gentle-zoom",
      transition: "crossfade",
    })

    await expect(
      page.getByText("Video ready and verified by FFprobe."),
    ).toBeVisible({ timeout: 240_000 })
    const video = page.getByLabel("Rendered video preview")
    await expect(video).toHaveAttribute("src", /\/video$/)

    const downloadPromise = page.waitForEvent("download")
    await page.getByRole("link", { name: "Download MP4" }).click()
    const file = testInfo.outputPath("effects.mp4")
    await (await downloadPromise).saveAs(file)
    const probe = JSON.parse(
      execFileSync("ffprobe", [
        "-v",
        "error",
        "-count_frames",
        "-show_entries",
        "format=duration:stream=codec_name,width,height,nb_read_frames",
        "-of",
        "json",
        file,
      ]).toString(),
    )
    // Hook 3 s + one benefit 4 s + CTA 4 s... whatever the storyboard says,
    // frames and duration agree exactly at 30 fps.
    const frames = Number(probe.streams[0].nb_read_frames)
    expect(probe.streams[0]).toMatchObject({
      codec_name: "h264",
      width: 1080,
      height: 1920,
    })
    expect(Number(probe.format.duration)).toBeCloseTo(frames / 30, 3)
    // The product moves within the first scene (gentle zoom), unlike a still.
    const changes = execFileSync(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        file,
        "-vf",
        "select=between(n\\,20\\,40),crop=1008:840:36:365,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
        "-f",
        "null",
        "-",
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    )
      .toString()
      .split("\n")
      .filter((l) => l.includes("YAVG="))
      .map((l) => Number(l.split("=")[1]))
    expect(changes.length).toBeGreaterThan(10)
    expect(changes.every((c) => c > 0.01)).toBe(true)

    await page.reload()
    const item = page
      .getByRole("list", { name: "Render history" })
      .getByRole("listitem")
      .filter({ hasText: name })
    await expect(item.getByText("Completed")).toBeVisible()
    await expect(item).toContainText("Gentle zoom · Crossfade")
    const history: JobHistory = await (
      await request.get("/api/studio/pixel/jobs")
    ).json()
    expect(history.jobs.find((j) => j.productName === name)?.effects).toEqual({
      motion: "gentle-zoom",
      transition: "crossfade",
    })
  })
})
