import type { Page } from "@playwright/test"

import { deflateSync, crc32 } from "node:zlib"

import {
  REQUIRED_FILTERS,
  type FfmpegCapabilityReport,
} from "../src/lib/video/capabilities"

/**
 * Pixel Studio test helpers. UI tests mock the FFmpeg endpoint so they behave
 * the same whether or not FFmpeg is installed; the real-render tests (marked
 * as such) use the actual server and FFmpeg.
 */

export const STUDIO_PATH = "/studio/pixel"
const ENDPOINT = "**/api/studio/pixel/capabilities**"

const filters = REQUIRED_FILTERS.map((name) => ({
  name: name as string,
  available: true,
  required: true,
}))

export const READY_REPORT: FfmpegCapabilityReport = {
  status: "ready",
  checkedAt: "2026-11-21T00:00:00.000Z",
  ffmpeg: { available: true, version: "6.1.1-3ubuntu5", problem: null },
  ffprobe: { available: true, version: "6.1.1-3ubuntu5", problem: null },
  filters: [...filters, { name: "xfade", available: true, required: false }],
  h264Encoders: [
    { name: "libx264", hardware: false, works: true },
    { name: "h264_nvenc", hardware: true, works: null },
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

/** A real, decodable RGB PNG built in Node (for API-level tests). */
export function makePngNode(
  width: number,
  height: number,
  rgb = [45, 212, 191],
) {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, "ascii"), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8) // 8-bit RGB
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/** A real JPEG drawn in the page (a simple "product" shot). */
export async function makeJpeg(
  page: Page,
  width: number,
  height: number,
  hue: number,
) {
  const dataUrl = await page.evaluate(
    ([w, h, hue]) => {
      const canvas = document.createElement("canvas")
      canvas.width = w
      canvas.height = h
      const g = canvas.getContext("2d")!
      const bg = g.createLinearGradient(0, 0, 0, h)
      bg.addColorStop(0, `hsl(${hue} 60% 85%)`)
      bg.addColorStop(1, `hsl(${hue} 50% 60%)`)
      g.fillStyle = bg
      g.fillRect(0, 0, w, h)
      // A mug-like product silhouette.
      g.fillStyle = `hsl(${hue + 180} 45% 30%)`
      g.fillRect(w * 0.3, h * 0.3, w * 0.4, h * 0.45)
      g.beginPath()
      g.arc(w * 0.7, h * 0.5, w * 0.1, -Math.PI / 2, Math.PI / 2)
      g.lineWidth = w * 0.04
      g.strokeStyle = g.fillStyle
      g.stroke()
      return canvas.toDataURL("image/jpeg", 0.9)
    },
    [width, height, hue] as const,
  )
  return Buffer.from(dataUrl.split(",")[1], "base64")
}

/** Fills a valid storyboard with three real images (hero first). */
export async function fillValidStoryboard(page: Page) {
  await page.getByLabel("Product name").fill("Trailblazer travel mug")
  await page.getByLabel("Video headline").fill("Hot coffee for 12 hours")
  await page
    .getByLabel("Benefit 1", { exact: true })
    .fill("Leak-proof lid for your bag")
  await page.getByLabel("Call to action").fill("Tap the link to shop")
  await page.getByLabel("Product images").setInputFiles([
    {
      name: "hero.jpg",
      mimeType: "image/jpeg",
      buffer: await makeJpeg(page, 1200, 1600, 20),
    },
    {
      name: "side.png",
      mimeType: "image/png",
      buffer: await makePng(page, 1600, 1200),
    },
    {
      name: "detail.jpg",
      mimeType: "image/jpeg",
      buffer: await makeJpeg(page, 1080, 1080, 200),
    },
  ])
  await page.getByRole("img", { name: /Product image 3/ }).waitFor()
}
