/**
 * Real FFmpeg audio integration tests (DV-003C). Run with
 * `yarn test:integration` on a machine with FFmpeg/FFprobe. Nothing is mocked:
 * real uploads through the audio inspector, server-built projects, the queue,
 * the video encode, the audio mix/mux, FFprobe verification, and then the
 * actual samples of each output are measured with FFmpeg's analysis filters.
 *
 * Test audio is generated here (sine tones), so there are no rights issues.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { FfmpegCapabilityReport } from "@/lib/video/capabilities"
import type { AudioConfig, AudioRole, ProductInfo } from "@/lib/video/types"
import {
  createRunner,
  spawnTool,
  type Spawner,
} from "@/server/process/run-executable"
import { detectFfmpegCapabilities } from "@/server/video/ffmpeg-capabilities"
import { fontDirectory, loadVideoFont } from "@/server/video/font-metrics"
import { buildTrustedProject } from "@/server/video/project"
import { RenderQueue } from "@/server/video/render-queue"
import { renderVideo } from "@/server/video/render-service"
import {
  createVideoStorage,
  StorageError,
  type VideoStorage,
} from "@/server/video/storage"
import {
  createAudioInspector,
  createUploadVerifier,
} from "@/server/video/upload-verify"

const commands = { ffmpeg: "ffmpeg", ffprobe: "ffprobe" }
const fonts = { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") }
const product: ProductInfo = {
  name: "Trailblazer travel mug",
  headline: "Hot coffee for 12 hours",
  benefits: ["Leak-proof lid for your bag"],
  callToAction: "Tap the link to shop",
  disclosure: "#ad · I may earn a commission if you buy through my link.",
}

let base: string
let media: string
let capabilities: FfmpegCapabilityReport

function ffmpeg(args: string[]) {
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args], {
    stdio: "ignore",
  })
}

/** stderr of an analysis run (astats / ebur128 / silencedetect print there). */
function analyse(args: string[]) {
  return spawnSync(
    "ffmpeg",
    ["-nostdin", "-hide_banner", ...args, "-f", "null", "-"],
    {
      encoding: "utf8",
    },
  ).stderr
}

/** RMS level (dBFS) of the output's audio between `start` and `start+duration`. */
function rms(file: string, start: number, duration: number, band?: string) {
  const out = analyse([
    "-ss",
    String(start),
    "-t",
    String(duration),
    "-i",
    file,
    "-map",
    "0:a",
    "-af",
    `${band ? `${band},` : ""}astats=measure_overall=RMS_level:measure_perchannel=none`,
  ])
  const values = [...out.matchAll(/RMS level dB: (-?[\d.]+|-inf)/g)].map(
    (m) => m[1],
  )
  const last = values.at(-1)
  return last === undefined || last === "-inf" ? -Infinity : Number(last)
}

/** Integrated loudness (LUFS) and true peak of a segment, via ebur128. */
function loudness(file: string, start = 0, duration?: number) {
  const out = analyse([
    "-ss",
    String(start),
    ...(duration ? ["-t", String(duration)] : []),
    "-i",
    file,
    "-map",
    "0:a",
    "-af",
    "ebur128=peak=true",
  ])
  const summary = out.slice(out.lastIndexOf("Summary:"))
  return {
    integrated: Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]),
    truePeak: Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]),
  }
}

function probe(file: string) {
  return JSON.parse(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name,profile,sample_rate,channels,duration,nb_frames,width,height,avg_frame_rate:format=duration",
      "-of",
      "json",
      file,
    ]).toString(),
  ) as {
    streams: Record<string, string | number>[]
    format: { duration: string }
  }
}

async function upload(
  storage: VideoStorage,
  jobId: string,
  file: string,
  role: AudioRole,
  type: string,
) {
  return storage.addAudioAsset(
    jobId,
    {
      bytes: await fs.readFile(file),
      declaredType: type,
      fileName: path.basename(file),
      role,
    },
    {
      inspect: createAudioInspector(
        createRunner({ timeoutMs: 30_000 }),
        commands,
      ),
    },
  )
}

