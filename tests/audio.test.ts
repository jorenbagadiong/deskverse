import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { POST as uploadAudio } from "@/app/api/studio/pixel/jobs/[jobId]/audio/route"
import type { FfmpegCapabilityReport } from "@/lib/video/capabilities"
import { createAssetId, createRenderJobId, type AssetId } from "@/lib/video/ids"
import { buildStoryboard } from "@/lib/video/storyboard"
import type {
  AudioAsset,
  AudioConfig,
  ProductInfo,
  VideoProject,
} from "@/lib/video/types"
import {
  AUDIO_LIMITS,
  checkAudioFacts,
  DEFAULT_VIDEO_SETTINGS,
  validateAudioConfig,
  validateAudioFile,
  validateVideoProject,
  validateVoiceoverFits,
  VOICEOVER_TOLERANCE_SECONDS,
} from "@/lib/video/validation"
import type {
  Runner,
  SpawnOptions,
  Spawner,
} from "@/server/process/run-executable"
import {
  aacEncoderOptions,
  buildAudioPlan,
  LOUDNESS,
  loudnessMeasureArgs,
  loudnessTarget,
  musicLoopSamples,
  parseLoudnormJson,
  testAacEncodeArgs,
  type AudioSource,
  type LoudnessMeasurement,
} from "@/server/video/audio-command"
import { sniffAudioContainer } from "@/server/video/audio-sniff"
import {
  audioProbeArgs,
  parseAudioProbe,
  verifyOutputProbe,
} from "@/server/video/ffprobe"
import { fontDirectory, loadVideoFont } from "@/server/video/font-metrics"
import { buildTrustedProject } from "@/server/video/project"
import { renderVideo, type RenderDeps } from "@/server/video/render-service"
import {
  createVideoStorage,
  StorageError,
  type AudioFacts,
  type VideoStorage,
} from "@/server/video/storage"
import { testLease } from "./support/test-lease"

/** A real render-gate lease (DV-005C): renderVideo requires one. */
const lease = await testLease()

