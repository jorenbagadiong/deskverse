/**
 * DV-003D3: voiceover trim/offset rules, sample math, crossfaded music loop
 * plans, the audio graph, MP3 cover art and backward compatibility. Pure;
 * the audio itself is checked in tests/integration/audio-timing.integration.test.ts.
 */
import { describe, expect, it } from "vitest"

import {
  MIN_NARRATION_MS,
  narrationWindow,
  recordingMs,
  SAMPLES_PER_MS,
  videoSamples,
} from "@/lib/video/audio-timing"
import { createAssetId } from "@/lib/video/ids"
import { buildStoryboard } from "@/lib/video/storyboard"
import type {
  AudioAsset,
  AudioConfig,
  ProductInfo,
  VoiceoverTiming,
} from "@/lib/video/types"
import {
  AUDIO_LIMITS,
  DEFAULT_TIMING_FIELDS,
  DEFAULT_VIDEO_SETTINGS,
  timingFromFields,
  validateAudioConfig,
  validateVideoProject,
  validateVoiceoverFits,
  validateVoiceoverTiming,
} from "@/lib/video/validation"
import {
  buildAudioPlan,
  loudnessMeasureArgs,
  LOUDNESS,
  musicLoopPlan,
  voiceoverSelection,
  type AudioSource,
} from "@/server/video/audio-command"
import { parseAudioProbe } from "@/server/video/ffprobe"
import { narrationSummary } from "@/server/video/job-summary"

const recording = (
  seconds: number,
  overrides: Partial<AudioAsset> = {},
): AudioAsset => ({
  id: createAssetId(),
  kind: "audio",
  role: "voiceover",
  container: "wav",
  codec: "pcm_s16le",
  sizeBytes: 1000,
  durationSeconds: seconds,
  sampleRate: 48000,
  channels: 1,
  displayName: "voice.wav",
  ...overrides,
})

const timing = (
  trimStartMs: number,
  trimEndMs: number | null,
  offsetMs = 0,
): VoiceoverTiming => ({ trimStartMs, trimEndMs, offsetMs })

const FRAMES_19S = 570

describe("timing rules: whole milliseconds, exact samples", () => {
  it("converts milliseconds to samples exactly and frames to 1600 samples", () => {
    expect(SAMPLES_PER_MS).toBe(48)
    expect(videoSamples(1)).toBe(1600)
    expect(videoSamples(FRAMES_19S)).toBe(912_000)
  })

  it("rounds a recording's length down to whole milliseconds", () => {
    expect(recordingMs(25)).toBe(25_000)
    // Float noise (1.005 × 1000 = 1004.9999999999999) isn't a shorter file…
    expect(1.005 * 1000).toBeLessThan(1005)
    expect(recordingMs(1.005)).toBe(1005)
    // …but a genuinely shorter one is rounded down, never past its end.
    expect(recordingMs(24.9999)).toBe(24_999)
    expect(recordingMs(12.3456)).toBe(12_345)
  })

  it("resolves the spec example: 25 s recording, 3.0–18.0 s, offset 2.0 s", () => {
    const w = narrationWindow(timing(3000, 18_000, 2000), 25, FRAMES_19S)
    expect(w).toEqual({
      trimStartSample: 144_000,
      trimEndSample: 864_000,
      startSample: 96_000,
      endSample: 816_000,
      lengthSamples: 720_000, // 15.0 s
      legacy: false,
    })
  })

  it("uses the recording's real end when trim end is empty", () => {
    const w = narrationWindow(timing(500, null, 0), 12.3456, FRAMES_19S)
    expect(w.trimEndSample).toBe(12_345 * 48)
    expect(w.lengthSamples).toBe((12_345 - 500) * 48)
  })

  it("defaults older projects to the whole recording from 0:00, cut at the video's end", () => {
    expect(narrationWindow(undefined, 9, FRAMES_19S)).toMatchObject({
      trimStartSample: 0,
      trimEndSample: 432_000,
      startSample: 0,
      legacy: true,
    })
    expect(narrationWindow(undefined, 19.2, FRAMES_19S).endSample).toBe(912_000)
  })
})

