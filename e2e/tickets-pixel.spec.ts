import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"

import type { APIRequestContext, Page } from "@playwright/test"

import { FIXTURE_PRODUCTS } from "../scripts/scout/fixture-sites"
import { expect, noHorizontalOverflow, test } from "./fixtures"

/**
 * DV-005C: the Pixel Videos section end to end, with a REAL worker
 * (scripts/e2e/database-server.ts) that researches fixture sites (Scout),
 * writes scripts (Quill) and renders REAL videos with FFmpeg (Pixel) in the
 * suite's temporary media folder.
 */

test.describe.configure({ mode: "serial", timeout: 300_000 })

const CONTROL = "http://127.0.0.1:3212"
const rid = () => crypto.randomUUID()
const k = FIXTURE_PRODUCTS.kettle

function images(n: number, seed: number) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deskverse-e2e-images-"))
  const out: Buffer[] = []
  for (let i = 0; i < n; i++) {
    const file = path.join(dir, `i${i}.png`)
    execFileSync("ffmpeg", [
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=900x900:rate=1,hue=h=${(seed + i) * 53}`,
      "-frames:v",
      "1",
      "-y",
      file,
    ])
    out.push(readFileSync(file))
  }
  rmSync(dir, { recursive: true, force: true })
  return out
}

async function waitRun(
  request: APIRequestContext,
  ticketId: string,
  workflow: string,
) {
  await expect
    .poll(
      async () => {
        const runs = (
          await (await request.get(`/api/tickets/${ticketId}/runs`)).json()
        ).runs as { workflow: string; status: string }[]
        return runs.find((r) => r.workflow === workflow)?.status
      },
      { timeout: 120_000 },
    )
    .toMatch(/^completed/)
}

/** A Ready ticket with images, Scout research and a Quill script. */
async function seeded(
  request: APIRequestContext,
  title: string,
  n = 4,
  rights = "owned",
) {
  let ticket = (
    await (
      await request.post("/api/tickets", { data: { requestId: rid(), title } })
    ).json()
  ).ticket
  ticket = (
    await (
      await request.post(`/api/tickets/${ticket.id}/products`, {
        data: {
          requestId: rid(),
          name: k.name,
          affiliateUrl: k.affiliateUrl,
          specifications: k.specifications,
          description: k.description,
          references: k.references,
          mediaRights: rights,
        },
      })
    ).json()
  ).ticket
  const productId = ticket.products[0].id
  for (const [i, bytes] of images(n, title.length).entries()) {
    const r = await request.post(
      `/api/tickets/${ticket.id}/products/${productId}/assets`,
      {
        headers: {
          "content-type": "image/png",
          "x-file-name": `photo-${i}.png`,
        },
        data: bytes,
      },
    )
    expect(r.status(), await r.text()).toBe(201)
  }
  ticket = (await (await request.get(`/api/tickets/${ticket.id}`)).json())
    .ticket
  ticket = (
    await (
      await request.patch(`/api/tickets/${ticket.id}`, {
        data: { version: ticket.version, status: "ready" },
      })
    ).json()
  ).ticket
  expect(
    (
      await request.post(`/api/tickets/${ticket.id}/runs`, {
        data: {
          requestId: rid(),
          ticketVersion: ticket.version,
          mode: "production",
          workflow: "scout-research-v1",
        },
      })
    ).status(),
  ).toBe(201)
  await waitRun(request, ticket.id, "scout-research-v1")
  const report = (
    await (await request.get(`/api/tickets/${ticket.id}/scripts`)).json()
  ).products[0].reports[0].reportId
  expect(
    (
      await request.post(`/api/tickets/${ticket.id}/runs`, {
        data: {
          requestId: rid(),
          ticketVersion: ticket.version,
          mode: "production",
          workflow: "quill-script-v1",
          scripts: [{ productId, reportId: report }],
        },
      })
    ).status(),
  ).toBe(201)
  await waitRun(request, ticket.id, "quill-script-v1")
  return {
    id: ticket.id as string,
    version: ticket.version as number,
    productId: productId as string,
  }
}

const pixel = (page: Page) => page.getByRole("region", { name: "Pixel Videos" })
const runStatus = (page: Page) => pixel(page).getByTestId("pixel-run-status")

test("explains what a video needs before it can be rendered", async ({
  page,
  request,
}) => {
  let ticket = (
    await (
      await request.post("/api/tickets", {
        data: { requestId: rid(), title: "Pixel empty" },
      })
    ).json()
  ).ticket
  ticket = (
    await (
      await request.post(`/api/tickets/${ticket.id}/products`, {
        data: { requestId: rid(), name: k.name, affiliateUrl: k.affiliateUrl },
      })
    ).json()
  ).ticket
  await page.goto(`/tickets/${ticket.id}`)
  await expect(pixel(page).getByTestId("pixel-availability")).toContainText(
    "Video only",
  )
  await expect(pixel(page).getByTestId("pixel-ffmpeg")).toContainText("ready")
  await expect(pixel(page).getByTestId("pixel-readiness")).toHaveText(
    "No Quill script yet: write one in Quill Scripts above.",
  )
  await expect(
    pixel(page).getByRole("button", { name: /Start render/ }),
  ).toBeDisabled()
  await expect(pixel(page).getByText("No videos yet.")).toBeVisible()
})

test("renders a real video from the chosen script and images; preview, download and restart", async ({
  page,
  request,
}) => {
  const t = await seeded(request, "Pixel flow")
  await page.goto(`/tickets/${t.id}`)
  const product = pixel(page).getByTestId("pixel-product")
  await expect(product.getByRole("combobox")).toHaveValue(/[0-9a-f-]{36}/)
  await expect(product.getByRole("checkbox", { checked: true })).toHaveCount(4)
  await expect(product.getByTestId("pixel-readiness")).toContainText(
    "Ready to render",
  )
  const start = pixel(page).getByRole("button", { name: "Start render" })
  await start.focus()
  await page.keyboard.press("Enter")
  // Real progress (from FFmpeg via the worker) appears while it renders.
  await expect(pixel(page).getByTestId("pixel-progress")).toBeVisible({
    timeout: 60_000,
  })
  await expect(runStatus(page)).toHaveText("Completed", { timeout: 240_000 })
  await expect(
    page
      .getByRole("region", { name: "Workflow" })
      .getByRole("heading", { name: "Video run (Pixel only)" }),
  ).toBeVisible()
  const card = pixel(page).getByTestId("pixel-video").first()
  await expect(card.getByTestId("awaiting-qa")).toHaveText(
    "Technically verified — Awaiting Vera QA",
  )
  await expect(card.getByTestId("video-technical")).toContainText(
    "1080×1920 · 30 fps · h264 (yuv420p)",
  )
  await expect(card.getByTestId("video-technical")).toContainText(
    "silent (captions only)",
  )
  await expect(card.getByTestId("video-technical")).toContainText(
    "Disclosure found in real frames",
  )
  const src = (await card.locator("video").getAttribute("src"))!
  // Secure delivery: type, nosniff, ranges, download, strict input, ownership.
  const full = await request.get(src)
  expect(full.status()).toBe(200)
  expect(full.headers()["content-type"]).toBe("video/mp4")
  expect(full.headers()["x-content-type-options"]).toBe("nosniff")
  expect(full.headers()["cache-control"]).toContain("no-store")
  const bytes = await full.body()
  expect(bytes.subarray(4, 8).toString("latin1")).toBe("ftyp")
  const part = await request.get(src, { headers: { range: "bytes=0-99" } })
  expect(part.status()).toBe(206)
  expect(part.headers()["content-range"]).toBe(`bytes 0-99/${bytes.length}`)
  expect(
    (await request.get(`${src}?download=1`)).headers()["content-disposition"],
  ).toMatch(/^attachment; filename=".+-v1\.mp4"$/)
  expect((await request.get(`${src}?path=/etc/passwd`)).status()).toBe(400)
  const other = (
    await (
      await request.post("/api/tickets", {
        data: { requestId: rid(), title: "Pixel other" },
      })
    ).json()
  ).ticket
  expect((await request.get(src.replace(t.id, other.id))).status()).toBe(404)
  const meta = await (await request.get(src.replace(/\/file$/, ""))).json()
  expect(meta).toMatchObject({
    width: 1080,
    height: 1920,
    status: "technically_verified_awaiting_qa",
    disclosureVerified: true,
  })
  expect(JSON.stringify(meta)).not.toMatch(/\/home\/|\/tmp\/|ticket-renders/)
  // Browser playback: only claimed if this browser can decode H.264.
  const playable = await page.evaluate(() =>
    document
      .createElement("video")
      .canPlayType('video/mp4; codecs="avc1.640028"'),
  )
  test.info().annotations.push({
    type: "playback",
    description: playable
      ? `canPlayType: ${playable}`
      : "NOT TESTED: this Chromium has no H.264 decoder",
  })
  // Persisted across an application restart (leave the page first: its
  // status polling would otherwise hit the server while it is down).
  await page.goto("about:blank")
  expect((await fetch(`${CONTROL}/restart`, { method: "POST" })).ok).toBe(true)
  await page.goto(`/tickets/${t.id}`)
  await expect(pixel(page).getByTestId("awaiting-qa").first()).toBeVisible()
  // The full campaign stays refused (Vera).
  const campaign = await request.post(`/api/tickets/${t.id}/runs`, {
    data: {
      requestId: rid(),
      ticketVersion: t.version,
      mode: "production",
      workflow: "campaign-v1",
    },
  })
  expect(campaign.status()).toBe(503)
  expect((await campaign.json()).message).toMatch(
    /Vera \(DV-006A\) isn't built/,
  )
})

test("cancels a render in progress; a damaged image needs input and Retry renders after the repair", async ({
  page,
  request,
}) => {
  const t = await seeded(request, "Pixel controls", 3)
  await page.goto(`/tickets/${t.id}`)
  await pixel(page).getByRole("button", { name: "Start render" }).click()
  await expect(pixel(page).getByTestId("pixel-progress")).toBeVisible({
    timeout: 60_000,
  })
  await pixel(page).getByRole("button", { name: "Cancel run" }).click()
  await expect(runStatus(page)).toHaveText("Cancelled", { timeout: 60_000 })
  await expect(pixel(page).getByTestId("pixel-video")).toHaveCount(0)

  // Damage one pinned image in the suite's temporary media folder, render, then repair and retry.
  const root = readdirSync(os.tmpdir())
    .filter((d) => d.startsWith("deskverse-e2e-tickets-"))
    .map((d) => path.join(os.tmpdir(), d, "tickets", t.id, "assets"))
    .find((d) => existsSync(d))!
  const file = path.join(root, readdirSync(root).sort()[0])
  const original = readFileSync(file)
  const damaged = Buffer.from(original)
  damaged[damaged.length - 10] ^= 0xff
  writeFileSync(file, damaged)
  await page.reload()
  await pixel(page).getByRole("button", { name: "Start render" }).click()
  // The only product needs input, so the run as a whole ends Failed (orchestrator rule).
  await expect(runStatus(page)).toHaveText("Failed", { timeout: 120_000 })
  await expect(
    pixel(page).locator("li[data-pixel-task-status]"),
  ).toHaveAttribute("data-pixel-task-status", "needs_input")
  await expect(pixel(page).getByTestId("pixel-task-message")).toContainText(
    /pinned image/,
  )
  writeFileSync(file, original)
  await pixel(page)
    .getByRole("button", { name: /^Retry the video/ })
    .click()
  await expect(runStatus(page)).toHaveText("Completed", { timeout: 240_000 })
  await expect(pixel(page).getByTestId("awaiting-qa").first()).toBeVisible()
})

test("refuses a script written before new images were added, and says what to do", async ({
  page,
  request,
}) => {
  const t = await seeded(request, "Pixel stale", 3)
  const detail = (await (await request.get(`/api/tickets/${t.id}`)).json())
    .ticket
  expect(
    (
      await request.patch(`/api/tickets/${t.id}`, {
        data: { version: detail.version, status: "draft" },
      })
    ).status(),
  ).toBe(200)
  const [extra] = images(1, 99)
  expect(
    (
      await request.post(
        `/api/tickets/${t.id}/products/${t.productId}/assets`,
        {
          headers: { "content-type": "image/png", "x-file-name": "late.png" },
          data: extra,
        },
      )
    ).status(),
  ).toBe(201)
  const draft = (await (await request.get(`/api/tickets/${t.id}`)).json())
    .ticket
  const now = (
    await (
      await request.patch(`/api/tickets/${t.id}`, {
        data: { version: draft.version, status: "ready" },
      })
    ).json()
  ).ticket
  await page.goto(`/tickets/${t.id}`)
  await expect(pixel(page).getByTestId("pixel-readiness")).toHaveText(
    "The product changed after this script (e.g. new images). Run Scout and Quill again.",
  )
  await expect(
    pixel(page).getByRole("button", { name: /Start render/ }),
  ).toBeDisabled()
  const overview = await (
    await request.get(`/api/tickets/${t.id}/videos`)
  ).json()
  const script = overview.products[0].scripts[0]
  const refused = await request.post(`/api/tickets/${t.id}/runs`, {
    data: {
      requestId: rid(),
      ticketVersion: now.version,
      mode: "production",
      workflow: "pixel-render-v1",
      renders: [
        {
          productId: t.productId,
          scriptId: script.scriptId,
          assetIds: script.imageIds.slice(0, 3),
        },
      ],
    },
  })
  expect(refused.status()).toBe(409)
  expect((await refused.json()).message).toMatch(
    /run Scout again, write a new Quill script from the new research, then start Pixel/,
  )
})

for (const width of [360, 375])
  test(`fits a ${width} px screen with a finished video`, async ({
    page,
    request,
  }) => {
    const t = await seeded(request, `Pixel ${width}`, 3)
    await page.setViewportSize({ width, height: 800 })
    await page.goto(`/tickets/${t.id}`)
    await pixel(page).getByRole("button", { name: "Start render" }).click()
    await expect(runStatus(page)).toHaveText("Completed", { timeout: 240_000 })
    await pixel(page).scrollIntoViewIfNeeded()
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
  })