const fonts = { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") }
const product: ProductInfo = {
  name: "Trailblazer travel mug",
  headline: "Hot coffee for 12 hours",
  benefits: ["Leak-proof lid"],
  callToAction: "Tap the link to shop",
  disclosure: "#ad · I may earn a commission.",
}

const audioAsset = (overrides: Partial<AudioAsset> = {}): AudioAsset => ({
  id: createAssetId(),
  kind: "audio",
  role: "voiceover",
  container: "wav",
  codec: "pcm_s16le",
  sizeBytes: 1000,
  durationSeconds: 9,
  sampleRate: 44100,
  channels: 1,
  displayName: "voice.wav",
  ...overrides,
})

const config = (overrides: Partial<AudioConfig> = {}): AudioConfig => ({
  mode: "none",
  voiceoverAssetId: null,
  musicAssetId: null,
  musicLevel: "low",
  ...overrides,
})

// Minimal byte signatures.
const wavBytes = () => {
  const b = new Uint8Array(44)
  b.set(new TextEncoder().encode("RIFF"), 0)
  b.set(new TextEncoder().encode("WAVEfmt "), 8)
  return b
}
const m4aBytes = (brand = "M4A ") => {
  const b = new Uint8Array(32)
  b.set([0, 0, 0, 0x20], 0)
  b.set(new TextEncoder().encode(`ftyp${brand}`), 4)
  return b
}
const mp3FrameBytes = () =>
  new Uint8Array([0xff, 0xfb, 0x90, 0x64, ...new Array(60).fill(0)])
const id3Bytes = () => {
  const b = new Uint8Array(10 + 20 + 8)
  b.set(new TextEncoder().encode("ID3"), 0)
  b.set([3, 0, 0, 0, 0, 0, 20], 3) // v2.3, size 20 (syncsafe)
  b.set([0xff, 0xfb, 0x90, 0x64], 30)
  return b
}

// ---------------------------------------------------------------------------

describe("audio mode validation", () => {
  const voice = audioAsset({ role: "voiceover" })
  const music = audioAsset({
    role: "music",
    container: "mp3",
    codec: "mp3",
    channels: 2,
    durationSeconds: 180,
  })
  const assets = [voice, music]

  it("requires exactly the files each mode needs", () => {
    expect(validateAudioConfig(config(), assets).ok).toBe(true)
    expect(
      validateAudioConfig(
        config({ mode: "voiceover", voiceoverAssetId: voice.id }),
        assets,
      ).ok,
    ).toBe(true)
    expect(
      validateAudioConfig(
        config({ mode: "music", musicAssetId: music.id }),
        assets,
      ).ok,
    ).toBe(true)
    expect(
      validateAudioConfig(
        config({
          mode: "voiceover-and-music",
          voiceoverAssetId: voice.id,
          musicAssetId: music.id,
          musicLevel: "high",
        }),
        assets,
      ).ok,
    ).toBe(true)
  })

  it("reports missing audio files", () => {
    const missingVoice = validateAudioConfig(
      config({ mode: "voiceover" }),
      assets,
    )
    expect(
      missingVoice.ok ? [] : missingVoice.issues.map((i) => i.message),
    ).toEqual(["Add a voiceover file."])
    const missingMusic = validateAudioConfig(
      config({ mode: "voiceover-and-music", voiceoverAssetId: voice.id }),
      assets,
    )
    expect(
      missingMusic.ok ? [] : missingMusic.issues.map((i) => i.path),
    ).toEqual(["audio.musicAssetId"])
  })

  it("rejects files the mode doesn't use, unknown modes and levels", () => {
    expect(
      validateAudioConfig(config({ voiceoverAssetId: voice.id }), assets).ok,
    ).toBe(false)
    expect(
      validateAudioConfig(
        config({
          mode: "music",
          musicAssetId: music.id,
          voiceoverAssetId: voice.id,
        }),
        assets,
      ).ok,
    ).toBe(false)
    expect(
      validateAudioConfig({ ...config(), mode: "karaoke" }, assets).ok,
    ).toBe(false)
    expect(
      validateAudioConfig({ ...config(), musicLevel: "max" }, assets).ok,
    ).toBe(false)
  })

  it("rejects audio from another job and files uploaded for the other role", () => {
    const foreign = validateAudioConfig(
      config({ mode: "voiceover", voiceoverAssetId: createAssetId() }),
      assets,
    )
    expect(foreign.ok ? "" : foreign.issues[0].message).toMatch(
      /wasn't uploaded to this video/,
    )
    const swapped = validateAudioConfig(
      config({ mode: "voiceover", voiceoverAssetId: music.id }),
      assets,
    )
    expect(swapped.ok ? "" : swapped.issues[0].message).toMatch(
      /uploaded as background music/,
    )
  })

  it("rejects FFmpeg options and filter graphs smuggled into the audio settings", () => {
    for (const extra of [
      { filter: "volume=10" },
      { ffmpegArgs: ["-af", "x"] },
      { gainDb: 20 },
    ]) {
      const result = validateAudioConfig({ ...config(), ...extra }, assets)
      expect(result.ok, JSON.stringify(extra)).toBe(false)
    }
  })
})

describe("audio file limits", () => {
  it("pre-checks name, type and size in the browser", () => {
    expect(
      validateAudioFile(
        { name: "voice.mp3", size: 1000, type: "audio/mpeg" },
        "voiceover",
      ).ok,
    ).toBe(true)
    expect(
      validateAudioFile(
        { name: "voice.m4a", size: 1000, type: "audio/x-m4a" },
        "voiceover",
      ).ok,
    ).toBe(true)
    expect(
      validateAudioFile(
        { name: "voice.wav", size: 1000, type: "" },
        "voiceover",
      ).ok,
    ).toBe(true)
    for (const [name, type] of [
      ["song.ogg", "audio/ogg"],
      ["song.flac", "audio/flac"],
      ["clip.mp4", "video/mp4"],
      ["voice.mp3", "text/html"],
      ["voice", "audio/mpeg"],
    ])
      expect(
        validateAudioFile({ name, size: 1000, type }, "music").ok,
        name,
      ).toBe(false)
    expect(
      validateAudioFile({ name: "a.wav", size: 0, type: "audio/wav" }, "music")
        .ok,
    ).toBe(false)
    const big = validateAudioFile(
      { name: "a.wav", size: AUDIO_LIMITS.maxBytes + 1, type: "audio/wav" },
      "music",
    )
    expect(big.ok ? "" : big.issues[0].message).toMatch(/30 MB or smaller/)
  })

  it("checks probed channels, sample rate and duration", () => {
    const ok = { durationSeconds: 10, sampleRate: 44100, channels: 2 }
    expect(checkAudioFacts(ok, "voiceover", "a")).toBeNull()
    expect(checkAudioFacts({ ...ok, channels: 6 }, "music", "a")).toMatch(
      /6 channels/,
    )
    expect(checkAudioFacts({ ...ok, sampleRate: 6000 }, "music", "a")).toMatch(
      /sample rate/,
    )
    expect(
      checkAudioFacts({ ...ok, durationSeconds: 0.2 }, "music", "a"),
    ).toMatch(/too short/)
    // DV-003D3: longer recordings are fine (a trimmed part is used), up to 5 min.
    expect(
      checkAudioFacts({ ...ok, durationSeconds: 31 }, "voiceover", "a"),
    ).toBeNull()
    expect(
      checkAudioFacts({ ...ok, durationSeconds: 301 }, "voiceover", "a"),
    ).toMatch(/at most 5 minutes/)
    expect(
      checkAudioFacts({ ...ok, durationSeconds: 31 }, "music", "a"),
    ).toBeNull()
    expect(
      checkAudioFacts({ ...ok, durationSeconds: 601 }, "music", "a"),
    ).toMatch(/10 minutes/)
  })

  it("rejects untimed (older) narration longer than the video beyond the tolerance", () => {
    expect(validateVoiceoverFits(15, undefined, 450).ok).toBe(true)
    expect(
      validateVoiceoverFits(15 + VOICEOVER_TOLERANCE_SECONDS, undefined, 450)
        .ok,
    ).toBe(true)
    const long = validateVoiceoverFits(15.5, undefined, 450)
    expect(long.ok ? "" : long.issues[0].message).toMatch(
      /voiceover is 15.5 s but the video is 15.0 s/,
    )
  })
})

describe("projects with and without audio", () => {
  const imageIds = [createAssetId(), createAssetId(), createAssetId()]
  const images = imageIds.map((id) => ({
    id,
    kind: "image" as const,
    mimeType: "image/png" as const,
    sizeBytes: 1000,
    width: 1080,
    height: 1920,
    displayName: "x.png",
  }))
  const silent: VideoProject = {
    product,
    assets: images,
    scenes: buildStoryboard(product, imageIds),
    settings: DEFAULT_VIDEO_SETTINGS,
  }

  it("keeps DV-003B projects (no audio fields) valid and silent", () => {
    const result = validateVideoProject(JSON.parse(JSON.stringify(silent)))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.audio).toBeUndefined()
      expect(result.value.settings.audio).toBe("none")
    }
  })

  it("requires audio settings to match the audio mode", () => {
    expect(
      validateVideoProject({
        ...silent,
        settings: { ...DEFAULT_VIDEO_SETTINGS, audio: "aac" },
      }).ok,
    ).toBe(false)
    const voice = audioAsset({ durationSeconds: 9 })
    const withVoice = {
      ...silent,
      settings: { ...DEFAULT_VIDEO_SETTINGS, audio: "aac" },
      audio: config({ mode: "voiceover", voiceoverAssetId: voice.id }),
      audioAssets: [voice],
    }
    expect(validateVideoProject(withVoice).ok).toBe(true)
    expect(
      validateVideoProject({ ...withVoice, settings: DEFAULT_VIDEO_SETTINGS })
        .ok,
    ).toBe(false)
    expect(
      validateVideoProject({
        ...withVoice,
        audioAssets: [voice, audioAsset({ role: "music" })],
      }).ok,
    ).toBe(false)
    expect(
      validateVideoProject({
        ...withVoice,
        audioAssets: [{ ...voice, durationSeconds: 20 }],
      }).ok,
    ).toBe(false)
  })
})

