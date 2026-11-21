import { execFileSync, spawnSync } from "node:child_process"
import { writeFile } from "node:fs/promises"

import type { APIRequestContext, Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import {
  fillValidStoryboard,
  makePngNode,
  makeWavNode,
  openStudio,
  READY_REPORT,
  SILENT_ONLY_REPORT,
  STUDIO_PATH,
} from "./pixel-studio-helpers"

/** DV-003C: voiceover and background music in Pixel Studio. */

const audioMode = (page: Page, name: string) =>
  page.getByRole("radio", { name: new RegExp(`^${name}`) })
const requirements = (page: Page) =>
  page.getByRole("list", { name: "Render requirements" })

async function chooseAudio(
  page: Page,
  label: string,
  name: string,
  buffer: Buffer,
  mimeType = "audio/wav",
) {
  await page
    .getByLabel(label, { exact: true })
    .setInputFiles({ name, mimeType, buffer })
}

test.describe("Pixel Studio audio (FFmpeg mocked)", () => {
  test("defaults to no audio and keeps the silent flow unchanged", async ({
    page,
  }) => {
    await openStudio(page, READY_REPORT)
    await expect(audioMode(page, "No audio")).toBeChecked()
    await expect(page.getByTestId("audio-summary")).toHaveText(
      "Audio: No audio (silent video).",
    )
    await expect(page.getByText("None (silent)")).toBeVisible()
    await expect(
      page.getByLabel("Voiceover file", { exact: true }),
    ).toHaveCount(0)
    await fillValidStoryboard(page)
    await expect(requirements(page).getByText(/Audio files ready/)).toHaveCount(
      0,
    )
    await expect(page.getByRole("button", { name: "Render MP4" })).toBeEnabled()
  })

  test("requires, validates, previews and removes the chosen audio files", async ({
    page,
  }) => {
    await openStudio(page, READY_REPORT)
    await fillValidStoryboard(page)
    await audioMode(page, "Voiceover").first().check()
    const render = page.getByRole("button", { name: "Render MP4" })
    await expect(
      requirements(page).getByText("Audio files ready: not yet"),
    ).toBeAttached()
    await expect(render).toBeDisabled()
    await expect(
      page.getByText("AAC-LC, 48 kHz stereo, 192 kb/s target").first(),
    ).toBeVisible()

    // Unsupported type: refused in the browser.
    await chooseAudio(
      page,
      "Voiceover file",
      "song.ogg",
      Buffer.from("OggS"),
      "audio/ogg",
    )
    await expect(
      page.getByRole("alert").filter({ hasText: "song.ogg" }),
    ).toContainText("isn't a supported audio file")

    // Narration longer than the 15 s video: refused, not cut off (trim it
    // to fit; see e2e/pixel-audio-timing.spec.ts).
    await chooseAudio(page, "Voiceover file", "long.wav", makeWavNode(20))
    await expect(
      page
        .getByText(
          /narration would play from 0 s to 20 s, but the video is 15 s/,
        )
        .first(),
    ).toBeVisible()
    await expect(render).toBeDisabled()

    // A fitting voiceover: name, duration and a native preview player.
    await chooseAudio(page, "Voiceover file", "voice.wav", makeWavNode(6))
    await expect(page.getByText("voice.wav")).toBeVisible()
    await expect(page.getByText(/6\.0 s ·/)).toBeVisible()
    await expect(page.getByLabel("Preview voiceover file")).toBeVisible()
    await expect(
      requirements(page).getByText("Audio files ready: done"),
    ).toBeAttached()
    await expect(render).toBeEnabled()
    await expect(
      page.getByText(/Use only audio you have the rights to/),
    ).toBeVisible()

    await page.getByRole("button", { name: "Remove voiceover file" }).click()
    await expect(page.getByLabel("Preview voiceover file")).toHaveCount(0)
    await expect(render).toBeDisabled()
  })

  test("offers the music level only when narration and music play together", async ({
    page,
  }) => {
    await openStudio(page, READY_REPORT)
    await audioMode(page, "Background music").check()
    await expect(
      page.getByLabel("Background music file", { exact: true }),
    ).toBeAttached()
    await expect(
      page.getByLabel("Voiceover file", { exact: true }),
    ).toHaveCount(0)
    await expect(
      page.getByRole("radio", { name: "Low (recommended)" }),
    ).toHaveCount(0)
    await audioMode(page, "Voiceover \\+ music").check()
    await expect(
      page.getByRole("radio", { name: "Low (recommended)" }),
    ).toBeChecked()
    await page.getByRole("radio", { name: "Medium" }).check()
    await expect(page.getByTestId("audio-summary")).toContainText(
      "music medium",
    )
  })

  test("disables audio with the reason when FFmpeg can't encode AAC, keeping silent renders", async ({
    page,
  }) => {
    await openStudio(page, SILENT_ONLY_REPORT)
    await expect(
      page.getByText(/AAC encoder \(aac\) failed a test encode/).first(),
    ).toBeVisible()
    for (const name of ["Voiceover", "Background music", "Voiceover \\+ music"])
      await expect(audioMode(page, name).first()).toBeDisabled()
    await fillValidStoryboard(page)
    await expect(page.getByRole("button", { name: "Render MP4" })).toBeEnabled()
  })

  test("uploads the original audio and sends only IDs and a level to the server", async ({
    page,
  }) => {
    await openStudio(page, READY_REPORT)
    const jobId = `job_${"b".repeat(32)}`
    const audioUploads: { role: string | null; type: string }[] = []
    let renderBody: Record<string, unknown> | null = null
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
    await page.route(`**/api/studio/pixel/jobs/${jobId}/audio?**`, (route) => {
      const url = new URL(route.request().url())
      audioUploads.push({
        role: url.searchParams.get("role"),
        type: route.request().headers()["content-type"],
      })
      const role = url.searchParams.get("role")!
      return route.fulfill({
        status: 201,
        json: {
          audio: {
            id: `asset_${(role === "voiceover" ? "c" : "d").repeat(32)}`,
            role,
            displayName: "x",
            container: "wav",
            sizeBytes: 1,
            durationSeconds: 6,
            sampleRate: 44100,
            channels: 1,
          },
        },
      })
    })
    await page.route(`**/api/studio/pixel/jobs/${jobId}/render`, (route) => {
      renderBody = route.request().postDataJSON()
      return route.fulfill({
        status: 202,
        json: {
          jobId,
          state: "queued",
          progress: { phase: "waiting", position: 1 },
          error: null,
          output: null,
          videoUrl: null,
          downloadUrl: null,
        },
      })
    })
    await page.route(`**/api/studio/pixel/jobs/${jobId}`, (route) =>
      route.fulfill({
        json: {
          jobId,
          state: "rendering",
          progress: { phase: "audio", step: "mixing", fraction: 0.4 },
          error: null,
          output: null,
          videoUrl: null,
          downloadUrl: null,
        },
      }),
    )

    await fillValidStoryboard(page)
    await audioMode(page, "Voiceover \\+ music").check()
    await chooseAudio(page, "Voiceover file", "voice.wav", makeWavNode(6))
    await chooseAudio(
      page,
      "Background music file",
      "music.wav",
      makeWavNode(3, { frequency: 1000, channels: 2 }),
    )
    await page.getByRole("radio", { name: "High" }).check()
    await page.getByRole("button", { name: "Render MP4" }).click()

    await expect(
      page.getByText(/Mixing audio \(the video stream is copied/),
    ).toBeVisible()
    await expect(
      page.getByRole("progressbar", { name: "Render progress" }),
    ).toHaveAttribute("aria-valuenow", "40")
    expect(audioUploads).toEqual([
      { role: "voiceover", type: "audio/wav" },
      { role: "music", type: "audio/wav" },
    ])
    expect(renderBody).not.toBeNull()
    expect(Object.keys(renderBody!).sort()).toEqual([
      "assetIds",
      "audio",
      "effects",
      "product",
    ])
    expect(renderBody!.audio).toEqual({
      mode: "voiceover-and-music",
      voiceoverAssetId: `asset_${"c".repeat(32)}`,
      musicAssetId: `asset_${"d".repeat(32)}`,
      musicLevel: "high",
      // DV-003D3: the whole recording from 0:00 unless trimmed or offset.
      voiceoverTiming: { trimStartMs: 0, trimEndMs: null, offsetMs: 0 },
    })
  })
})

// ---------------------------------------------------------------------------
// Real FFmpeg (skipped, with the reason, where FFmpeg audio isn't available)
// ---------------------------------------------------------------------------

async function audioReady(request: APIRequestContext) {
  const response = await request.get("/api/studio/pixel/capabilities")
  if (!response.ok()) return false
  const report = await response.json()
  return report.status === "ready" && report.audio?.ready === true
}

test.describe("real audio rendering", () => {
  test.describe.configure({ timeout: 240_000 })

  test("renders voiceover + music through the UI, previews and downloads one AAC track", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      !(await audioReady(request)),
      "FFmpeg audio isn't available on this machine",
    )
    // Music as a real MP3 (made by the local FFmpeg); voiceover as WAV.
    const musicWav = testInfo.outputPath("music.wav")
    const musicMp3 = testInfo.outputPath("music.mp3")
    await writeFile(musicWav, makeWavNode(3, { frequency: 1000, channels: 2 }))
    execFileSync("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-y",
      "-i",
      musicWav,
      "-c:a",
      "libmp3lame",
      "-b:a",
      "192k",
      musicMp3,
    ])

    await page.goto(STUDIO_PATH)
    await expect(page.getByText("Ready", { exact: true })).toBeVisible()
    await fillValidStoryboard(page)
    await audioMode(page, "Voiceover \\+ music").check()
    await chooseAudio(
      page,
      "Voiceover file",
      "voice.wav",
      makeWavNode(8, { silenceBefore: 2 }),
    )
    await page
      .getByLabel("Background music file", { exact: true })
      .setInputFiles(musicMp3)
    await expect(page.getByLabel("Preview background music file")).toBeVisible()
    await page.getByRole("button", { name: "Render MP4" }).click()

    await expect(
      page.getByText("Video ready and verified by FFprobe."),
    ).toBeVisible({ timeout: 180_000 })
    await expect(page.getByText(/AAC-LC, 48 kHz, stereo/)).toBeVisible()

    const downloadPromise = page.waitForEvent("download")
    await page.getByRole("link", { name: "Download MP4" }).click()
    const file = testInfo.outputPath("with-audio.mp4")
    await (await downloadPromise).saveAs(file)
    const probe = JSON.parse(
      execFileSync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,profile,sample_rate,channels,width,height,duration:format=duration",
        "-of",
        "json",
        file,
      ]).toString(),
    )
    expect(
      probe.streams.map((s: { codec_type: string }) => s.codec_type),
    ).toEqual(["video", "audio"])
    const audio = probe.streams[1]
    expect(audio).toMatchObject({
      codec_name: "aac",
      profile: "LC",
      sample_rate: "48000",
      channels: 2,
    })
    expect(
      Math.abs(Number(audio.duration) - Number(probe.streams[0].duration)),
    ).toBeLessThan(0.1)
    // Real audio, decodable from start to end and not silent.
    // volumedetect reports on stderr.
    const stats = spawnSync(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-i",
        file,
        "-map",
        "0:a",
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ],
      { encoding: "utf8" },
    ).stderr
    const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(stats)?.[1])
    expect(mean).toBeGreaterThan(-45)
  })

  test("rejects invalid audio uploads and cross-job audio", async ({
    request,
  }) => {
    test.skip(
      !(await audioReady(request)),
      "FFmpeg audio isn't available on this machine",
    )
    const newJob = async () =>
      (
        (await (await request.post("/api/studio/pixel/jobs")).json()) as {
          jobId: string
        }
      ).jobId
    const job = await newJob()
    const audio = (role: string, data: Buffer, type = "audio/wav") =>
      request.post(`/api/studio/pixel/jobs/${job}/audio?role=${role}`, {
        headers: { "content-type": type, "x-file-name": "clip.wav" },
        data,
      })

    expect((await audio("narrator", makeWavNode(2))).status()).toBe(400)
    expect((await audio("music", makeWavNode(2), "video/mp4")).status()).toBe(
      415,
    )
    expect((await audio("music", makePngNode(400, 400))).status()).toBe(422)
    const surround = await audio("music", makeWavNode(2, { channels: 6 }))
    expect(surround.status()).toBe(422)
    expect((await surround.json()).message).toMatch(/6 channels/)
    // Recordings may exceed the video (a trimmed part is used) up to 5 min.
    const tooLong = await audio(
      "voiceover",
      makeWavNode(301, { sampleRate: 8000 }),
    )
    expect(tooLong.status()).toBe(422)
    expect((await tooLong.json()).message).toMatch(/at most 5 minutes/)
    const damaged = makeWavNode(2)
    damaged.writeUInt16LE(0x7777, 20) // unknown WAV codec tag
    expect((await audio("music", damaged)).status()).toBe(422)

    // An image upload is needed for a valid render request.
    const images: string[] = []
    for (const color of [
      [200, 60, 60],
      [60, 200, 60],
      [60, 60, 200],
    ]) {
      const response = await request.post(
        `/api/studio/pixel/jobs/${job}/assets`,
        {
          headers: { "content-type": "image/png" },
          data: makePngNode(400, 600, color),
        },
      )
      const body = await response.json()
      expect(response.status(), JSON.stringify(body)).toBe(201)
      images.push(body.asset.id)
    }
    const other = await newJob()
    const foreign = await request.post(
      `/api/studio/pixel/jobs/${other}/audio?role=voiceover`,
      { headers: { "content-type": "audio/wav" }, data: makeWavNode(3) },
    )
    expect(foreign.status()).toBe(201)
    const foreignId = (await foreign.json()).audio.id
    const product = {
      name: "Trailblazer travel mug",
      headline: "Hot coffee for 12 hours",
      benefits: ["Leak-proof lid"],
      callToAction: "Tap the link to shop",
      disclosure: "#ad · I may earn a commission.",
    }
    const render = await request.post(`/api/studio/pixel/jobs/${job}/render`, {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({
        product,
        assetIds: images,
        audio: {
          mode: "voiceover",
          voiceoverAssetId: foreignId,
          musicAssetId: null,
          musicLevel: "low",
        },
      }),
    })
    expect(render.status()).toBe(422)
    expect((await render.json()).message).toMatch(
      /wasn't uploaded to this video/,
    )
    const injected = await request.post(
      `/api/studio/pixel/jobs/${job}/render`,
      {
        headers: { "content-type": "application/json" },
        data: JSON.stringify({
          product,
          assetIds: images,
          audio: {
            mode: "none",
            voiceoverAssetId: null,
            musicAssetId: null,
            musicLevel: "low",
            filter: "volume=40",
          },
        }),
      },
    )
    expect(injected.status()).toBe(422)
  })
})
