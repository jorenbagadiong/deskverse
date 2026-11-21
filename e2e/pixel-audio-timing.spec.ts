import { execFileSync, spawnSync } from "node:child_process"
import { writeFile } from "node:fs/promises"

import type { APIRequestContext, Page } from "@playwright/test"

import type { JobHistory, RenderRequest } from "../src/lib/video/render-api"
import { expect, noHorizontalOverflow, test } from "./fixtures"
import {
  fillValidStoryboard,
  makeWavNode,
  openStudio,
  READY_REPORT,
  STUDIO_PATH,
} from "./pixel-studio-helpers"

/** DV-003D3: voiceover trim, start offset and the narration timeline. */

const audioMode = (page: Page, name: string) =>
  page.getByRole("radio", { name: new RegExp(`^${name}`) })
const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true })

async function chooseVoiceover(page: Page, seconds: number) {
  await page.getByLabel("Voiceover file", { exact: true }).setInputFiles({
    name: "narration.wav",
    mimeType: "audio/wav",
    buffer: makeWavNode(seconds),
  })
  // The browser reads the duration (a hint; the server uses FFprobe).
  await expect(page.getByText(`${seconds.toFixed(1)} s ·`)).toBeVisible()
}

async function audioReady(request: APIRequestContext) {
  const response = await request.get("/api/studio/pixel/capabilities")
  if (!response.ok()) return false
  const report = await response.json()
  return report.status === "ready" && report.audio.ready
}