describe("server-side project reconstruction with audio", () => {
  const job = () => {
    const assets = [0, 1, 2].map(() => ({
      id: createAssetId(),
      kind: "image" as const,
      mimeType: "image/png" as const,
      sizeBytes: 1000,
      width: 1080,
      height: 1920,
      displayName: "x.png",
    }))
    const voice = audioAsset()
    const music = audioAsset({
      role: "music",
      container: "mp3",
      codec: "mp3",
      channels: 2,
      durationSeconds: 4,
    })
    return {
      record: {
        id: createRenderJobId(),
        state: "draft" as const,
        createdAt: "",
        updatedAt: "",
        assets,
        audioAssets: [voice, music],
        error: null,
        output: null,
      },
      voice,
      music,
    }
  }

  it("builds a mixed-audio project from IDs and a level only", () => {
    const { record, voice, music } = job()
    const result = buildTrustedProject(
      record,
      {
        product,
        assetIds: record.assets.map((a) => a.id),
        audio: config({
          mode: "voiceover-and-music",
          voiceoverAssetId: voice.id,
          musicAssetId: music.id,
        }),
      },
      fonts,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.settings.audio).toBe("aac")
    expect(result.value.audioAssets).toEqual([voice, music])
  })

  it("treats a missing audio block or mode none as a plain silent project", () => {
    const { record } = job()
    for (const body of [
      { product, assetIds: record.assets.map((a) => a.id) },
      { product, assetIds: record.assets.map((a) => a.id), audio: config() },
    ]) {
      const result = buildTrustedProject(record, body, fonts)
      expect(
        result.ok &&
          result.value.audio === undefined &&
          result.value.settings.audio === "none",
      ).toBe(true)
    }
  })

  it("rejects cross-job audio and long narration", () => {
    const { record } = job()
    const other = job()
    const cross = buildTrustedProject(
      record,
      {
        product,
        assetIds: record.assets.map((a) => a.id),
        audio: config({ mode: "voiceover", voiceoverAssetId: other.voice.id }),
      },
      fonts,
    )
    expect(cross.ok).toBe(false)
    const longVoice = audioAsset({ durationSeconds: 25 })
    const long = buildTrustedProject(
      { ...record, audioAssets: [longVoice] },
      {
        product,
        assetIds: record.assets.map((a) => a.id),
        audio: config({ mode: "voiceover", voiceoverAssetId: longVoice.id }),
      },
      fonts,
    )
    expect(long.ok ? "" : long.issues[0].message).toMatch(
      /voiceover is 25.0 s but the video is 15.0 s/,
    )
  })
})

describe("audio byte sniffing", () => {
  it("recognises WAV, M4A and MP3 (with or without an ID3 tag)", () => {
    expect(sniffAudioContainer(wavBytes())).toBe("wav")
    expect(sniffAudioContainer(m4aBytes())).toBe("m4a")
    expect(sniffAudioContainer(m4aBytes("isom"))).toBe("m4a") // FFprobe then rejects any video
    expect(sniffAudioContainer(mp3FrameBytes())).toBe("mp3")
    expect(sniffAudioContainer(id3Bytes())).toBe("mp3")
  })

  it("rejects everything else", () => {
    for (const text of [
      "OggS\0\0\0\0\0\0\0\0",
      "fLaC\0\0\0\0\0\0\0\0",
      "<html><body>",
      "RIFF\0\0\0\0AVI LIST",
      "ID3\x03\0\0\0\0\0\x14garbage-without-frame",
    ])
      expect(
        sniffAudioContainer(new TextEncoder().encode(text)),
        text,
      ).toBeNull()
    expect(sniffAudioContainer(m4aBytes("qt  "))).toBeNull()
    expect(sniffAudioContainer(new Uint8Array([0xff, 0xfb]))).toBeNull()
  })
})