describe("voiceover timing validation", () => {
  it("accepts a valid selection inside the recording", () => {
    expect(validateVoiceoverTiming(timing(3000, 18_000, 2000), 25)).toEqual({
      ok: true,
      value: timing(3000, 18_000, 2000),
    })
    expect(validateVoiceoverTiming(timing(0, null, 0), 25).ok).toBe(true)
    expect(validateVoiceoverTiming(timing(0, 25_000, 0), 25).ok).toBe(true)
  })

  it("rejects negative, fractional, NaN, infinite, string and missing values", () => {
    for (const bad of [
      { trimStartMs: -1, trimEndMs: 5000, offsetMs: 0 },
      { trimStartMs: 0.5, trimEndMs: 5000, offsetMs: 0 },
      { trimStartMs: Number.NaN, trimEndMs: 5000, offsetMs: 0 },
      { trimStartMs: 0, trimEndMs: Number.POSITIVE_INFINITY, offsetMs: 0 },
      { trimStartMs: 0, trimEndMs: 5000, offsetMs: -100 },
      { trimStartMs: "0", trimEndMs: 5000, offsetMs: 0 },
      { trimStartMs: 0, trimEndMs: "5000", offsetMs: 0 },
      { trimStartMs: 0, trimEndMs: 5000 },
      { trimStartMs: 0, trimEndMs: 5000, offsetMs: 2 ** 60 },
      null,
      [],
      "3-18",
    ])
      expect(validateVoiceoverTiming(bad, 25).ok, JSON.stringify(bad)).toBe(
        false,
      )
  })

  it("rejects unsupported fields (no client-side filters or gains)", () => {
    const extra = validateVoiceoverTiming(
      { ...timing(0, 5000, 0), gainDb: 6 },
      25,
    )
    expect(!extra.ok && extra.issues[0].path).toBe(
      "audio.voiceoverTiming.gainDb",
    )
  })

  it("rejects intervals outside the recording, reversed or too short", () => {
    const pastEnd = validateVoiceoverTiming(timing(0, 25_001, 0), 25)
    expect(!pastEnd.ok && pastEnd.issues[0].message).toMatch(
      /past the end of the recording \(25 s\)/,
    )
    const reversed = validateVoiceoverTiming(timing(9000, 3000, 0), 25)
    expect(!reversed.ok && reversed.issues[0].message).toMatch(
      /must be before trim end/,
    )
    expect(validateVoiceoverTiming(timing(5000, 5000, 0), 25).ok).toBe(false)
    const short = validateVoiceoverTiming(
      timing(5000, 5000 + MIN_NARRATION_MS - 1, 0),
      25,
    )
    expect(!short.ok && short.issues[0].message).toMatch(/at least 0.5 s/)
    expect(
      validateVoiceoverTiming(timing(5000, 5000 + MIN_NARRATION_MS, 0), 25).ok,
    ).toBe(true)
  })

  it("rejects narration that can't fit, by exact samples, never cutting speech", () => {
    // 2.0 s + 15.0 s = 17.0 s fits a 19 s video; 5.0 s + 15.0 s doesn't.
    expect(
      validateVoiceoverFits(25, timing(3000, 18_000, 2000), FRAMES_19S).ok,
    ).toBe(true)
    const late = validateVoiceoverFits(
      25,
      timing(3000, 18_000, 5000),
      FRAMES_19S,
    )
    expect(!late.ok && late.issues[0]).toEqual({
      path: "audio.voiceoverTiming.offsetMs",
      message: expect.stringMatching(
        /would play from 5 s to 20 s, but the video is 19 s/,
      ),
    })
    // Ending exactly on the last sample fits; one millisecond more doesn't.
    expect(
      validateVoiceoverFits(25, timing(0, 15_000, 4000), FRAMES_19S).ok,
    ).toBe(true)
    expect(
      validateVoiceoverFits(25, timing(0, 15_001, 4000), FRAMES_19S).ok,
    ).toBe(false)
  })

  it("allows recordings up to the documented 5-minute bound", () => {
    expect(AUDIO_LIMITS.maxVoiceoverSeconds).toBe(300)
    expect(AUDIO_LIMITS.maxBytes).toBe(30 * 1024 * 1024)
  })
})

