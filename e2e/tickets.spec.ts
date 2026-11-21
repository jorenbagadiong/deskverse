import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Locator, Page } from "@playwright/test"

import { allowConsoleError, expect, test } from "./fixtures"

/**
 * DV-004B: Affiliate Tickets end to end. Runs ONLY in the database suite
 * (`yarn test:e2e:db`): a fresh server with its own scratch database and
 * temporary media folder (scripts/e2e/database-server.ts), never the
 * owner's data. The tests share one ticket and run in order.
 */

test.describe.configure({ mode: "serial", timeout: 240_000 })

const CONTROL = "http://127.0.0.1:3212"
async function control(
  action: "restart" | "database/offline" | "database/online",
) {
  const response = await fetch(`${CONTROL}/${action}`, { method: "POST" })
  expect(response.ok, `control ${action}`).toBe(true)
}

const dir = path.join(os.tmpdir(), `deskverse-e2e-ticket-media-${process.pid}`)
const media: Record<string, string> = {}
test.beforeAll(() => {
  mkdirSync(dir, { recursive: true })
  const make = (name: string, args: string[]) => {
    media[name] = path.join(dir, name)
    execFileSync("ffmpeg", ["-v", "error", "-y", ...args, media[name]])
  }
  for (const [i, color] of ["orange", "teal", "purple"].entries())
    make(`lamp-${i + 1}.png`, [
      "-f",
      "lavfi",
      "-i",
      `color=${color}:size=800x800`,
      "-frames:v",
      "1",
    ])
  make("demo.mp4", [
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=480x854:rate=30",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
  ])
})

let ticketUrl = ""
/** e.g. "AFT-0002": numbers depend on which spec ran first. */
let ticketNumber = ""

const products = (page: Page) => page.locator("article[data-product-id]")
const product = (page: Page, n: number) => products(page).nth(n - 1)
const details = (page: Page) =>
  page.getByRole("region", { name: "Ticket details" })
const status = (page: Page) =>
  page.locator("header [data-ticket-status]").first()
const activity = (page: Page) =>
  page.getByRole("list", { name: "Activity history" })

async function openEditor(card: Locator) {
  const toggle = card.locator("header button[aria-expanded]")
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click()
}

test("creates an Affiliate Ticket and reopens it after a reload", async ({
  page,
}) => {
  await page.goto("/tickets")
  await page.getByLabel("Search tickets").fill("no such ticket zzz")
  await expect(page.getByText("No tickets match.")).toBeVisible()
  await page.getByRole("link", { name: "Create Affiliate Ticket" }).click()
  await expect(page).toHaveURL(/\/tickets\/new$/)

  // A too-short title is explained next to the field; nothing typed is lost.
  await page.getByLabel("Title").fill("ab")
  await page
    .getByLabel("Description")
    .fill("Ten kitchen products for November.")
  await page.getByRole("button", { name: "Save Draft" }).click()
  await expect(
    page.getByText(/meaningful title \(at least 3 characters\)/),
  ).toBeVisible()
  await expect(page.getByLabel("Description")).toHaveValue(
    "Ten kitchen products for November.",
  )

  await page.getByLabel("Title").fill("November kitchen campaign")
  await page.getByLabel("Target platform").selectOption("instagram_reels")
  await page.getByLabel("Priority").selectOption("high")
  await page
    .getByLabel("Instructions for the team")
    .fill("Friendly tone. Mention the warranty.")
  await page.getByLabel("Schedule").fill("One approved video per day")
  await page.getByRole("button", { name: "Save Draft" }).click()

  await expect(page).toHaveURL(/\/tickets\/[0-9a-f-]{36}$/)
  ticketUrl = new URL(page.url()).pathname
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "November kitchen campaign",
  )
  const number = page.locator("header p.font-mono").first()
  await expect(number).toHaveText(/^AFT-\d{4,}/)
  ticketNumber = /AFT-\d+/.exec((await number.textContent()) ?? "")![0]
  await expect(status(page)).toHaveText("Draft")

  await page.reload()
  await expect(details(page).getByLabel("Title")).toHaveValue(
    "November kitchen campaign",
  )
  await expect(details(page).getByLabel("Target platform")).toHaveValue(
    "instagram_reels",
  )
  await expect(details(page).getByLabel("Schedule")).toHaveValue(
    "One approved video per day",
  )
  await expect(activity(page)).toContainText("Ticket created as a Draft")
})