describe("audio upload probing", () => {
  const probe = (streams: object[], format = "wav") =>
    JSON.stringify({
      streams,
      format: { format_name: format, duration: "9.0" },
    })
  const audioStream = {
    index: 0,
    codec_type: "audio",
    codec_name: "pcm_s16le",
    sample_rate: "44100",
    channels: 1,
    duration: "9.0",
  }

  it("accepts one audio stream with an accepted codec", () => {
    expect(parseAudioProbe(probe([audioStream]), "wav")).toEqual({
      ok: true,
      value: {
        codec: "pcm_s16le",
        durationSeconds: 9,
        sampleRate: 44100,
        channels: 1,
      },
    })
  })

  it("rejects cover art, video, extra streams, no or several audio streams", () => {
    const cases: [object[], RegExp][] = [
      [
        [
          audioStream,
          {
            codec_type: "video",
            codec_name: "mjpeg",
            disposition: { attached_pic: 1 },
          },
        ],
        /cover art/,
      ],
      [
        [
          audioStream,
          {
            codec_type: "video",
            codec_name: "h264",
            disposition: { attached_pic: 0 },
          },
        ],
        /contains video/,
      ],
      [
        [audioStream, { codec_type: "data", codec_name: "bin_data" }],
        /extra data stream/,
      ],
      [
        [audioStream, { codec_type: "attachment", codec_name: "ttf" }],
        /extra attachment stream/,
      ],
      [[], /no audio/],
      [
        [audioStream, { ...audioStream, index: 1 }],
        /more than one audio track/,
      ],
    ]
    for (const [streams, reason] of cases) {
      const result = parseAudioProbe(probe(streams), "wav")
      expect(result.ok ? "" : result.reason).toMatch(reason)
    }
  })

  it("rejects codecs and containers that don't match", () => {
    expect(
      parseAudioProbe(probe([{ ...audioStream, codec_name: "opus" }]), "wav")
        .ok,
    ).toBe(false)
    expect(parseAudioProbe(probe([audioStream], "ogg"), "wav").ok).toBe(false)
    expect(
      parseAudioProbe(
        probe(
          [{ ...audioStream, codec_name: "aac" }],
          "mov,mp4,m4a,3gp,3g2,mj2",
        ),
        "m4a",
      ).ok,
    ).toBe(true)
    expect(parseAudioProbe("not json", "wav").ok).toBe(false)
  })

  it("forces the sniffed demuxer and the file protocol", () => {
    const args = audioProbeArgs("/data/a.m4a", "m4a")
    expect(args.slice(args.indexOf("-f"), args.indexOf("-f") + 2)).toEqual([
      "-f",
      "mov",
    ])
    expect(args).toContain("-protocol_whitelist")
    expect(args.at(-1)).toBe("file:/data/a.m4a")
  })
})

describe("loudness measurement", () => {
  const log = (json: object) =>
    `[Parsed_loudnorm_0 @ 0x1]\n${JSON.stringify(json, null, 2)}\n`
  const good = {
    input_i: "-23.10",
    input_tp: "-9.20",
    input_lra: "4.00",
    input_thresh: "-33.50",
    target_offset: "0.40",
  }

  it("parses loudnorm's JSON statistics", () => {
    expect(parseLoudnormJson(log(good))).toEqual({
      inputI: -23.1,
      inputTp: -9.2,
      inputLra: 4,
      inputThresh: -33.5,
      targetOffset: 0.4,
    })
  })

  it("refuses silent or unmeasurable audio instead of amplifying it", () => {
    expect(parseLoudnormJson(log({ ...good, input_i: "-inf" }))).toBeNull()
    expect(parseLoudnormJson(log({ ...good, input_tp: "1e9" }))).toBeNull()
    expect(parseLoudnormJson("no stats here")).toBeNull()
    expect(parseLoudnormJson("{ broken")).toBeNull()
  })

  it("measures exactly what the mix will process", () => {
    const voice = audioAsset()
    const args = loudnessMeasureArgs(voice, "/data/v.wav", 450, LOUDNESS.speech)
    const filter = args[args.indexOf("-af") + 1]
    // No timing (older projects): the whole recording, up to the video's end.
    const used = Math.min(voice.durationSeconds * 48000, 720000)
    expect(filter).toContain(`atrim=start_sample=0:end_sample=${used}`)
    expect(filter).toContain("loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json")
    const music = audioAsset({ role: "music", durationSeconds: 3 })
    expect(
      loudnessMeasureArgs(music, "/data/m.mp3", 450, LOUDNESS.musicOnly).join(
        " ",
      ),
    ).toContain("atrim=end_sample=144000")
  })

  it("uses fixed targets: speech -16 LUFS, music under speech by level", () => {
    expect(loudnessTarget("voiceover", config({ mode: "voiceover" })).I).toBe(
      -16,
    )
    expect(loudnessTarget("music", config({ mode: "music" })).I).toBe(-16)
    expect(
      loudnessTarget(
        "music",
        config({ mode: "voiceover-and-music", musicLevel: "low" }),
      ).I,
    ).toBe(-30)
    expect(
      loudnessTarget(
        "music",
        config({ mode: "voiceover-and-music", musicLevel: "high" }),
      ).I,
    ).toBe(-23)
  })
})