describe("studio timing fields", () => {
  it("converts seconds as typed to whole milliseconds", () => {
    expect(timingFromFields(DEFAULT_TIMING_FIELDS)).toEqual({
      ok: true,
      value: timing(0, null, 0),
    })
    expect(
      timingFromFields({ trimStart: "3", trimEnd: "18.0", offset: "2.5" }),
    ).toEqual({ ok: true, value: timing(3000, 18_000, 2500) })
    // Rounded to the nearest millisecond.
    expect(
      timingFromFields({ trimStart: "1.2345", trimEnd: "", offset: "0" }),
    ).toEqual({ ok: true, value: timing(1235, null, 0) })
    // Empty start/offset mean 0.
    expect(
      timingFromFields({ trimStart: " ", trimEnd: "", offset: "" }),
    ).toEqual({ ok: true, value: timing(0, null, 0) })
  })

  it("rejects text that isn't a plain number of seconds", () => {
    for (const value of ["-1", "abc", "1e3", "Infinity", "NaN", "1,5", "2s"]) {
      const result = timingFromFields({
        trimStart: value,
        trimEnd: "",
        offset: "0",
      })
      expect(result.ok, value).toBe(false)
      expect(!result.ok && result.issues[0]).toEqual({
        path: "audio.voiceoverTiming.trimStartMs",
        message: "Trim start must be a time in seconds, like 3 or 2.5.",
      })
    }
  })
})

describe("audio config and projects", () => {
  const voice = recording(25)
  const config = (overrides: Partial<AudioConfig> = {}): AudioConfig => ({
    mode: "voiceover",
    voiceoverAssetId: voice.id,
    musicAssetId: null,
    musicLevel: "low",
    ...overrides,
  })

  it("saves validated timing with the config", () => {
    const result = validateAudioConfig(
      config({ voiceoverTiming: timing(3000, 18_000, 2000) }),
      [voice],
    )
    expect(result.ok && result.value.voiceoverTiming).toEqual(
      timing(3000, 18_000, 2000),
    )
  })

  it("refuses timing without a voiceover, and bad timing with one", () => {
    const music = recording(30, { role: "music" })
    const noVoice = validateAudioConfig(
      {
        mode: "music",
        voiceoverAssetId: null,
        musicAssetId: music.id,
        musicLevel: "low",
        voiceoverTiming: timing(0, null, 0),
      },
      [music],
    )
    expect(!noVoice.ok && noVoice.issues[0].path).toBe("audio.voiceoverTiming")
    const bad = validateAudioConfig(
      config({ voiceoverTiming: timing(0, 30_000, 0) }),
      [voice],
    )
    expect(!bad.ok && bad.issues[0].path).toBe(
      "audio.voiceoverTiming.trimEndMs",
    )
  })

  const product: ProductInfo = {
    name: "Trailblazer travel mug",
    headline: "Hot coffee for 12 hours",
    benefits: ["Leak-proof lid", "Fits every cup holder", "Keeps ice"],
    callToAction: "Tap the link to shop",
    disclosure: "#ad · I may earn a commission.",
  }
  const images = [createAssetId(), createAssetId(), createAssetId()]
  const project = (audio: AudioConfig, assets: AudioAsset[]) => ({
    product,
    assets: images.map((id) => ({
      id,
      kind: "image",
      mimeType: "image/png",
      sizeBytes: 100,
      width: 1080,
      height: 1920,
      displayName: "x.png",
    })),
    scenes: buildStoryboard(product, images),
    settings: { ...DEFAULT_VIDEO_SETTINGS, audio: "aac" },
    audio,
    audioAssets: assets,
  })

  it("keeps older projects valid: no timing = whole narration from 0:00", () => {
    const short = recording(12)
    const legacy = validateVideoProject(
      project(config({ voiceoverAssetId: short.id }), [short]),
    )
    expect(legacy.ok).toBe(true)
    expect(legacy.ok && legacy.value.audio?.voiceoverTiming).toBeUndefined()
    expect(
      narrationSummary(legacy.ok ? legacy.value : (null as never)),
    ).toEqual({
      startSeconds: 0,
      endSeconds: 12,
      trimStartSeconds: 0,
      trimEndSeconds: 12,
      videoSeconds: 19,
    })
  })

  it("lets a long recording through only with a selection that fits", () => {
    const untimed = validateVideoProject(project(config(), [voice]))
    expect(!untimed.ok && untimed.issues[0].message).toMatch(
      /voiceover is 25.0 s but the video is 19.0 s. Trim the narration/,
    )
    const timed = validateVideoProject(
      project(config({ voiceoverTiming: timing(3000, 18_000, 2000) }), [voice]),
    )
    expect(timed.ok).toBe(true)
    expect(narrationSummary(timed.ok ? timed.value : (null as never))).toEqual({
      startSeconds: 2,
      endSeconds: 17,
      trimStartSeconds: 3,
      trimEndSeconds: 18,
      videoSeconds: 19,
    })
  })
})