test("adds 10 products with affiliate links and references", async ({
  page,
}) => {
  await page.goto(ticketUrl)
  for (let i = 1; i <= 10; i++) {
    await page.getByRole("button", { name: "Add product" }).click()
    await expect(products(page)).toHaveCount(i)
    const card = product(page, i)
    await openEditor(card)
    await card.getByLabel("Product name").fill(`Product ${i}`)
    await card
      .getByLabel("Affiliate link")
      .fill(`https://shop.example.com/item-${i}?tag=me-20`)
    if (i === 1) {
      await card.getByRole("button", { name: "Add reference link" }).click()
      await card
        .getByLabel("Link 1 address")
        .fill("https://maker.example.com/specs/lamp")
      await card.getByLabel("Link 1 type").selectOption("manufacturer")
      await card.getByRole("button", { name: "Add reference link" }).click()
      await card
        .getByLabel("Link 2 address")
        .fill("https://reviews.example.org/lamp")
      await card.getByLabel("Link 2 type").selectOption("review")
      await card.getByLabel("Link 2 label").fill("Independent review")
    }
    await card.getByRole("button", { name: "Save product" }).click()
    await expect(card.getByText("Saved.")).toBeVisible()
  }
  // An invalid link is refused next to its field, and the text stays.
  const second = product(page, 2)
  await second.getByLabel("Affiliate link").fill("javascript:alert(1)")
  await second.getByRole("button", { name: "Save product" }).click()
  await expect(
    second.getByText("Affiliate link must start with https:// or http://."),
  ).toBeVisible()
  await expect(second.getByLabel("Affiliate link")).toHaveValue(
    "javascript:alert(1)",
  )
  await second.getByRole("button", { name: "Discard changes" }).click()

  await page.reload()
  await expect(products(page)).toHaveCount(10)
  await expect(
    page.getByRole("heading", { name: "Products (10)" }),
  ).toBeVisible()
  const first = product(page, 1)
  await openEditor(first)
  await expect(first.getByLabel("Affiliate link")).toHaveValue(
    "https://shop.example.com/item-1?tag=me-20",
  )
  await expect(first.getByLabel("Link 1 address")).toHaveValue(
    "https://maker.example.com/specs/lamp",
  )
  await expect(first.getByLabel("Link 2 label")).toHaveValue(
    "Independent review",
  )
  await expect(product(page, 10).locator("h3")).toHaveText("Product 10")
})