describe("audio command generation (safe arguments)", () => {
  const m: LoudnessMeasurement = {
    inputI: -20,
    inputTp: -6,
    inputLra: 3,
    inputThresh: -30,
    targetOffset: 0.2,
  }
  const voice = (overrides: Partial<AudioAsset> = {}): AudioSource => ({
    asset: audioAsset({
      displayName: "voice'; rm -rf ~ $(id).wav",
      ...overrides,
    }),
    path: "/data/jobs/job_x/assets/asset_voice.wav",
    measurement: m,
  })
  const music = (durationSeconds = 3): AudioSource => ({
    asset: audioAsset({
      role: "music",
      container: "mp3",
      codec: "mp3",
      channels: 2,
      durationSeconds,
      displayName: "[out];music.mp3",
    }),
    path: "/data/jobs/job_x/assets/asset_music.mp3",
    measurement: m,
  })
  const plan = (
    cfg: AudioConfig,
    v: AudioSource | null,
    mu: AudioSource | null,
  ) =>
    buildAudioPlan({
      config: cfg,
      voiceover: v,
      music: mu,
      totalFrames: 450,
      aacEncoder: "aac",
    })
  const graphOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1]

  it("copies the H.264 stream and encodes AAC-LC 48 kHz stereo at 192 kb/s", () => {
    const { args } = plan(
      config({ mode: "voiceover", voiceoverAssetId: createAssetId() }),
      voice(),
      null,
    )
    const value = (flag: string) => args[args.indexOf(flag) + 1]
    expect(value("-c:v")).toBe("copy")
    expect(value("-c:a")).toBe("aac")
    expect(value("-profile:a")).toBe("aac_low")
    expect(value("-b:a")).toBe("192k")
    expect(value("-ar")).toBe("48000")
    expect(value("-ac")).toBe("2")
    expect(args).toContain("-nostdin")
    expect(args.filter((a) => a === "-map")).toHaveLength(2)
    expect(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4)).toEqual([
      "-map",
      "0:v:0",
      "-map",
      "[aout]",
    ])
    expect(args.at(-1)).toBe("file:final.mp4")
  })

  it("keeps file names out of the graph and forces demuxers with the file protocol", () => {
    const { args } = plan(
      config({
        mode: "voiceover-and-music",
        voiceoverAssetId: createAssetId(),
        musicAssetId: createAssetId(),
      }),
      voice(),
      music(),
    )
    const graph = graphOf(args)
    expect(graph).not.toMatch(/\/data|rm -rf|\$\(|music\.mp3|voice'/)
    expect(args).toContain("file:/data/jobs/job_x/assets/asset_voice.wav")
    expect(args.join(" ")).toContain(
      "-f wav -i file:/data/jobs/job_x/assets/asset_voice.wav",
    )
    expect(args.join(" ")).toContain(
      "-f mp3 -i file:/data/jobs/job_x/assets/asset_music.mp3",
    )
    expect(args.filter((a) => a === "-protocol_whitelist")).toHaveLength(3)
    expect(args.join("\n")).not.toContain("rm -rf")
  })

  it("pads a short voiceover with silence and cuts exactly at the video boundary", () => {
    const graph = graphOf(
      plan(
        config({ mode: "voiceover", voiceoverAssetId: createAssetId() }),
        voice(),
        null,
      ).args,
    )
    // 450 frames × 1600 samples = 720 000 samples = 15.000 s.
    expect(graph).toContain("[1:a]aresample=48000")
    expect(graph).toContain("atrim=end_sample=720000")
    expect(graph).toContain("apad=whole_len=720000,atrim=end_sample=720000")
    expect(graph).toMatch(
      /loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-20\.00:measured_TP=-6\.00:measured_LRA=3\.00:measured_thresh=-30\.00:offset=0\.20:linear=true/,
    )
    expect(graph).toContain("alimiter=limit=0.84:level=0:latency=1")
    expect(graph).not.toContain("aloop")
  })

  it("loops short music a finite number of times, trims and fades it out", () => {
    const graph = graphOf(
      plan(
        config({ mode: "music", musicAssetId: createAssetId() }),
        null,
        music(3),
      ).args,
    )
    // 3 s = 144 000 samples with a 0.6 s (28 800-sample) crossfade: the
    // music repeats every 115 200 samples, 7 times at most, then is trimmed.
    expect(graph).toContain("atrim=end_sample=144000")
    expect(graph).toContain("aloop=loop=7:size=115200")
    expect(graph).toContain("afade=t=out:ss=0:ns=28800:curve=qsin")
    expect(graph).toContain("afade=t=in:ss=0:ns=28800:curve=qsin")
    expect(graph).toContain("afade=t=out:st=13.500:d=1.500")
    expect(graph).toContain("afade=t=in:d=0.050")
    expect(graph).toMatch(/loudnorm=I=-16:/)
  })

  it("never loops long music more than once and uses only one video length of it", () => {
    expect(musicLoopSamples(music(180).asset, 450)).toBe(720000)
    const graph = graphOf(
      plan(
        config({ mode: "music", musicAssetId: createAssetId() }),
        null,
        music(180),
      ).args,
    )
    // Long enough for the whole video: played once, no seams at all.
    expect(graph).toContain("atrim=end_sample=720000")
    expect(graph).not.toContain("aloop")
    expect(graph).not.toContain("loop=-1")
  })

  it("ducks the music under the voice and mixes without renormalizing", () => {
    const graph = graphOf(
      plan(
        config({
          mode: "voiceover-and-music",
          voiceoverAssetId: createAssetId(),
          musicAssetId: createAssetId(),
          musicLevel: "medium",
        }),
        voice(),
        music(),
      ).args,
    )
    expect(graph).toContain("[voice]asplit=2[vmix][vkey]")
    expect(graph).toContain(
      "[music][vkey]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[ducked]",
    )
    expect(graph).toContain(
      "amix=inputs=2:duration=first:dropout_transition=0:normalize=0",
    )
    expect(graph).toMatch(/\[2:a\].*loudnorm=I=-26:/)
    expect(graph.endsWith("[aout]")).toBe(true)
  })

  it("refuses inconsistent requests", () => {
    expect(() => plan(config(), null, null)).toThrow(/Silent/)
    expect(() => plan(config({ mode: "voiceover" }), null, music())).toThrow(
      /don't match/,
    )
    expect(() =>
      plan(
        config({ mode: "voiceover" }),
        { ...voice(), measurement: { ...m, inputI: Number.NaN } },
        null,
      ),
    ).toThrow(/Invalid loudness/)
  })

  it("test-encodes AAC with the output options to the null muxer", () => {
    const args = testAacEncodeArgs("aac")
    expect(args.slice(-3)).toEqual(["-f", "null", "-"])
    expect(args).toEqual(
      expect.arrayContaining([
        "-c:a",
        "aac",
        "-profile:a",
        "aac_low",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
      ]),
    )
    expect(aacEncoderOptions("aac_at")).toEqual(["-b:a", "192k"])
  })
})