/** Renders a 15 s video (hook + 1 benefit + CTA) with the given audio choices. */
async function render(
  name: string,
  audio: (
    storage: VideoStorage,
    jobId: string,
  ) => Promise<AudioConfig | undefined>,
) {
  const storage = createVideoStorage(path.join(base, name))
  const job = await storage.createJob()
  const verify = createUploadVerifier(
    createRunner({ timeoutMs: 15_000 }),
    commands,
  )
  const assetIds = []
  for (const [i, source] of [
    "testsrc2",
    "mandelbrot",
    "smptehdbars",
  ].entries()) {
    const file = path.join(media, `${name}-${i}.png`)
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `${source}=s=1080x1080`,
      "-frames:v",
      "1",
      file,
    ])
    const asset = await storage.addImageAsset(
      job.id,
      {
        bytes: await fs.readFile(file),
        declaredType: "image/png",
        fileName: `${i}.png`,
      },
      { verify },
    )
    assetIds.push(asset.id)
  }
  const audioConfig = await audio(storage, job.id)
  const project = buildTrustedProject(
    await storage.readJob(job.id),
    { product, assetIds, ...(audioConfig ? { audio: audioConfig } : {}) },
    fonts,
  )
  if (!project.ok) throw new Error(JSON.stringify(project.issues))
  await storage.writeProject(job.id, project.value)

  const calls: string[][] = []
  const recordingSpawn: Spawner = (command, args, options) => {
    calls.push([...args])
    return spawnTool(command, args, options)
  }
  const phases: string[] = []
  const queue = new RenderQueue(storage, (jobId, onProgress) =>
    renderVideo(
      jobId,
      {
        storage,
        spawn: recordingSpawn,
        run: createRunner({ timeoutMs: 60_000 }),
        getCapabilities: async () => capabilities,
        commands,
        fonts,
        fontDir: fontDirectory(),
        threads: 4,
        timeouts: {
          sceneMs: 60_000,
          encodeMs: 5 * 60_000,
          audioMs: 2 * 60_000,
        },
        log: (message) => console.error(message),
      },
      (progress) => {
        if (phases.at(-1) !== progress.phase) phases.push(progress.phase)
        onProgress(progress)
      },
    ),
  )
  const started = Date.now()
  await queue.enqueue(job.id)
  await queue.whenIdle()
  const seconds = (Date.now() - started) / 1000
  const done = await storage.readJob(job.id)
  const output = await storage.resolveCompletedOutput(job.id)
  return {
    done,
    output,
    calls,
    phases,
    seconds,
    frames: project.value.scenes.reduce((n, s) => n + s.durationFrames, 0),
  }
}

const H264_ENCODES = (calls: string[][]) =>
  calls.filter((a) => a.includes("-c:v") && a[a.indexOf("-c:v") + 1] !== "copy")

/**
 * Every frame is encoded exactly once (DV-003D2: one segment per scene,
 * joined with -c copy); the audio stage never re-encodes the picture.
 */
const FRAMES_ENCODED = (calls: string[][]) =>
  H264_ENCODES(calls).reduce(
    (n, a) => n + Number(a[a.indexOf("-frames:v") + 1]),
    0,
  )

beforeAll(async () => {
  capabilities = await detectFfmpegCapabilities({
    run: createRunner({ timeoutMs: 30_000 }),
  })
  if (capabilities.status !== "ready" || !capabilities.audio.ready)
    throw new Error(
      `FFmpeg/audio isn't ready: ${capabilities.issues.map((i) => i.message).join(" ")}`,
    )
  base = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-audio-"))
  media = path.join(base, "media")
  await fs.mkdir(media)
  // "Voiceover": 2 s of silence, then a 300 Hz tone with pauses until 8 s (mono, 44.1 kHz WAV).
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=if(between(t\\,2\\,8)*gt(sin(2*PI*t*0.7)\\,-0.6)\\,0.3*sin(2*PI*300*t)\\,0):s=44100:d=9",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    path.join(media, "voice.wav"),
  ])
  // "Music": 3 s of 1 kHz (stereo, 44.1 kHz MP3), so it has to loop.
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=0.5*sin(2*PI*1000*t)|0.5*sin(2*PI*1000*t):s=44100:d=3",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "192k",
    path.join(media, "music.mp3"),
  ])
  // The same music as M4A (AAC), to cover that container.
  ffmpeg([
    "-i",
    path.join(media, "music.mp3"),
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    path.join(media, "music.m4a"),
  ])
  // Too-long narration: 20 s against a 15 s video.
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=300:sample_rate=48000:duration=20",
    "-c:a",
    "pcm_s16le",
    path.join(media, "long.wav"),
  ])
})

