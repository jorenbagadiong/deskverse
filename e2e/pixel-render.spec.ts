import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"

import type { APIRequestContext } from "@playwright/test"

import { expect, test } from "./fixtures"
import {
  fillValidStoryboard,
  makePngNode,
  STUDIO_PATH,
} from "./pixel-studio-helpers"

/**
 * DV-003B with the real server and the real FFmpeg (nothing mocked). These
 * tests need FFmpeg/FFprobe on the machine serving the app; without them
 * they are skipped with that reason rather than passing.
 */

async function ffmpegReady(request: APIRequestContext) {
  const response = await request.get("/api/studio/pixel/capabilities")
  return response.ok() && (await response.json()).status === "ready"
}

const product = {
  name: "Trailblazer travel mug",
  headline: "Hot coffee for 12 hours",
  benefits: ["Leak-proof lid for your bag"],
  callToAction: "Tap the link to shop",
  disclosure: "#ad · I may earn a commission if you buy through my link.",
}

async function newJob(request: APIRequestContext) {
  const response = await request.post("/api/studio/pixel/jobs")
  expect(response.status()).toBe(201)
  return ((await response.json()) as { jobId: string }).jobId
}

async function uploadPng(
  request: APIRequestContext,
  jobId: string,
  png: Buffer,
  name = "shot.png",
) {
  return request.post(`/api/studio/pixel/jobs/${jobId}/assets`, {
    headers: {
      "content-type": "image/png",
      "x-file-name": encodeURIComponent(name),
    },
    data: png,
  })
}

test.describe("real rendering", () => {
  test.describe.configure({ timeout: 240_000 })

  test("uploads real images, renders an MP4, previews and downloads it", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      !(await ffmpegReady(request)),
      "FFmpeg isn't installed on this machine",
    )

    await page.goto(STUDIO_PATH)
    await expect(page.getByText("Ready", { exact: true })).toBeVisible()
    await fillValidStoryboard(page)
    const render = page.getByRole("button", { name: "Render MP4" })
    await expect(render).toBeEnabled()
    await render.click()

    // Real status from the server while it works.
    await expect(
      page.getByRole("button", { name: "Rendering…" }),
    ).toBeDisabled()
    const status = page
      .getByRole("status")
      .filter({ has: page.getByRole("progressbar") })
    await expect(status).toContainText(
      /Uploading images|Building|Waiting|Preparing|Composing|Encoding|Verifying/,
    )

    await expect(
      page.getByText("Video ready and verified by FFprobe."),
    ).toBeVisible({
      timeout: 180_000,
    })
    await expect(
      page.getByText(/1080 × 1920, H\.264, 30 fps, yuv420p/),
    ).toBeVisible()
    await expect(page.getByText(/Stored only on this computer/)).toBeVisible()

    // Preview: the native player points at the verified-only video route.
    const video = page.getByLabel("Rendered video preview")
    const src = await video.getAttribute("src")
    expect(src).toMatch(/^\/api\/studio\/pixel\/jobs\/job_[0-9a-f]{32}\/video$/)
    const ranged = await page.request.get(src!, {
      headers: { range: "bytes=0-99" },
    })
    expect(ranged.status()).toBe(206)
    expect(ranged.headers()["content-type"]).toBe("video/mp4")
    expect((await ranged.body()).subarray(4, 8).toString("ascii")).toBe("ftyp")
    // Playwright's Chromium has no H.264 decoder (Chrome does); check
    // playback only where the browser can decode it.
    const playable = await video.evaluate(
      (el: HTMLVideoElement) =>
        el.canPlayType('video/mp4; codecs="avc1.640028"') !== "",
    )
    if (playable) {
      await video.evaluate(
        (el: HTMLVideoElement) =>
          el.readyState >= 1 ||
          new Promise((resolve) =>
            el.addEventListener("loadedmetadata", resolve, { once: true }),
          ),
      )
      expect(
        await video.evaluate((el: HTMLVideoElement) => [
          el.videoWidth,
          el.videoHeight,
        ]),
      ).toEqual([1080, 1920])
    } else
      testInfo.annotations.push({
        type: "note",
        description: "Browser can't decode H.264; playback not checked.",
      })

    // Download: a real MP4 file the browser saves.
    const downloadPromise = page.waitForEvent("download")
    await page.getByRole("link", { name: "Download MP4" }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(
      /^trailblazer-travel-mug-[0-9a-f]{8}\.mp4$/,
    )
    const file = testInfo.outputPath("download.mp4")
    await download.saveAs(file)
    const probe = JSON.parse(
      execFileSync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate",
        "-of",
        "json",
        file,
      ]).toString(),
    )
    expect(probe.streams).toEqual([
      expect.objectContaining({
        codec_type: "video",
        codec_name: "h264",
        width: 1080,
        height: 1920,
        pix_fmt: "yuv420p",
        avg_frame_rate: "30/1",
      }),
    ])
    const duration = Number(probe.format.duration)
    expect(duration).toBeGreaterThanOrEqual(15)
    expect(duration).toBeLessThanOrEqual(30)
    expect((await readFile(file)).length).toBeGreaterThan(10_000)
  })
})