describe("output verification with audio", () => {
  const output = (audio: object[] = [], format: object = {}) =>
    JSON.stringify({
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1080,
          height: 1920,
          pix_fmt: "yuv420p",
          r_frame_rate: "30/1",
          avg_frame_rate: "30/1",
          nb_frames: "450",
        },
        ...audio,
      ],
      format: {
        format_name: "mov,mp4,m4a,3gp,3g2,mj2",
        duration: "15.010",
        size: "900000",
        tags: { major_brand: "isom" },
        ...format,
      },
    })
  const aac = {
    codec_type: "audio",
    codec_name: "aac",
    profile: "LC",
    sample_rate: "48000",
    channels: 2,
    duration: "15.000",
    bit_rate: "158602",
  }

  it("verifies one AAC-LC 48 kHz stereo stream of the video's length", () => {
    const result = verifyOutputProbe(output([aac]), 450, { expectAudio: true })
    expect(result.ok && result.value.audio).toEqual({
      codec: "aac",
      profile: "LC",
      sampleRate: 48000,
      channels: 2,
      bitRate: 158602,
      durationSeconds: 15,
    })
  })

  it("rejects missing, extra or wrong audio", () => {
    const cases: [object[], RegExp][] = [
      [[], /expected 1 audio stream, found 0/],
      [[aac, aac], /found 2/],
      [[{ ...aac, codec_name: "mp3" }], /not AAC/],
      [[{ ...aac, profile: "HE-AAC" }], /not LC/],
      [[{ ...aac, sample_rate: "44100" }], /44100 Hz/],
      [[{ ...aac, channels: 1 }], /not stereo/],
      [[{ ...aac, duration: "9.000" }], /audio lasts 9.00 s/],
    ]
    for (const [audio, problem] of cases) {
      const result = verifyOutputProbe(output(audio), 450, {
        expectAudio: true,
      })
      expect(result.ok ? "" : result.problems.join("; ")).toMatch(problem)
    }
    expect(
      verifyOutputProbe(
        output([aac, { codec_type: "subtitle", codec_name: "mov_text" }]),
        450,
        { expectAudio: true },
      ).ok,
    ).toBe(false)
  })

  it("still requires silent videos to have no audio", () => {
    expect(verifyOutputProbe(output([aac]), 450).ok).toBe(false)
    expect(verifyOutputProbe(output(), 450).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Storage, render service and route (mocked FFmpeg)
// ---------------------------------------------------------------------------

function png(width: number, height: number) {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  b.set([0x49, 0x48, 0x44, 0x52], 12)
  const view = new DataView(b.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return b
}

const facts = (overrides: Partial<AudioFacts> = {}): AudioFacts => ({
  codec: "pcm_s16le",
  durationSeconds: 9,
  sampleRate: 44100,
  channels: 1,
  ...overrides,
})

let base: string
let storage: VideoStorage
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-audio-unit-"))
  storage = createVideoStorage(base)
})
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

describe("audio storage", () => {
  it("stores audio under a generated name and records the probed facts", async () => {
    const job = await storage.createJob()
    const asset = await storage.addAudioAsset(
      job.id,
      {
        bytes: wavBytes(),
        declaredType: "audio/wav",
        fileName: "../../My voice.wav",
        role: "voiceover",
      },
      { inspect: async () => facts() },
    )
    expect(asset).toMatchObject({
      kind: "audio",
      role: "voiceover",
      container: "wav",
      displayName: "My voice.wav",
      durationSeconds: 9,
    })
    expect(
      await fs.readdir(path.join(storage.root, "jobs", job.id, "assets")),
    ).toEqual([`${asset.id}.wav`])
    expect((await storage.readJob(job.id)).audioAssets).toEqual([asset])
    expect(await storage.audioAssetPath(job.id, asset.id)).toBe(
      path.join(storage.root, "jobs", job.id, "assets", `${asset.id}.wav`),
    )
  })

  it("rejects disguised files, oversize, duplicates and inspector failures (and removes the file)", async () => {
    const job = await storage.createJob()
    const ok = { inspect: async () => facts() }
    const reject = (promise: Promise<unknown>, code: StorageError["code"]) =>
      expect(promise).rejects.toSatisfy(
        (e: unknown) => e instanceof StorageError && e.code === code,
      )
    await reject(
      storage.addAudioAsset(
        job.id,
        {
          bytes: png(400, 400),
          declaredType: "audio/wav",
          fileName: "x.wav",
          role: "voiceover",
        },
        ok,
      ),
      "invalid-upload",
    )
    await reject(
      storage.addAudioAsset(
        job.id,
        {
          bytes: wavBytes(),
          declaredType: "text/html",
          fileName: "x.wav",
          role: "voiceover",
        },
        ok,
      ),
      "invalid-upload",
    )
    const huge = new Uint8Array(AUDIO_LIMITS.maxBytes + 1)
    huge.set(wavBytes())
    await reject(
      storage.addAudioAsset(
        job.id,
        {
          bytes: huge,
          declaredType: "audio/wav",
          fileName: "x.wav",
          role: "voiceover",
        },
        ok,
      ),
      "invalid-upload",
    )
    await reject(
      storage.addAudioAsset(
        job.id,
        {
          bytes: wavBytes(),
          declaredType: "audio/wav",
          fileName: "x.wav",
          role: "voiceover",
        },
        {
          inspect: async () => {
            throw new StorageError("invalid-upload", "damaged")
          },
        },
      ),
      "invalid-upload",
    )
    await reject(
      storage.addAudioAsset(
        job.id,
        {
          bytes: wavBytes(),
          declaredType: "audio/wav",
          fileName: "x.wav",
          role: "voiceover",
        },
        { inspect: async () => facts({ channels: 6 }) },
      ),
      "invalid-upload",
    )
    expect(
      await fs.readdir(path.join(storage.root, "jobs", job.id, "assets")),
    ).toEqual([])
    await storage.addAudioAsset(
      job.id,
      {
        bytes: wavBytes(),
        declaredType: "audio/wav",
        fileName: "x.wav",
        role: "voiceover",
      },
      ok,
    )
    await reject(
      storage.addAudioAsset(
        job.id,
        {
          bytes: wavBytes(),
          declaredType: "audio/wav",
          fileName: "y.wav",
          role: "voiceover",
        },
        ok,
      ),
      "too-many-assets",
    )
  })

  it("reads job.json files written before DV-003C", async () => {
    const job = await storage.createJob()
    const file = path.join(storage.root, "jobs", job.id, "job.json")
    const legacy = JSON.parse(await fs.readFile(file, "utf8"))
    delete legacy.audioAssets
    await fs.writeFile(file, JSON.stringify(legacy))
    expect((await storage.readJob(job.id)).audioAssets).toEqual([])
  })
})

describe("render service audio stage (mocked FFmpeg)", () => {
  const READY: FfmpegCapabilityReport = {
    status: "ready",
    checkedAt: "",
    ffmpeg: { available: true, version: "6.1.1", problem: null },
    ffprobe: { available: true, version: "6.1.1", problem: null },
    filters: [],
    h264Encoders: [{ name: "libx264", hardware: false, works: true }],
    selectedH264Encoder: "libx264",
    aacEncoder: "aac",
    audio: { ready: true, missingFilters: [], reason: null },
    license: "gpl",
    issues: [],
  }
  const loudnormLog = `{\n "input_i" : "-20.0",\n "input_tp" : "-6.0",\n "input_lra" : "3.0",\n "input_thresh" : "-30.0",\n "target_offset" : "0.1"\n}`

  function fakeSpawn({ mixFails = false, silent = false } = {}): Spawner & {
    calls: string[][]
  } {
    const calls: string[][] = []
    const spawn = (async (
      _c: string,
      args: readonly string[],
      options: SpawnOptions,
    ) => {
      calls.push([...args])
      if (
        args.includes("print_format=json") ||
        args.some((a) => a.includes("print_format=json"))
      )
        return {
          ok: true,
          stderrTail: silent
            ? loudnormLog.replace("-20.0", "-inf")
            : loudnormLog,
        }
      if (args.includes("[aout]") && mixFails)
        return {
          ok: false,
          reason: "failed",
          exitCode: 1,
          stderrTail: "aac error",
        }
      if (args.includes("-progress"))
        options.onStdout?.("out_time_us=15000000\nprogress=end\n")
      await fs.writeFile(
        path.join(options.cwd, args.at(-1)!.replace(/^file:/, "")),
        "fake",
      )
      return { ok: true, stderrTail: "" }
    }) as Spawner & { calls: string[][] }
    spawn.calls = calls
    return spawn
  }

  const probeJson = (withAudio: boolean) =>
    JSON.stringify({
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1080,
          height: 1920,
          pix_fmt: "yuv420p",
          r_frame_rate: "30/1",
          avg_frame_rate: "30/1",
        },
        ...(withAudio
          ? [
              {
                codec_type: "audio",
                codec_name: "aac",
                profile: "LC",
                sample_rate: "48000",
                channels: 2,
                duration: "15.000",
                bit_rate: "160000",
              },
            ]
          : []),
      ],
      format: {
        format_name: "mov,mp4",
        duration: "15.000",
        size: "4",
        tags: { major_brand: "isom" },
      },
    })
  // The silent intermediate (render.mp4) has no audio; final.mp4 has one AAC stream.
  const run: Runner = async (_c, args) => ({
    ok: true,
    stdout: probeJson(args.at(-1)!.endsWith("final.mp4")),
    stderr: "",
  })

  const deps = (overrides: Partial<RenderDeps> = {}): RenderDeps => ({
    storage,
    spawn: fakeSpawn(),
    run,
    lease,
    getCapabilities: async () => READY,
    commands: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
    fonts,
    fontDir: fontDirectory(),
    threads: 2,
    timeouts: { sceneMs: 1000, encodeMs: 1000, audioMs: 1000 },
    ...overrides,
  })

  async function renderingJobWithVoice() {
    const job = await storage.createJob()
    for (let i = 0; i < 3; i++)
      await storage.addImageAsset(job.id, {
        bytes: png(1080, 1920),
        declaredType: "image/png",
        fileName: `${i}.png`,
      })
    const voice = await storage.addAudioAsset(
      job.id,
      {
        bytes: wavBytes(),
        declaredType: "audio/wav",
        fileName: "voice.wav",
        role: "voiceover",
      },
      { inspect: async () => facts() },
    )
    const record = await storage.readJob(job.id)
    const project = buildTrustedProject(
      record,
      {
        product,
        assetIds: record.assets.map((a) => a.id),
        audio: config({
          mode: "voiceover",
          voiceoverAssetId: voice.id as AssetId,
        }),
      },
      fonts,
    )
    if (!project.ok) throw new Error(JSON.stringify(project.issues))
    await storage.writeProject(job.id, project.value)
    await storage.transitionJob(job.id, "queued")
    await storage.transitionJob(job.id, "rendering")
    return job.id
  }

  it("measures, mixes with the copied video stream, verifies and publishes", async () => {
    const id = await renderingJobWithVoice()
    const spawn = fakeSpawn()
    const phases: string[] = []
    const output = await renderVideo(id, deps({ spawn }), (p) =>
      phases.push(p.phase === "audio" ? `audio:${p.step}` : p.phase),
    )
    expect(output.audio).toMatchObject({
      codec: "aac",
      sampleRate: 48000,
      channels: 2,
    })
    expect(phases).toContain("audio:measuring")
    expect(phases).toContain("audio:mixing")
    const encodes = spawn.calls.filter(
      (a) => a.includes("-c:v") && a[a.indexOf("-c:v") + 1] === "libx264",
    )
    // One H.264 encode per scene segment, joined and muxed without re-encoding.
    expect(encodes).toHaveLength((await storage.readProject(id)).scenes.length)
    const join = spawn.calls.find((a) => a.includes("concat"))!
    expect(join[join.indexOf("-c") + 1]).toBe("copy")
    const mix = spawn.calls.find((a) => a.includes("[aout]"))!
    expect(mix[mix.indexOf("-c:v") + 1]).toBe("copy")
    expect(await fs.readdir(await storage.workDir(id))).toEqual([])
  })

  it("fails an audio project before encoding when AAC isn't available", async () => {
    const id = await renderingJobWithVoice()
    const spawn = fakeSpawn()
    await expect(
      renderVideo(
        id,
        deps({
          spawn,
          lease,
          getCapabilities: async () => ({
            ...READY,
            aacEncoder: null,
            audio: { ready: false, missingFilters: [], reason: "No AAC." },
          }),
        }),
        () => {},
      ),
    ).rejects.toMatchObject({ code: "audio-unavailable", message: "No AAC." })
    expect(spawn.calls).toEqual([])
  })

  it("marks a failed audio encode as failed and publishes nothing", async () => {
    const id = await renderingJobWithVoice()
    await expect(
      renderVideo(id, deps({ spawn: fakeSpawn({ mixFails: true }) }), () => {}),
    ).rejects.toMatchObject({
      code: "audio-failed",
    })
    expect(
      await fs.readdir(path.join(storage.root, "jobs", id, "output")),
    ).toEqual([])
    expect(await fs.readdir(await storage.workDir(id))).toEqual([])
  })

  it("refuses silent voiceover files instead of amplifying noise", async () => {
    const id = await renderingJobWithVoice()
    await expect(
      renderVideo(id, deps({ spawn: fakeSpawn({ silent: true }) }), () => {}),
    ).rejects.toMatchObject({
      code: "audio-failed",
      message: expect.stringMatching(/silent/),
    })
  })
})