describe("audio graph: trimmed selection, offset, crossfaded loops", () => {
  const measurement = {
    inputI: -20,
    inputTp: -6,
    inputLra: 3,
    inputThresh: -30,
    targetOffset: 0.2,
  }
  const source = (asset: AudioAsset): AudioSource => ({
    asset,
    path: `/data/${asset.role}.wav`,
    measurement,
  })
  const graphOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1]

  it("measures and mixes exactly the same trimmed selection", () => {
    const voice = recording(25)
    const t = timing(3000, 18_000, 2000)
    const selection = voiceoverSelection(narrationWindow(t, 25, FRAMES_19S))
    expect(selection).toContain("atrim=start_sample=144000:end_sample=864000")
    expect(selection).toContain("apad=whole_len=720000,atrim=end_sample=720000")
    const measure = loudnessMeasureArgs(
      voice,
      "/data/v.wav",
      FRAMES_19S,
      LOUDNESS.speech,
      t,
    )
    expect(measure[measure.indexOf("-af") + 1]).toBe(
      `${selection},loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json`,
    )
    const graph = graphOf(
      buildAudioPlan({
        config: {
          mode: "voiceover",
          voiceoverAssetId: voice.id,
          musicAssetId: null,
          musicLevel: "low",
          voiceoverTiming: t,
        },
        voiceover: source(voice),
        music: null,
        totalFrames: FRAMES_19S,
        aacEncoder: "aac",
      }).args,
    )
    expect(graph).toContain(`[1:a]${selection},loudnorm=`)
    // Real silence before (sample-exact delay), padded to the video's end.
    expect(graph).toContain("adelay=delays=96000S:all=1")
    expect(graph).toContain("apad=whole_len=912000,atrim=end_sample=912000")
  })

  it("adds no delay for narration starting at 0:00 or older projects", () => {
    const voice = recording(9)
    const graph = graphOf(
      buildAudioPlan({
        config: {
          mode: "voiceover",
          voiceoverAssetId: voice.id,
          musicAssetId: null,
          musicLevel: "low",
        },
        voiceover: source(voice),
        music: null,
        totalFrames: FRAMES_19S,
        aacEncoder: "aac",
      }).args,
    )
    expect(graph).not.toContain("adelay")
    expect(graph).toContain("atrim=start_sample=0:end_sample=432000")
  })

  it("refuses a plan whose narration doesn't fit (defence in depth)", () => {
    const voice = recording(25)
    expect(() =>
      buildAudioPlan({
        config: {
          mode: "voiceover",
          voiceoverAssetId: voice.id,
          musicAssetId: null,
          musicLevel: "low",
          voiceoverTiming: timing(3000, 18_000, 5000),
        },
        voiceover: source(voice),
        music: null,
        totalFrames: FRAMES_19S,
        aacEncoder: "aac",
      }),
    ).toThrow(/doesn't fit/)
  })

  it("plans crossfades that adapt to the track and never drift", () => {
    const music = (seconds: number) => recording(seconds, { role: "music" })
    // 2.3 s (2.3 × 48 000 is 110 399.99… in floating point: still all
    // 110 400 samples): 20 % crossfade (0.46 s); seams every 1.84 s.
    const short = musicLoopPlan(music(2.3), FRAMES_19S)
    expect(short).toMatchObject({
      sourceSamples: 110_400,
      crossfadeSamples: 22_080,
      periodSamples: 88_320,
      loops: true,
    })
    short.seams.forEach((at, i) => expect(at).toBe((i + 1) * 88_320))
    expect(short.seams.at(-1)!).toBeLessThan(912_000)
    // 0.5 s (the shortest allowed): a 0.1 s crossfade, many seams.
    const tiny = musicLoopPlan(music(0.5), FRAMES_19S)
    expect(tiny.crossfadeSamples).toBe(4800)
    expect(tiny.seams.length).toBe(Math.ceil(912_000 / 19_200) - 1)
    // 10 s: capped at 1 s.
    expect(musicLoopPlan(music(10), FRAMES_19S).crossfadeSamples).toBe(48_000)
    // Longer than the video: no loop, no seams.
    expect(musicLoopPlan(music(25), FRAMES_19S)).toMatchObject({
      loops: false,
      seams: [],
    })
  })

  it("keeps the loop graph a fixed size however many seams there are", () => {
    const sizes = [0.5, 2.3, 9].map((seconds) => {
      const music = recording(seconds, { role: "music" })
      const graph = graphOf(
        buildAudioPlan({
          config: {
            mode: "music",
            voiceoverAssetId: null,
            musicAssetId: music.id,
            musicLevel: "low",
          },
          voiceover: null,
          music: source(music),
          totalFrames: 900,
          aacEncoder: "aac",
        }).args,
      )
      expect(graph.match(/aloop=/g)).toHaveLength(1)
      expect(graph).not.toContain("loop=-1")
      expect(graph).toContain("afade=t=out:st=28.500:d=1.500") // final fade kept
      return graph.split(";").length
    })
    expect(new Set(sizes).size).toBe(1)
  })

  it("keeps ducking and peak protection with timed narration and looping music", () => {
    const voice = recording(25)
    const music = recording(2.3, { role: "music" })
    const graph = graphOf(
      buildAudioPlan({
        config: {
          mode: "voiceover-and-music",
          voiceoverAssetId: voice.id,
          musicAssetId: music.id,
          musicLevel: "medium",
          voiceoverTiming: timing(3000, 18_000, 2000),
        },
        voiceover: source(voice),
        music: source(music),
        totalFrames: FRAMES_19S,
        aacEncoder: "aac",
      }).args,
    )
    expect(graph).toContain("sidechaincompress=threshold=0.03:ratio=6")
    expect(graph).toContain("alimiter=limit=0.84")
    expect(graph).toContain("aloop=")
    expect(graph).toContain("adelay=delays=96000S:all=1")
  })
})