afterAll(async () => {
  if (base) await fs.rm(base, { recursive: true, force: true })
})

describe("real FFmpeg audio rendering", () => {
  it("detects AAC with a real test encode and the audio filters", () => {
    expect(capabilities.aacEncoder).toBe("aac")
    expect(capabilities.audio).toEqual({
      ready: true,
      missingFilters: [],
      reason: null,
    })
  })

  it("1. renders a silent video exactly as before (no audio stream, no audio stage)", async () => {
    const result = await render("silent", async () => undefined)
    expect(result.done.state).toBe("completed")
    expect(result.done.output?.audio).toBeNull()
    const p = probe(result.output!.path)
    expect(p.streams.map((s) => s.codec_type)).toEqual(["video"])
    expect(result.phases).not.toContain("audio")
    expect(FRAMES_ENCODED(result.calls)).toBe(result.frames)
    console.info(
      `[audio] silent: ${result.seconds.toFixed(1)} s render, ${result.done.output!.sizeBytes} bytes`,
    )
  })

  it("2. voiceover only: synchronized, normalized, padded with silence, exact length", async () => {
    const result = await render("voiceover", async (storage, jobId) => {
      const voice = await upload(
        storage,
        jobId,
        path.join(media, "voice.wav"),
        "voiceover",
        "audio/wav",
      )
      expect(voice).toMatchObject({
        container: "wav",
        codec: "pcm_s16le",
        channels: 1,
        sampleRate: 44100,
      })
      return {
        mode: "voiceover",
        voiceoverAssetId: voice.id,
        musicAssetId: null,
        musicLevel: "low",
      }
    })
    expect(result.done.error).toBeNull()
    const file = result.output!.path
    const p = probe(file)
    const audio = p.streams.find((s) => s.codec_type === "audio")!
    expect(p.streams.filter((s) => s.codec_type === "audio")).toHaveLength(1)
    expect(audio).toMatchObject({
      codec_name: "aac",
      profile: "LC",
      sample_rate: "48000",
      channels: 2,
    })
    const video = p.streams.find((s) => s.codec_type === "video")!
    expect(Number(video.nb_frames)).toBe(result.frames)
    expect(Math.abs(Number(audio.duration) - result.frames / 30)).toBeLessThan(
      0.05,
    )
    expect(Number(p.format.duration)).toBeCloseTo(result.frames / 30, 1)

    // Encoded once; the audio stage copies the H.264 stream.
    expect(FRAMES_ENCODED(result.calls)).toBe(result.frames)
    const mux = result.calls.find((a) => a.includes("[aout]"))!
    expect(mux[mux.indexOf("-c:v") + 1]).toBe("copy")
    expect(result.phases).toEqual([
      "preparing",
      "composing",
      "encoding",
      "verifying",
      "audio",
      "verifying",
    ])

    // Synchronization: the narration starts at 2.00 s in the output.
    const onset = /silence_end: ([\d.]+)/.exec(
      analyse([
        "-i",
        file,
        "-map",
        "0:a",
        "-af",
        "bandpass=f=300:w=60,silencedetect=n=-45dB:d=0.5",
      ]),
    )
    expect(Number(onset?.[1])).toBeGreaterThan(1.95)
    expect(Number(onset?.[1])).toBeLessThan(2.06)
    // Speech is present, silence after the narration ends (padding), no clipping.
    expect(rms(file, 3, 4, "bandpass=f=300:w=60")).toBeGreaterThan(-30)
    expect(rms(file, 9.5, 4)).toBeLessThan(-70)
    const speech = loudness(file, 2, 6)
    expect(Math.abs(speech.integrated - -16)).toBeLessThan(2)
    expect(speech.truePeak).toBeLessThan(-0.5)
    console.info(
      `[audio] voiceover: speech ${speech.integrated} LUFS, peak ${speech.truePeak} dBFS, onset ${onset?.[1]} s, AAC ${audio.bit_rate ?? "?"} b/s, ${result.seconds.toFixed(1)} s render`,
    )
  })

  it("3. music only: loops a short track, fades out, controlled loudness", async () => {
    const result = await render("music", async (storage, jobId) => {
      const music = await upload(
        storage,
        jobId,
        path.join(media, "music.mp3"),
        "music",
        "audio/mpeg",
      )
      expect(music).toMatchObject({
        container: "mp3",
        codec: "mp3",
        channels: 2,
      })
      return {
        mode: "music",
        voiceoverAssetId: null,
        musicAssetId: music.id,
        musicLevel: "low",
      }
    })
    expect(result.done.error).toBeNull()
    const file = result.output!.path
    const total = result.frames / 30
    // The 3 s track keeps playing after it would have ended (looped).
    const early = rms(file, 1, 1.5, "bandpass=f=1000:w=100")
    const looped = rms(file, 10, 2, "bandpass=f=1000:w=100")
    expect(looped).toBeGreaterThan(-35)
    expect(Math.abs(looped - early)).toBeLessThan(1.5)
    // Fade-out over the last 1.5 s; the final moment is far quieter.
    expect(rms(file, total - 0.15, 0.15)).toBeLessThan(early - 20)
    const whole = loudness(file)
    expect(Math.abs(whole.integrated - -16)).toBeLessThan(2)
    expect(whole.truePeak).toBeLessThan(-0.5)
    expect(
      Math.abs(
        Number(
          probe(file).streams.find((s) => s.codec_type === "audio")!.duration,
        ) - total,
      ),
    ).toBeLessThan(0.05)
    console.info(
      `[audio] music: ${whole.integrated} LUFS, peak ${whole.truePeak} dBFS, loop level drift ${(looped - early).toFixed(2)} dB, ${result.seconds.toFixed(1)} s render`,
    )
  })

  it("4. voiceover + music: speech stays clearly above the ducked music", async () => {
    const result = await render("mixed", async (storage, jobId) => {
      const voice = await upload(
        storage,
        jobId,
        path.join(media, "voice.wav"),
        "voiceover",
        "audio/wav",
      )
      const music = await upload(
        storage,
        jobId,
        path.join(media, "music.m4a"),
        "music",
        "audio/mp4",
      )
      expect(music).toMatchObject({ container: "m4a", codec: "aac" })
      return {
        mode: "voiceover-and-music",
        voiceoverAssetId: voice.id,
        musicAssetId: music.id,
        musicLevel: "low",
      }
    })
    expect(result.done.error).toBeNull()
    const file = result.output!.path
    const p = probe(file)
    expect(p.streams.filter((s) => s.codec_type === "audio")).toHaveLength(1)
    const voiceBand = rms(file, 3, 4, "bandpass=f=300:w=60")
    const musicUnderSpeech = rms(file, 3, 4, "bandpass=f=1000:w=100")
    const musicAlone = rms(file, 0.2, 1.6, "bandpass=f=1000:w=100")
    // Intelligibility: speech at least 15 dB above the music while talking.
    expect(voiceBand - musicUnderSpeech).toBeGreaterThan(15)
    // Ducking: music drops while the narrator speaks.
    expect(musicAlone - musicUnderSpeech).toBeGreaterThan(4)
    // Music comes back after the narration and still fades out at the end.
    expect(rms(file, 10, 2, "bandpass=f=1000:w=100")).toBeGreaterThan(
      musicUnderSpeech + 3,
    )
    expect(rms(file, result.frames / 30 - 0.15, 0.15)).toBeLessThan(
      musicAlone - 15,
    )
    expect(loudness(file).truePeak).toBeLessThan(-0.5)
    expect(FRAMES_ENCODED(result.calls)).toBe(result.frames)
    console.info(
      `[audio] mixed: voice band ${voiceBand.toFixed(1)} dB, music under speech ${musicUnderSpeech.toFixed(1)} dB, music alone ${musicAlone.toFixed(1)} dB, ${result.seconds.toFixed(1)} s render`,
    )
  })

  it("rejects narration longer than the video instead of cutting it off", async () => {
    const storage = createVideoStorage(path.join(base, "long"))
    const job = await storage.createJob()
    const voice = await upload(
      storage,
      job.id,
      path.join(media, "long.wav"),
      "voiceover",
      "audio/wav",
    )
    expect(voice.durationSeconds).toBeCloseTo(20, 1)
    const result = buildTrustedProject(
      { ...(await storage.readJob(job.id)), assets: [] },
      {
        product,
        assetIds: [],
        audio: {
          mode: "voiceover",
          voiceoverAssetId: voice.id,
          musicAssetId: null,
          musicLevel: "low",
        },
      },
      fonts,
    )
    expect(result.ok).toBe(false)
  })

  it("rejects corrupt, disguised and unsupported audio files", async () => {
    const storage = createVideoStorage(path.join(base, "invalid"))
    const job = await storage.createJob()
    const good = await fs.readFile(path.join(media, "music.mp3"))
    const cases: [string, () => Promise<string>, string, RegExp][] = [
      [
        "corrupt.mp3",
        async () => {
          const file = path.join(media, "corrupt.mp3")
          const bytes = Buffer.from(good)
          for (let i = 2000; i < bytes.length; i += 7)
            bytes[i] = (bytes[i] * 31 + 7) & 0xff
          await fs.writeFile(file, bytes)
          return file
        },
        "audio/mpeg",
        /decode cleanly|couldn't be used/,
      ],
      [
        // One ordinary cover is accepted since DV-003D3
        // (audio-timing.integration.test.ts); two pictures still aren't.
        "two-covers.mp3",
        async () => {
          const file = path.join(media, "two-covers.mp3")
          const art = path.join(media, "art.png")
          ffmpeg([
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=64x64",
            "-frames:v",
            "1",
            art,
          ])
          ffmpeg([
            "-i",
            path.join(media, "music.mp3"),
            "-i",
            art,
            "-i",
            art,
            "-map",
            "0:a",
            "-map",
            "1:v",
            "-map",
            "2:v",
            "-c",
            "copy",
            "-id3v2_version",
            "3",
            "-disposition:v",
            "attached_pic",
            file,
          ])
          return file
        },
        "audio/mpeg",
        /more than one embedded picture/,
      ],
      [
        "video.m4a",
        async () => {
          const file = path.join(media, "video.m4a")
          ffmpeg([
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=320x240:d=2",
            "-f",
            "lavfi",
            "-i",
            "sine=d=2",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-f",
            "mp4",
            "-brand",
            "M4A ",
            file,
          ])
          return file
        },
        "audio/mp4",
        /contains video/,
      ],
      [
        "surround.wav",
        async () => {
          const file = path.join(media, "surround.wav")
          ffmpeg([
            "-f",
            "lavfi",
            "-i",
            "sine=d=2",
            "-ac",
            "6",
            "-c:a",
            "pcm_s16le",
            file,
          ])
          return file
        },
        "audio/wav",
        /6 channels/,
      ],
      [
        "slow.wav",
        async () => {
          const file = path.join(media, "slow.wav")
          ffmpeg([
            "-f",
            "lavfi",
            "-i",
            "sine=d=2:sample_rate=6000",
            "-c:a",
            "pcm_s16le",
            file,
          ])
          return file
        },
        "audio/wav",
        /sample rate/,
      ],
    ]
    for (const [name, make, type, message] of cases) {
      const file = await make()
      await expect(
        upload(storage, job.id, file, "music", type),
        name,
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof StorageError && message.test(error.message),
      )
    }
    expect((await storage.readJob(job.id)).audioAssets).toEqual([])
  })
})