describe("audio upload route (local-only)", () => {
  const ctx = (jobId: string) =>
    ({ params: Promise.resolve({ jobId }) }) as never
  const request = (query: string, headers: Record<string, string>) => {
    const r = new Request(
      `http://localhost:3000/api/studio/pixel/jobs/x/audio${query}`,
      {
        method: "POST",
        headers: { host: "localhost:3000", ...headers },
      },
    ) as Request & { nextUrl: URL }
    r.nextUrl = new URL(r.url)
    return r as never
  }
  const id = createRenderJobId()

  it("refuses foreign hosts, bad roles, non-audio types and oversized bodies before reading", async () => {
    expect(
      (
        await uploadAudio(
          request("?role=music", { host: "evil.example" }),
          ctx(id),
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await uploadAudio(
          request("?role=narrator", { "content-type": "audio/wav" }),
          ctx(id),
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await uploadAudio(
          request("?role=music", { "content-type": "video/mp4" }),
          ctx(id),
        )
      ).status,
    ).toBe(415)
    expect(
      (
        await uploadAudio(
          request("?role=music", {
            "content-type": "audio/wav",
            "content-length": String(AUDIO_LIMITS.maxBytes + 1),
          }),
          ctx(id),
        )
      ).status,
    ).toBe(413)
    expect(
      (
        await uploadAudio(
          request("?role=music", { "content-type": "audio/wav" }),
          ctx("../../etc"),
        )
      ).status,
    ).toBe(404)
  })
})