test("uploads images and a reference video, refuses a fake image, and keeps them after a reload", async ({
  page,
}) => {
  // The fake image below is refused by the server (400), which Chrome logs.
  allowConsoleError(
    page,
    /Failed to load resource: the server responded with a status of 400/,
  )
  await page.goto(ticketUrl)
  const first = product(page, 1)
  await openEditor(first)
  await first
    .getByLabel("Upload images for Product 1")
    .setInputFiles([
      media["lamp-1.png"],
      media["lamp-2.png"],
      media["lamp-3.png"],
    ])
  await expect(
    first.getByRole("list", { name: "Product 1 media" }).getByRole("listitem"),
  ).toHaveCount(3, { timeout: 60_000 })
  await first
    .getByLabel("Upload a video clip for Product 1")
    .setInputFiles(media["demo.mp4"])
  await expect(
    first.getByRole("list", { name: "Product 1 media" }).getByRole("listitem"),
  ).toHaveCount(4, { timeout: 60_000 })
  await expect(
    first.getByText("Enough images for a Pixel video."),
  ).toBeVisible()

  // An HTML file pretending to be a PNG is refused with a clear reason.
  await first.getByLabel("Upload images for Product 1").setInputFiles({
    name: "not-really.png",
    mimeType: "image/png",
    buffer: Buffer.from("<!doctype html><script>alert(1)</script>"),
  })
  await expect(
    first
      .getByRole("alert")
      .filter({ hasText: /aren't a JPEG, PNG, WebP image or MP4 video/ }),
  ).toBeVisible()

  await page.reload()
  await openEditor(product(page, 1))
  const gallery = product(page, 1).getByRole("list", {
    name: "Product 1 media",
  })
  await expect(gallery.getByRole("listitem")).toHaveCount(4)
  const image = gallery.getByRole("img").first()
  await expect(image).toHaveAttribute("alt", /^Product 1, image 1/)
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(800)
  const video = gallery.locator("video")
  // The server streams the clip as MP4 with byte ranges (what <video> seeks with).
  const videoSrc = (await video.getAttribute("src"))!
  const ranged = await page.request.get(videoSrc, {
    headers: { Range: "bytes=0-99" },
  })
  expect(ranged.status()).toBe(206)
  expect(ranged.headers()["content-type"]).toBe("video/mp4")
  expect(ranged.headers()["content-range"]).toMatch(/^bytes 0-99\/\d+$/)
  // Playback needs an H.264 decoder: desktop Chrome has one, Playwright's
  // open-source Chromium doesn't. Asserted where possible, never faked.
  const h264 = await video.evaluate((v: HTMLVideoElement) =>
    v.canPlayType('video/mp4; codecs="avc1.640028"'),
  )
  if (h264) {
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 1))
      .toBe(true)
  } else {
    test.info().annotations.push({
      type: "not tested",
      description:
        "In-browser MP4 playback: this browser has no H.264 decoder (Chromium build).",
    })
  }

  // The media endpoint answers only for this product, privately.
  const src = (await image.getAttribute("src"))!
  const ok = await page.request.get(src)
  expect(ok.status()).toBe(200)
  expect(ok.headers()["cache-control"]).toBe("private, no-store")
  expect(ok.headers()["x-content-type-options"]).toBe("nosniff")
  const otherProduct = await product(page, 2).getAttribute("data-product-id")
  const crossed = await page.request.get(
    src.replace(/products\/[^/]+/, `products/${otherProduct}`),
  )
  expect(crossed.status()).toBe(404)
  await expect(activity(page)).toContainText("Video clip uploaded to Product 1")
})

test("edits a product, marks the ticket Ready, and an edit returns it to Draft", async ({
  page,
}) => {
  await page.goto(ticketUrl)
  const second = product(page, 2)
  await openEditor(second)
  await second.getByLabel("Product name").fill("Product 2 (blue)")
  await second
    .getByLabel("Specifications and facts")
    .fill("1.7 litres. 2-year warranty.")
  await second.getByRole("button", { name: "Save product" }).click()
  await expect(second.locator("h3")).toHaveText("Product 2 (blue)")
  await expect(activity(page)).toContainText(
    "Product 2 (blue) updated: name, specifications",
  )

  await page.getByRole("button", { name: "Mark Ready" }).click()
  await expect(status(page)).toHaveText("Ready")
  await expect(
    page.getByText(
      /Ready means eligible for future processing\. Nothing runs yet/,
    ),
  ).toBeVisible()

  const third = product(page, 3)
  await openEditor(third)
  await third.getByLabel("Notes").fill("Use the kitchen photo.")
  await third.getByRole("button", { name: "Save product" }).click()
  await expect(status(page)).toHaveText("Draft")
  await expect(activity(page).getByRole("listitem").first()).toHaveText(
    /Returned to Draft because its content changed/,
  )
})

test("archives the ticket (read-only) and restores it", async ({ page }) => {
  await page.goto(ticketUrl)
  await page.getByRole("button", { name: "Archive" }).click()
  const dialog = page.getByRole("alertdialog")
  await expect(dialog).toContainText("Nothing is deleted")
  await dialog.getByRole("button", { name: "Archive ticket" }).click()
  await expect(status(page)).toHaveText("Archived")
  await expect(details(page).getByLabel("Title")).toBeDisabled()
  await expect(page.getByRole("button", { name: "Add product" })).toHaveCount(0)

  await page.goto("/tickets")
  await expect(page.getByText("November kitchen campaign")).toHaveCount(0)
  await page.getByRole("radio", { name: "Archived" }).click()
  await expect(
    page.getByRole("list", { name: "Affiliate Tickets" }),
  ).toContainText("November kitchen campaign")

  await page.goto(ticketUrl)
  await page.getByRole("button", { name: "Restore to Draft" }).click()
  await expect(status(page)).toHaveText("Draft")
  await expect(activity(page).getByRole("listitem").first()).toHaveText(
    /Restored to Draft/,
  )
})