test.describe("render API rejects invalid requests", () => {
  test("refuses non-local callers and unknown jobs", async ({ request }) => {
    expect(
      (
        await request.post("/api/studio/pixel/jobs", {
          headers: { host: "evil.example" },
        })
      ).status(),
    ).toBe(403)
    expect(
      (
        await request.post("/api/studio/pixel/jobs", {
          headers: {
            origin: "https://evil.example",
            "sec-fetch-site": "cross-site",
          },
        })
      ).status(),
    ).toBe(403)
    expect((await request.get("/api/studio/pixel/jobs/job_123")).status()).toBe(
      404,
    )
    expect(
      (
        await request.get(`/api/studio/pixel/jobs/job_${"0".repeat(32)}`)
      ).status(),
    ).toBe(404)
    expect(
      (
        await request.get("/api/studio/pixel/jobs/..%2F..%2Fetc/video")
      ).status(),
    ).toBe(404)
  })

  test("validates uploads by their bytes and refuses tampered render requests", async ({
    request,
  }) => {
    test.skip(
      !(await ffmpegReady(request)),
      "FFmpeg isn't installed on this machine",
    )
    const jobId = await newJob(request)
    const assets = `/api/studio/pixel/jobs/${jobId}/assets`

    // Wrong type, mismatched bytes, too small, damaged.
    expect(
      (
        await request.post(assets, {
          headers: { "content-type": "image/svg+xml" },
          data: "<svg/>",
        })
      ).status(),
    ).toBe(415)
    const png = makePngNode(400, 600)
    expect(
      (
        await request.post(assets, {
          headers: { "content-type": "image/jpeg" },
          data: png,
        })
      ).status(),
    ).toBe(422)
    expect(
      (await uploadPng(request, jobId, makePngNode(100, 100))).status(),
    ).toBe(422)
    const damaged = Buffer.concat([png.subarray(0, 60), Buffer.alloc(200, 7)])
    const damagedResponse = await uploadPng(
      request,
      jobId,
      damaged,
      "damaged.png",
    )
    expect(damagedResponse.status()).toBe(422)
    expect((await damagedResponse.json()).message).toMatch(/damaged\.png/)

    // Three valid uploads.
    const ids: string[] = []
    for (const color of [
      [200, 60, 60],
      [60, 200, 60],
      [60, 60, 200],
    ]) {
      const response = await uploadPng(
        request,
        jobId,
        makePngNode(400, 600, color),
      )
      expect(response.status()).toBe(201)
      ids.push((await response.json()).asset.id)
    }

    const render = (data: unknown, headers: Record<string, string> = {}) =>
      request.post(`/api/studio/pixel/jobs/${jobId}/render`, {
        headers: { "content-type": "application/json", ...headers },
        data: JSON.stringify(data),
      })
    expect(
      (
        await render(
          { product, assetIds: ids },
          { "content-type": "text/plain" },
        )
      ).status(),
    ).toBe(415)
    const withScenes = await render({
      product,
      assetIds: ids,
      scenes: [],
      ffmpegArgs: ["-i", "/etc/passwd"],
    })
    expect(withScenes.status()).toBe(422)
    expect((await withScenes.json()).message).toMatch(/decided by the server/)

    const otherJob = await newJob(request)
    const foreign = await uploadPng(request, otherJob, makePngNode(400, 600))
    const foreignId = (await foreign.json()).asset.id
    const cross = await render({
      product,
      assetIds: [ids[0], ids[1], foreignId],
    })
    expect(cross.status()).toBe(422)
    expect((await cross.json()).message).toMatch(
      /wasn't uploaded to this video/,
    )

    expect(
      (await render({ product, assetIds: ids.slice(0, 2) })).status(),
    ).toBe(422)
    expect(
      (
        await render({ product: { ...product, headline: "" }, assetIds: ids })
      ).status(),
    ).toBe(422)

    // Nothing was rendered, so there is no video to fetch.
    expect(
      (await request.get(`/api/studio/pixel/jobs/${jobId}/video`)).status(),
    ).toBe(404)
    const job = await (
      await request.get(`/api/studio/pixel/jobs/${jobId}`)
    ).json()
    expect(job).toMatchObject({ state: "draft", videoUrl: null })
  })
})