describe("MP3 cover art", () => {
  const probe = (streams: object[], format = "mp3") =>
    JSON.stringify({ streams, format: { format_name: format, duration: "9" } })
  const mp3 = {
    index: 0,
    codec_type: "audio",
    codec_name: "mp3",
    sample_rate: "44100",
    channels: 2,
    duration: "9.0",
  }
  const picture = (codec: string, attached = 1) => ({
    index: 1,
    codec_type: "video",
    codec_name: codec,
    disposition: { attached_pic: attached },
  })

  it("accepts one ordinary JPEG or PNG cover in an MP3, keeping one audio stream", () => {
    for (const codec of ["mjpeg", "png"])
      expect(parseAudioProbe(probe([mp3, picture(codec)]), "mp3")).toEqual({
        ok: true,
        value: {
          codec: "mp3",
          durationSeconds: 9,
          sampleRate: 44100,
          channels: 2,
        },
      })
  })

  it("rejects several pictures, odd pictures, real video, extra streams and covers outside MP3", () => {
    const cases: [object[], string, RegExp][] = [
      [
        [mp3, picture("mjpeg"), { ...picture("png"), index: 2 }],
        "mp3",
        /more than one embedded picture/,
      ],
      [[mp3, picture("gif")], "mp3", /isn't an ordinary JPEG or PNG/],
      [[mp3, picture("h264", 0)], "mp3", /contains video/],
      [
        [mp3, picture("mjpeg"), { codec_type: "data", codec_name: "bin_data" }],
        "mp3",
        /extra data stream/,
      ],
      [
        [mp3, picture("mjpeg"), { ...mp3, index: 2 }],
        "mp3",
        /more than one audio track/,
      ],
      [
        [{ ...mp3, codec_name: "aac" }, picture("mjpeg")],
        "mov,mp4,m4a,3gp,3g2,mj2",
        /embedded cover art/,
      ],
      [[picture("mjpeg")], "mp3", /no audio/],
    ]
    for (const [streams, format, reason] of cases) {
      const container = format === "mp3" ? "mp3" : "m4a"
      const result = parseAudioProbe(probe(streams, format), container)
      expect(result.ok ? "" : result.reason).toMatch(reason)
    }
  })
})
