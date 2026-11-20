import type { Page } from "@playwright/test"

import type { FfmpegCapabilityReport } from "../src/lib/video/capabilities"

/**
 * Pixel Studio test helpers. The FFmpeg endpoint is mocked so UI tests behave
 * the same whether or not the machine running them has FFmpeg installed.
 */

export const STUDIO_PATH = "/studio/pixel"
const ENDPOINT = "**/api/studio/pixel/capabilities**"

const filters = [
  "scale",
  "crop",
  "pad",
  "setsar",
  "fps",
  "format",
  "overlay",
  "drawtext",
  "zoompan",
  "fade",
  "concat",
].map((name) => ({ name, available: true, required: true }))

export const READY_REPORT: FfmpegCapabilityReport = {
  status: "ready",
  checkedAt: "2026-11-21T00:00:00.000Z",
  ffmpeg: { available: true, version: "6.1.1-3ubuntu5", problem: null },
  ffprobe: { available: true, version: "6.1.1-3ubuntu5", problem: null },
  filters: [...filters, { name: "xfade", available: true, required: false }],
  h264Encoders: [
    { name: "libx264", hardware: false },
    { name: "h264_nvenc", hardware: true },
  ],
  selectedH264Encoder: "libx264",
  aacEncoder: "aac",
  license: "gpl",
  issues: [],
}

export const MISSING_REPORT: FfmpegCapabilityReport = {
  status: "missing",
  checkedAt: "2026-11-21T00:00:00.000Z",
  ffmpeg: { available: false, version: null, problem: "not-found" },
  ffprobe: { available: false, version: null, problem: "not-found" },
  filters: [],
  h264Encoders: [],
  selectedH264Encoder: null,
  aacEncoder: null,
  license: "unknown",
  issues: [
    {
      code: "ffmpeg-missing",
      severity: "error",
      message:
        "FFmpeg wasn't found on this computer. Install it in your WSL Ubuntu terminal with: sudo apt install ffmpeg. Then select Check again.",
    },
    {
      code: "ffprobe-missing",
      severity: "error",
      message:
        "FFprobe wasn't found on this computer. Install it in your WSL Ubuntu terminal with: sudo apt install ffmpeg. Then select Check again.",
    },
  ],
}

/** Serves `reports` in order (the last one repeats); returns the requested URLs. */
export async function mockCapabilities(
  page: Page,
  ...reports: FfmpegCapabilityReport[]
) {
  const urls: string[] = []
  await page.route(ENDPOINT, async (route) => {
    urls.push(route.request().url())
    const report = reports[Math.min(urls.length - 1, reports.length - 1)]
    await route.fulfill({
      json: report,
      headers: { "cache-control": "no-store" },
    })
  })
  return urls
}

export async function openStudio(
  page: Page,
  report: FfmpegCapabilityReport = MISSING_REPORT,
) {
  const urls = await mockCapabilities(page, report)
  await page.goto(STUDIO_PATH)
  await page
    .locator(`[data-ffmpeg-status="${report.status}"]`)
    .waitFor({ state: "attached" })
  return urls
}

/** Draws a real PNG in the page (no fixture files needed). */
export async function makePng(page: Page, width: number, height: number) {
  const dataUrl = await page.evaluate(
    ([w, h]) => {
      const canvas = document.createElement("canvas")
      canvas.width = w
      canvas.height = h
      const g = canvas.getContext("2d")!
      g.fillStyle = "#2dd4bf"
      g.fillRect(0, 0, w, h)
      g.fillStyle = "#ffffff"
      g.fillRect(w / 4, h / 4, w / 2, h / 2)
      return canvas.toDataURL("image/png")
    },
    [width, height] as const,
  )
  return Buffer.from(dataUrl.split(",")[1], "base64")
}

export async function fillValidStoryboard(page: Page) {
  await page.getByLabel("Product name").fill("Trailblazer travel mug")
  await page.getByLabel("Video headline").fill("Hot coffee for 12 hours")
  await page
    .getByLabel("Benefit 1", { exact: true })
    .fill("Leak-proof lid for your bag")
  await page.getByLabel("Call to action").fill("Tap the link to shop")
  await page.getByLabel("Product images").setInputFiles({
    name: "hero.png",
    mimeType: "image/png",
    buffer: await makePng(page, 900, 1200),
  })
  await page.getByRole("img", { name: /Product image 1/ }).waitFor()
}