test.describe("Voiceover timing (FFmpeg mocked)", () => {
  test("shows trim, start, the selected length, the finish time and a timeline", async ({
    page,
  }) => {
    await openStudio(page, READY_REPORT)
    await fillValidStoryboard(page)
    // No timing controls without a voiceover.
    await expect(field(page, "Trim start (s)")).toHaveCount(0)
    await audioMode(page, "Voiceover").first().check()
    await chooseVoiceover(page, 12)
    await expect(field(page, "Trim start (s)")).toHaveValue("0")
    await expect(field(page, "Trim end (s)")).toHaveValue("")
    await expect(field(page, "Narration starts at (s)")).toHaveValue("0")
    const summary = page.getByTestId("narration-summary")
    await expect(summary).toContainText("Selected 12 s")
    await expect(summary).toContainText("finishes at 12 s")

    await field(page, "Trim start (s)").fill("1.5")
    await field(page, "Trim end (s)").fill("9.5")
    await field(page, "Narration starts at (s)").fill("2")
    await expect(summary).toContainText(
      "Selected 8 s (from 1.5 s to 9.5 s of the 12 s recording). Narration plays from 2 s and finishes at 10 s",
    )
    await expect(
      page.getByRole("img", { name: /^Timeline: narration from 2 s to 10 s/ }),
    ).toBeVisible()
    await expect(page.getByRole("button", { name: "Render MP4" })).toBeEnabled()
  })

  test("explains invalid timing next to each field and blocks rendering", async ({
    page,
  }) => {
    await openStudio(page, READY_REPORT)
    await fillValidStoryboard(page)
    await audioMode(page, "Voiceover").first().check()
    await chooseVoiceover(page, 12)
    const render = page.getByRole("button", { name: "Render MP4" })

    await field(page, "Trim start (s)").fill("abc")
    await expect(
      page.getByText("Trim start must be a time in seconds, like 3 or 2.5."),
    ).toBeVisible()
    await expect(render).toBeDisabled()

    await field(page, "Trim start (s)").fill("6")
    await field(page, "Trim end (s)").fill("4")
    await expect(
      page.getByText("Trim start (6 s) must be before trim end (4 s)."),
    ).toBeVisible()

    await field(page, "Trim end (s)").fill("13")
    await expect(
      page.getByText(
        "Trim end (13 s) is past the end of the recording (12 s).",
      ),
    ).toBeVisible()

    // Fits only if it ends by the end of the video: never cut off.
    await field(page, "Trim start (s)").fill("0")
    await field(page, "Trim end (s)").fill("")
    await field(page, "Narration starts at (s)").fill("10")
    await expect(
      page.getByText(
        /The narration would play from 10 s to 22 s, but the video is/,
      ),
    ).toBeVisible()
    await expect(render).toBeDisabled()
    await field(page, "Narration starts at (s)").fill("1")
    await expect(render).toBeEnabled()
  })

  test("sends whole milliseconds, never filters, and shows the server-approved timing", async ({
    page,
  }) => {
    await openStudio(page, READY_REPORT)
    const jobId = `job_${"e".repeat(32)}`
    let body: RenderRequest | null = null
    await page.route("**/api/studio/pixel/jobs", (route) =>
      route.request().method() !== "POST"
        ? route.fallback()
        : route.fulfill({ status: 201, json: { jobId } }),
    )
    let n = 0
    await page.route(`**/api/studio/pixel/jobs/${jobId}/assets`, (route) =>
      route.fulfill({
        status: 201,
        json: {
          asset: {
            id: `asset_${String(++n).repeat(32)}`,
            displayName: "x",
            mimeType: "image/jpeg",
            sizeBytes: 1,
            width: 1200,
            height: 1600,
          },
        },
      }),
    )
    await page.route(`**/api/studio/pixel/jobs/${jobId}/audio?**`, (route) =>
      route.fulfill({
        status: 201,
        json: {
          audio: {
            id: `asset_${"c".repeat(32)}`,
            role: "voiceover",
            displayName: "narration.wav",
            container: "wav",
            sizeBytes: 1,
            durationSeconds: 12,
            sampleRate: 44100,
            channels: 1,
          },
        },
      }),
    )
    const status = {
      jobId,
      state: "queued",
      progress: { phase: "waiting", position: 1 },
      error: null,
      output: null,
      videoUrl: null,
      downloadUrl: null,
    }
    await page.route(`**/api/studio/pixel/jobs/${jobId}/render`, (route) => {
      body = route.request().postDataJSON()
      return route.fulfill({
        status: 202,
        json: {
          ...status,
          narration: {
            startSeconds: 2.25,
            endSeconds: 10.25,
            trimStartSeconds: 1.5,
            trimEndSeconds: 9.5,
            videoSeconds: 15,
          },
        },
      })
    })
    await page.route(`**/api/studio/pixel/jobs/${jobId}`, (route) =>
      route.fulfill({ json: status }),
    )

    await fillValidStoryboard(page)
    await audioMode(page, "Voiceover").first().check()
    await chooseVoiceover(page, 12)
    await field(page, "Trim start (s)").fill("1.5")
    await field(page, "Trim end (s)").fill("9.5")
    await field(page, "Narration starts at (s)").fill("2.25")
    await page.getByRole("button", { name: "Render MP4" }).click()
    await expect(page.getByTestId("narration-approved")).toHaveText(
      "Approved by the server for the latest render: narration 2.25 s – 10.25 s of 15 s (recording 1.5 s – 9.5 s).",
    )
    expect(body!.audio).toEqual({
      mode: "voiceover",
      voiceoverAssetId: `asset_${"c".repeat(32)}`,
      musicAssetId: null,
      musicLevel: "low",
      voiceoverTiming: { trimStartMs: 1500, trimEndMs: 9500, offsetMs: 2250 },
    })
  })

  test("fits a 360 px screen with the timing controls and timeline", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await openStudio(page, READY_REPORT)
    await audioMode(page, "Voiceover \\+ music").check()
    await chooseVoiceover(page, 12)
    await field(page, "Narration starts at (s)").scrollIntoViewIfNeeded()
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0)
    const timeline = await page.getByTestId("narration-timeline").boundingBox()
    expect(timeline!.x + timeline!.width).toBeLessThanOrEqual(360)
  })
})