test("keeps everything across an application restart", async ({ page }) => {
  await control("restart")
  await page.goto(ticketUrl)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "November kitchen campaign",
  )
  await expect(products(page)).toHaveCount(10)
  await openEditor(product(page, 1))
  const gallery = product(page, 1).getByRole("list", {
    name: "Product 1 media",
  })
  await expect(gallery.getByRole("listitem")).toHaveCount(4)
  await expect
    .poll(() =>
      gallery
        .getByRole("img")
        .first()
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(800)
  await page.goto("/tickets")
  const row = page
    .getByRole("list", { name: "Affiliate Tickets" })
    .getByRole("listitem")
    .filter({ hasText: "November kitchen campaign" })
  await expect(row).toContainText(ticketNumber)
  await expect(row).toContainText("10 products")
  await page.getByLabel("Search tickets").fill(ticketNumber)
  await expect(page.getByText("1 ticket", { exact: true })).toBeVisible()
})

test("explains a PostgreSQL outage and keeps unsaved input", async ({
  page,
}) => {
  // Requests made while the database is down answer 503, which Chrome logs.
  allowConsoleError(
    page,
    /Failed to load resource: the server responded with a status of 503/,
  )
  await page.goto(ticketUrl)
  // Load the workspace first, then take the database down under it.
  await expect(products(page)).toHaveCount(10)
  const first = product(page, 1)
  await openEditor(first)
  await control("database/offline")
  try {
    await first.getByLabel("Notes").fill("Typed while the database was down")
    await first.getByRole("button", { name: "Save product" }).click()
    await expect(first.getByRole("alert")).toContainText(
      "Local PostgreSQL isn't running",
    )
    await expect(first.getByRole("alert")).toContainText(
      "Nothing was saved; your changes are still on this page",
    )
    await expect(first.getByLabel("Notes")).toHaveValue(
      "Typed while the database was down",
    )

    await page.goto("/tickets")
    await expect(
      page.getByText("Affiliate Tickets are unavailable right now."),
    ).toBeVisible()
    await page.goto("/tickets/new")
    await page.getByLabel("Title").fill("Created during an outage")
    await page.getByRole("button", { name: "Save Draft" }).click()
    await expect(page.getByText("The ticket wasn't saved.")).toBeVisible()
    await expect(page.getByLabel("Title")).toHaveValue(
      "Created during an outage",
    )
    // The rest of Deskverse keeps working.
    await page.goto("/studio/pixel")
    await expect(
      page.getByRole("heading", { name: "Pixel Studio" }),
    ).toBeVisible()
  } finally {
    await control("database/online")
  }
  await page.goto(ticketUrl)
  const again = product(page, 1)
  await openEditor(again)
  await again.getByLabel("Notes").fill("Saved after recovery")
  await again.getByRole("button", { name: "Save product" }).click()
  await expect(again.getByText("Saved.")).toBeVisible()
})

test("removes an attachment and a product after confirmation", async ({
  page,
}) => {
  await page.goto(ticketUrl)
  const first = product(page, 1)
  await openEditor(first)
  const gallery = first.getByRole("list", { name: "Product 1 media" })
  await gallery.getByRole("button", { name: /^Remove lamp-3\.png$/ }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Remove file" })
    .click()
  await expect(gallery.getByRole("listitem")).toHaveCount(3)

  const last = product(page, 10)
  await openEditor(last)
  await last.getByRole("button", { name: "Remove product" }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Remove product" })
    .click()
  await expect(products(page)).toHaveCount(9)
  await expect(activity(page)).toContainText("A product was removed")
})