test.describe("Voiceover timing: real rendering", () => {
  test.describe.configure({ timeout: 300_000 })

  test("renders trimmed, offset narration over looping music; previews, downloads, and lists it", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      !(await audioReady(request)),
      "FFmpeg audio isn't available on this machine",
    )
    const name = `Timed lamp ${Date.now().toString(36)}`
    // Narration: a steady 12 s 300 Hz tone (1–9 s of it is used);
    // music: a 2 s 1 kHz track that must loop several times.
    const voice = makeWavNode(12, { frequency: 300, amplitude: 0.4 })
    const music = makeWavNode(2, { frequency: 1000, channels: 2 })
    await page.goto(STUDIO_PATH)
    await expect(page.getByText("Ready", { exact: true })).toBeVisible()
    await fillValidStoryboard(page)
    await page.getByLabel("Product name").fill(name)
    await audioMode(page, "Voiceover \\+ music").check()
    await page.getByLabel("Voiceover file", { exact: true }).setInputFiles({
      name: "narration.wav",
      mimeType: "audio/wav",
      buffer: voice,
    })
    await page
      .getByLabel("Background music file", { exact: true })
      .setInputFiles({ name: "loop.wav", mimeType: "audio/wav", buffer: music })
    await field(page, "Trim start (s)").fill("1")
    await field(page, "Trim end (s)").fill("9")
    await field(page, "Narration starts at (s)").fill("2")
    await page.getByRole("button", { name: "Render MP4" }).click()

    // The server's approved timing matches what was asked for.
    await expect(page.getByTestId("narration-approved")).toContainText(
      "narration 2 s – 10 s",
      { timeout: 60_000 },
    )
    await expect(
      page.getByText("Video ready and verified by FFprobe."),
    ).toBeVisible({ timeout: 240_000 })
    await expect(page.getByLabel("Rendered video preview")).toHaveAttribute(
      "src",
      /\/video$/,
    )

    const download = page.waitForEvent("download")
    await page.getByRole("link", { name: "Download MP4" }).click()
    const file = testInfo.outputPath("timed.mp4")
    await (await download).saveAs(file)
    const streams = JSON.parse(
      execFileSync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,sample_rate,channels",
        "-of",
        "json",
        file,
      ]).toString(),
    ).streams
    expect(streams).toEqual([
      expect.objectContaining({ codec_type: "video", codec_name: "h264" }),
      expect.objectContaining({
        codec_type: "audio",
        codec_name: "aac",
        sample_rate: "48000",
        channels: 2,
      }),
    ])
    // The narration (300 Hz) is silent before 2 s and present after it.
    const band = (start: number, duration: number) => {
      const out = spawnSync(
        "ffmpeg",
        [
          "-nostdin",
          "-hide_banner",
          "-ss",
          String(start),
          "-t",
          String(duration),
          "-i",
          file,
          "-map",
          "0:a",
          "-af",
          "bandpass=f=300:width_type=q:w=8,astats=measure_overall=RMS_level:measure_perchannel=none",
          "-f",
          "null",
          "-",
        ],
        { encoding: "utf8" },
      ).stderr
      const value = [...out.matchAll(/RMS level dB: (-?[\d.]+|-inf)/g)].at(-1)
      return value?.[1] === "-inf" || !value ? -Infinity : Number(value[1])
    }
    const before = band(0.5, 1.3)
    const during = band(4, 3)
    expect(during - before).toBeGreaterThan(20)
    await writeFile(
      testInfo.outputPath("levels.txt"),
      `300 Hz band: before ${before} dB, during ${during} dB\n`,
    )

    await page.reload()
    const item = page
      .getByRole("list", { name: "Render history" })
      .getByRole("listitem")
      .filter({ hasText: name })
    await expect(item.getByText("Completed")).toBeVisible()
    await expect(item).toContainText("Narration 2 s–10 s")
    const history: JobHistory = await (
      await request.get("/api/studio/pixel/jobs")
    ).json()
    expect(
      history.jobs.find((j) => j.productName === name)?.narration,
    ).toMatchObject({ startSeconds: 2, endSeconds: 10 })
  })
})
