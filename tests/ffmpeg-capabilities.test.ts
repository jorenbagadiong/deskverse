import { describe, expect, it } from "vitest"

import {
  AUDIO_FILTERS,
  EFFECT_FILTERS,
  REQUIRED_FILTERS,
} from "@/lib/video/capabilities"
import { checkLocalRequest, isLoopbackHost } from "@/server/http/local-request"
import {
  classifyRunError,
  createRunner,
  minimalEnvironment,
  type RunResult,
  type Runner,
} from "@/server/process/run-executable"
import {
  detectFfmpegCapabilities,
  parseEncoders,
  parseFilters,
  parseLicense,
  parseMajorVersion,
  parseVersion,
  pickAacEncoder,
  rankH264Encoders,
  resolveExecutable,
  testEncodeArgs,
} from "@/server/video/ffmpeg-capabilities"

// --- Captured output (trimmed) from Ubuntu 24.04's ffmpeg 6.1.1 -------------

const FFMPEG_VERSION = `ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers
built with gcc 13 (Ubuntu 13.2.0-23ubuntu3)
configuration: --prefix=/usr --extra-version=3ubuntu5 --toolchain=hardened --libdir=/usr/lib/x86_64-linux-gnu --arch=amd64 --enable-gpl --disable-stripping --enable-gnutls --enable-libfreetype --enable-libx264 --enable-libx265 --enable-shared
libavutil      58. 29.100 / 58. 29.100
libavcodec     60. 31.102 / 60. 31.102
`

const FFPROBE_VERSION = `ffprobe version 6.1.1-3ubuntu5 Copyright (c) 2007-2023 the FFmpeg developers
built with gcc 13 (Ubuntu 13.2.0-23ubuntu3)
configuration: --prefix=/usr --enable-gpl
`

const ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D a64multi             Multicolor charset for Commodore 64 (codec a64_multi)
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D libx264rgb           libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 RGB (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V..... h264_vaapi           H.264/AVC (VAAPI) (codec h264)
 V....D libx265              libx265 H.265 / HEVC (codec hevc)
 A....D aac                  AAC (Advanced Audio Coding)
 A....D libopus              libopus Opus (codec opus)
 S..... ass                  ASS (Advanced SubStation Alpha) subtitle
`

const filterLine = (name: string, io = "V->V") =>
  ` T.C ${name.padEnd(17)} ${io.padEnd(10)} Description of ${name}.`

const FILTERS = [
  "Filters:",
  "  T.. = Timeline support",
  "  .S. = Slice threading",
  "  ..C = Command support",
  "  A = Audio input/output",
  "  | = Source or sink filter",
  ...REQUIRED_FILTERS.map((f) =>
    filterLine(f, f === "concat" ? "N->N" : "V->V"),
  ),
  ...AUDIO_FILTERS.map((f) => filterLine(f, "A->A")),
  filterLine("perspective"),
  filterLine("pad"),
  filterLine("xfade", "VV->V"),
].join("\n")

// --- A fake machine ---------------------------------------------------------

type Machine = Partial<Record<string, RunResult>>

const ok = (stdout: string): RunResult => ({ ok: true, stdout, stderr: "" })
const missing: RunResult = { ok: false, reason: "not-found", exitCode: null }

const healthy: Machine = {
  "ffmpeg -hide_banner -version": ok(FFMPEG_VERSION),
  "ffprobe -hide_banner -version": ok(FFPROBE_VERSION),
  "ffmpeg -hide_banner -encoders": ok(ENCODERS),
  "ffmpeg -hide_banner -filters": ok(FILTERS),
}

/**
 * Test encodes (`… -c:v <encoder> … -f null -`) are keyed as
 * "encode <encoder>" and succeed unless the machine says otherwise.
 */
function fakeRunner(machine: Machine, calls: string[] = []): Runner {
  return async (command, args) => {
    if (args.at(-1) === "-" && args.includes("null")) {
      // Audio test encodes use -c:a and are keyed "encode-aac <encoder>".
      const audio = args.includes("-c:a")
      const encoder = args[args.indexOf(audio ? "-c:a" : "-c:v") + 1]
      const key = `${audio ? "encode-aac" : "encode"} ${encoder}`
      calls.push(key)
      return machine[key] ?? ok("")
    }
    const key = `${command} ${args.join(" ")}`
    calls.push(key)
    return machine[key] ?? missing
  }
}

const encodeFails: RunResult = { ok: false, reason: "failed", exitCode: 1 }

const detect = (machine: Machine, env: Record<string, string> = {}) =>
  detectFfmpegCapabilities({
    run: fakeRunner(machine),
    env,
    now: () => new Date("2026-11-21T00:00:00Z"),
  })

// ---------------------------------------------------------------------------

describe("FFmpeg output parsing", () => {
  it("reads versions", () => {
    expect(parseVersion(FFMPEG_VERSION, "ffmpeg")).toBe("6.1.1-3ubuntu5")
    expect(parseVersion(FFPROBE_VERSION, "ffprobe")).toBe("6.1.1-3ubuntu5")
    expect(parseVersion("ffmpeg version n7.0.2 Copyright", "ffmpeg")).toBe(
      "n7.0.2",
    )
    expect(
      parseVersion("ffmpeg version N-112233-gabcdef Copyright", "ffmpeg"),
    ).toBe("N-112233-gabcdef")
    expect(parseVersion("bash: ffmpeg: command not found", "ffmpeg")).toBeNull()
    expect(parseVersion(FFMPEG_VERSION, "ffprobe")).toBeNull()
  })

  it("strips anything unexpected from version strings", () => {
    expect(
      parseVersion("ffmpeg version 6.1<script>alert(1)</script> x", "ffmpeg"),
    ).toBe("6.1scriptalert1script")
    expect(
      parseVersion(`ffmpeg version ${"9".repeat(200)}`, "ffmpeg"),
    ).toHaveLength(64)
  })

  it("derives a major version when it can", () => {
    expect(parseMajorVersion("6.1.1-3ubuntu5")).toBe(6)
    expect(parseMajorVersion("n7.0.2")).toBe(7)
    expect(parseMajorVersion("4.4.2-0ubuntu0.22.04.1")).toBe(4)
    expect(parseMajorVersion("N-112233-gabcdef")).toBeNull()
    expect(parseMajorVersion(null)).toBeNull()
  })

  it("derives the license from configure flags without exposing them", () => {
    expect(parseLicense(FFMPEG_VERSION)).toBe("gpl")
    expect(
      parseLicense("configuration: --prefix=/opt/ff --enable-shared"),
    ).toBe("lgpl")
    expect(parseLicense("configuration: --enable-gpl --enable-nonfree")).toBe(
      "nonfree",
    )
    expect(parseLicense("ffmpeg version 6.1")).toBe("unknown")
  })

  it("lists encoders with the codec they produce", () => {
    const encoders = parseEncoders(ENCODERS)
    expect(encoders.map((e) => e.name)).toEqual([
      "a64multi",
      "libx264",
      "libx264rgb",
      "h264_nvenc",
      "h264_vaapi",
      "libx265",
      "aac",
      "libopus",
      "ass",
    ])
    expect(encoders.find((e) => e.name === "aac")).toEqual({
      name: "aac",
      type: "audio",
      codec: "aac",
    })
    // The legend above the dashes is not parsed as encoders.
    expect(encoders.some((e) => e.name === "=")).toBe(false)
  })

  it("ranks H.264 encoders: libx264, libopenh264, other software, then hardware", () => {
    const ranked = rankH264Encoders([
      { name: "h264_nvenc", type: "video", codec: "h264" },
      { name: "libopenh264", type: "video", codec: "h264" },
      { name: "libx264rgb", type: "video", codec: "h264" },
      { name: "libx264", type: "video", codec: "h264" },
      { name: "libx265", type: "video", codec: "hevc" },
    ])
    expect(ranked).toEqual([
      { name: "libx264", hardware: false, works: null },
      { name: "libopenh264", hardware: false, works: null },
      { name: "h264_nvenc", hardware: true, works: null },
    ])
  })

  it("picks the native AAC encoder first", () => {
    expect(
      pickAacEncoder([
        { name: "libfdk_aac", type: "audio", codec: "aac" },
        { name: "aac", type: "audio", codec: "aac" },
      ]),
    ).toBe("aac")
    expect(
      pickAacEncoder([{ name: "libopus", type: "audio", codec: "opus" }]),
    ).toBeNull()
  })

  it("lists filters but not the legend", () => {
    const filters = parseFilters(FILTERS)
    for (const name of REQUIRED_FILTERS)
      expect(filters.has(name), name).toBe(true)
    for (const name of EFFECT_FILTERS)
      expect(filters.has(name), name).toBe(true)
    expect(filters.has("color")).toBe(true)
    expect(filters.has("=")).toBe(false)
    expect(filters.size).toBe(
      new Set([...REQUIRED_FILTERS, ...AUDIO_FILTERS, ...EFFECT_FILTERS]).size,
    )
  })
})

describe("capability detection", () => {
  it("reports a complete installation as ready", async () => {
    const report = await detect(healthy)
    expect(report.status).toBe("ready")
    expect(report.ffmpeg).toEqual({
      available: true,
      version: "6.1.1-3ubuntu5",
      problem: null,
    })
    expect(report.ffprobe.available).toBe(true)
    expect(report.selectedH264Encoder).toBe("libx264")
    expect(report.h264Encoders.map((e) => e.name)).toEqual([
      "libx264",
      "h264_nvenc",
      "h264_vaapi",
    ])
    expect(report.aacEncoder).toBe("aac")
    expect(report.license).toBe("gpl")
    expect(report.filters.every((f) => f.available)).toBe(true)
    expect(report.issues).toEqual([])
    expect(report.checkedAt).toBe("2026-11-21T00:00:00.000Z")
  })

  it("never leaks paths or configure flags into the report", async () => {
    const json = JSON.stringify(
      await detect(
        Object.fromEntries(
          Object.entries(healthy).map(([k, v]) => [
            k.replace(/^(ffmpeg|ffprobe)/, "/opt/secret/bin/$1"),
            v,
          ]),
        ),
        {
          DESKVERSE_FFMPEG_PATH: "/opt/secret/bin/ffmpeg",
          DESKVERSE_FFPROBE_PATH: "/opt/secret/bin/ffprobe",
        },
      ),
    )
    expect(json).not.toMatch(
      /\/opt\/secret|\/usr|--prefix|--enable|configuration/,
    )
  })

  it("explains a missing FFmpeg and FFprobe", async () => {
    const report = await detect({})
    expect(report.status).toBe("missing")
    expect(report.ffmpeg).toEqual({
      available: false,
      version: null,
      problem: "not-found",
    })
    expect(report.ffprobe.problem).toBe("not-found")
    expect(report.issues.map((i) => i.code)).toEqual([
      "ffmpeg-missing",
      "ffprobe-missing",
    ])
    expect(report.issues[0].message).toMatch(
      /wasn't found.*sudo apt install ffmpeg/,
    )
    expect(report.selectedH264Encoder).toBeNull()
    expect(report.filters).toEqual([])
  })

  it("reports FFprobe missing on its own", async () => {
    const report = await detect({
      ...healthy,
      "ffprobe -hide_banner -version": missing,
    })
    expect(report.status).toBe("missing")
    expect(report.ffmpeg.available).toBe(true)
    expect(report.issues.map((i) => i.code)).toEqual(["ffprobe-missing"])
  })

  it("does not assume libx264: falls back to libopenh264 with a warning", async () => {
    const report = await detect({
      ...healthy,
      "ffmpeg -hide_banner -encoders": ok(
        ` ------\n V....D libopenh264          OpenH264 H.264 / AVC (codec h264)\n A....D aac   AAC (Advanced Audio Coding)\n`,
      ),
    })
    expect(report.status).toBe("ready")
    expect(report.selectedH264Encoder).toBe("libopenh264")
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "no-libx264", severity: "warning" }),
    ])
  })

  it("warns when only hardware H.264 encoders exist", async () => {
    const report = await detect({
      ...healthy,
      "ffmpeg -hide_banner -encoders": ok(
        ` ------\n V....D h264_vaapi   H.264/AVC (VAAPI) (codec h264)\n A....D aac   AAC\n`,
      ),
    })
    expect(report.status).toBe("ready")
    expect(report.selectedH264Encoder).toBe("h264_vaapi")
    expect(report.issues.map((i) => i.code)).toEqual(["hardware-encoder-only"])
  })

  it("is unsupported without any H.264 encoder", async () => {
    const report = await detect({
      ...healthy,
      "ffmpeg -hide_banner -encoders": ok(
        ` ------\n V....D libx265  libx265 (codec hevc)\n`,
      ),
    })
    expect(report.status).toBe("unsupported")
    expect(report.selectedH264Encoder).toBeNull()
    expect(report.issues.map((i) => i.code)).toEqual([
      "no-h264-encoder",
      "no-aac-encoder",
    ])
  })

  it("is unsupported when required filters are missing (e.g. drawtext without freetype)", async () => {
    const report = await detect({
      ...healthy,
      "ffmpeg -hide_banner -filters": ok(
        REQUIRED_FILTERS.filter((f) => f !== "drawtext" && f !== "gblur")
          .map((f) => filterLine(f))
          .join("\n"),
      ),
    })
    expect(report.status).toBe("unsupported")
    const issue = report.issues.find((i) => i.code === "missing-filters")!
    expect(issue.message).toMatch(/gblur, drawtext/)
    expect(issue.message).toMatch(/libfreetype/)
    expect(report.filters.find((f) => f.name === "xfade")).toEqual({
      name: "xfade",
      available: false,
      required: false,
      purpose: "video",
    })
  })

  it("only warns about missing AAC (audio is deferred)", async () => {
    const report = await detect({
      ...healthy,
      "ffmpeg -hide_banner -encoders": ok(
        ` ------\n V....D libx264  libx264 H.264 (codec h264)\n`,
      ),
    })
    expect(report.status).toBe("ready")
    expect(report.aacEncoder).toBeNull()
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "no-aac-encoder", severity: "warning" }),
    ])
  })

  it("warns about old and nonfree builds", async () => {
    const report = await detect({
      ...healthy,
      "ffmpeg -hide_banner -version": ok(
        "ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright\nconfiguration: --enable-gpl --enable-nonfree\n",
      ),
    })
    expect(report.status).toBe("ready")
    expect(report.license).toBe("nonfree")
    expect(report.issues.map((i) => i.code)).toEqual([
      "old-version",
      "nonfree-build",
    ])
  })

  it("treats a program that isn't really FFmpeg as unusable", async () => {
    const report = await detect({
      ...healthy,
      "ffmpeg -hide_banner -version": ok("Usage: something-else [options]"),
    })
    expect(report.status).toBe("missing")
    expect(report.ffmpeg.problem).toBe("unrecognized-output")
    expect(report.issues[0].code).toBe("ffmpeg-unusable")
  })

  it("maps permission errors and timeouts to readable problems", async () => {
    for (const [reason, problem, text] of [
      ["not-executable", "not-executable", /permission denied/],
      ["timed-out", "timed-out", /didn't respond/],
      ["failed", "failed", /may be broken/],
    ] as const) {
      const report = await detect({
        ...healthy,
        "ffmpeg -hide_banner -version": { ok: false, reason, exitCode: null },
      })
      expect(report.ffmpeg.problem).toBe(problem)
      expect(report.issues[0].message).toMatch(text)
    }
  })

  it("only ever runs fixed, read-only commands", async () => {
    const calls: string[] = []
    await detectFfmpegCapabilities({ run: fakeRunner(healthy, calls), env: {} })
    expect(calls.sort()).toEqual([
      // One real test encode each: libx264 and aac worked, nothing else tried.
      "encode libx264",
      "encode-aac aac",
      "ffmpeg -hide_banner -encoders",
      "ffmpeg -hide_banner -filters",
      "ffmpeg -hide_banner -version",
      "ffprobe -hide_banner -version",
    ])
  })

  it("doesn't trust the encoder list: falls back when libx264 fails a test encode", async () => {
    const calls: string[] = []
    const report = await detectFfmpegCapabilities({
      run: fakeRunner({ ...healthy, "encode libx264": encodeFails }, calls),
      env: {},
    })
    expect(report.status).toBe("ready")
    expect(report.selectedH264Encoder).toBe("h264_nvenc")
    expect(report.h264Encoders).toEqual([
      { name: "libx264", hardware: false, works: false },
      { name: "h264_nvenc", hardware: true, works: true },
      { name: "h264_vaapi", hardware: true, works: null },
    ])
    expect(report.issues.map((i) => i.code)).toEqual(["hardware-encoder-only"])
    expect(calls.filter((c) => c.startsWith("encode "))).toEqual([
      "encode libx264",
      "encode h264_nvenc",
    ])
  })

  it("is unsupported when every listed encoder fails to encode", async () => {
    const report = await detect({
      ...healthy,
      "encode libx264": encodeFails,
      "encode h264_nvenc": encodeFails,
      "encode h264_vaapi": { ok: false, reason: "timed-out", exitCode: null },
    })
    expect(report.status).toBe("unsupported")
    expect(report.selectedH264Encoder).toBeNull()
    expect(report.h264Encoders.every((e) => e.works === false)).toBe(true)
    const issue = report.issues.find((i) => i.code === "no-working-encoder")!
    expect(issue.severity).toBe("error")
    expect(issue.message).toMatch(/could encode a test video/)
  })

  it("test-encodes at the real output size and pixel format, to nowhere", () => {
    const args = testEncodeArgs("libx264")
    expect(args).toContain("color=c=black:s=1080x1920:r=30")
    expect(
      args.slice(args.indexOf("-pix_fmt"), args.indexOf("-pix_fmt") + 2),
    ).toEqual(["-pix_fmt", "yuv420p"])
    expect(args.slice(-3)).toEqual(["-f", "null", "-"])
    expect(args).toContain("-nostdin")
  })

  it("refuses unsafe executable overrides without running anything", async () => {
    const calls: string[] = []
    const report = await detectFfmpegCapabilities({
      run: fakeRunner(healthy, calls),
      env: { DESKVERSE_FFMPEG_PATH: "/bin/sh" },
    })
    expect(report.ffmpeg.problem).toBe("invalid-configuration")
    expect(report.issues[0].code).toBe("invalid-configuration")
    expect(calls.some((c) => c.startsWith("/bin/sh"))).toBe(false)
  })
})

describe("audio capability detection (DV-003C)", () => {
  it("is ready for audio when AAC passes a real test encode and the filters exist", async () => {
    const report = await detect(healthy)
    expect(report.aacEncoder).toBe("aac")
    expect(report.audio).toEqual({
      ready: true,
      missingFilters: [],
      reason: null,
    })
    expect(
      report.filters.filter((f) => f.purpose === "audio").map((f) => f.name),
    ).toEqual([...AUDIO_FILTERS])
  })

  it("doesn't trust a listed AAC encoder that fails, and keeps silent rendering ready", async () => {
    const report = await detect({ ...healthy, "encode-aac aac": encodeFails })
    expect(report.status).toBe("ready")
    expect(report.selectedH264Encoder).toBe("libx264")
    expect(report.aacEncoder).toBeNull()
    expect(report.audio.ready).toBe(false)
    expect(report.audio.reason).toMatch(/failed a test encode/)
    expect(report.issues).toEqual([
      expect.objectContaining({
        code: "no-aac-encoder",
        severity: "warning",
        message: expect.stringMatching(/Silent videos still render/),
      }),
    ])
  })

  it("falls back to another AAC encoder when the native one fails", async () => {
    const report = await detect({
      ...healthy,
      "ffmpeg -hide_banner -encoders": ok(
        ` ------\n V....D libx264  libx264 H.264 (codec h264)\n A....D aac  AAC (Advanced Audio Coding)\n A....D libfdk_aac  Fraunhofer FDK AAC (codec aac)\n`,
      ),
      "encode-aac aac": encodeFails,
    })
    expect(report.aacEncoder).toBe("libfdk_aac")
    expect(report.audio.ready).toBe(true)
  })

  it("disables only audio when audio filters are missing", async () => {
    const report = await detect({
      ...healthy,
      "ffmpeg -hide_banner -filters": ok(
        FILTERS.split("\n")
          .filter((line) => !/ (loudnorm|sidechaincompress) /.test(line))
          .join("\n"),
      ),
    })
    expect(report.status).toBe("ready")
    expect(report.audio).toEqual({
      ready: false,
      missingFilters: ["loudnorm", "sidechaincompress"],
      reason: expect.stringMatching(
        /missing audio filters \(loudnorm, sidechaincompress\)/,
      ),
    })
    expect(report.issues.map((i) => [i.code, i.severity])).toEqual([
      ["audio-unavailable", "warning"],
    ])
  })

  it("reports audio as unavailable when FFmpeg is missing", async () => {
    const report = await detect({})
    expect(report.audio.ready).toBe(false)
    expect(report.audio.reason).toMatch(/FFmpeg isn't available/)
  })
})

describe("executable resolution", () => {
  it("uses PATH lookup by default", () => {
    expect(resolveExecutable("ffmpeg", undefined)).toEqual({
      ok: true,
      command: "ffmpeg",
    })
    expect(resolveExecutable("ffprobe", "  ")).toEqual({
      ok: true,
      command: "ffprobe",
    })
  })

  it("accepts absolute paths to the right program only", () => {
    expect(resolveExecutable("ffmpeg", "/usr/local/bin/ffmpeg").ok).toBe(true)
    expect(resolveExecutable("ffmpeg", "C:\\ffmpeg\\bin\\ffmpeg.exe").ok).toBe(
      true,
    )
    for (const bad of [
      "ffmpeg",
      "./ffmpeg",
      "../bin/ffmpeg",
      "/bin/sh",
      "/usr/bin/ffmpeg; rm -rf ~",
      "/usr/bin/ffprobe",
      "/usr/bin/ffmpeg\n/bin/sh",
    ])
      expect(resolveExecutable("ffmpeg", bad).ok, bad).toBe(false)
  })
})

describe("process runner", () => {
  it("reports a missing executable as not-found, without a shell", async () => {
    const run = createRunner({ timeoutMs: 2000 })
    const result = await run("deskverse-definitely-not-installed-ffmpeg", [
      "-version",
    ])
    expect(result).toEqual({ ok: false, reason: "not-found", exitCode: null })
  })

  it("passes arguments verbatim (no shell interpretation)", async () => {
    const run = createRunner({ timeoutMs: 5000 })
    const result = await run(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      "$(whoami); echo pwned | cat > /tmp/x",
    ])
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(JSON.parse(result.stdout)).toEqual([
        "$(whoami); echo pwned | cat > /tmp/x",
      ])
  })

  it("kills processes that run too long", async () => {
    const run = createRunner({ timeoutMs: 200 })
    const result = await run(process.execPath, [
      "-e",
      "setTimeout(() => {}, 10000)",
    ])
    expect(result).toEqual({ ok: false, reason: "timed-out", exitCode: null })
  })

  it("caps output size", async () => {
    const run = createRunner({ timeoutMs: 5000, maxOutputBytes: 1024 })
    const result = await run(process.execPath, [
      "-e",
      "process.stdout.write('x'.repeat(100000))",
    ])
    expect(result).toEqual({
      ok: false,
      reason: "output-too-large",
      exitCode: null,
    })
  })

  it("gives the child a minimal environment", () => {
    const env = minimalEnvironment({
      PATH: "/usr/bin",
      SECRET_TOKEN: "hunter2",
      DESKVERSE_FFMPEG_PATH: "/opt/ffmpeg",
    })
    expect(env).toEqual({ PATH: "/usr/bin", LC_ALL: "C" })
  })

  it("classifies errors without keeping their messages", () => {
    const error = (props: object) =>
      Object.assign(new Error("spawn /secret/path ENOENT"), props)
    expect(classifyRunError(error({ code: "ENOENT" }))).toEqual({
      reason: "not-found",
      exitCode: null,
    })
    expect(classifyRunError(error({ code: "EACCES" })).reason).toBe(
      "not-executable",
    )
    expect(classifyRunError(error({ code: 1 }))).toEqual({
      reason: "failed",
      exitCode: 1,
    })
    expect(
      classifyRunError(error({ killed: true, signal: "SIGKILL" })).reason,
    ).toBe("timed-out")
  })
})

describe("localhost-only access", () => {
  const headers = (init: Record<string, string>) => new Headers(init)

  it("accepts requests from this machine", () => {
    for (const host of [
      "localhost:3000",
      "127.0.0.1:3210",
      "[::1]:3000",
      "localhost",
    ])
      expect(checkLocalRequest(headers({ host })).ok, host).toBe(true)
    expect(
      checkLocalRequest(
        headers({
          host: "localhost:3000",
          "x-forwarded-for": "::ffff:127.0.0.1",
          "x-forwarded-host": "localhost:3000",
          origin: "http://localhost:3000",
          "sec-fetch-site": "same-origin",
        }),
      ).ok,
    ).toBe(true)
  })

  it("rejects DNS-rebinding and LAN hosts", () => {
    for (const host of [
      "evil.example",
      "localhost.evil.example",
      "127.0.0.1.nip.io",
      "192.168.1.20:3000",
      "0.0.0.0:3000",
      "localhost:3000:80",
    ])
      expect(checkLocalRequest(headers({ host })), host).toEqual({
        ok: false,
        reason: "host",
      })
    expect(checkLocalRequest(new Headers()).ok).toBe(false)
  })

  it("rejects remote clients, foreign origins and cross-site fetches", () => {
    const base = { host: "localhost:3000" }
    expect(
      checkLocalRequest(headers({ ...base, "x-forwarded-for": "203.0.113.9" })),
    ).toEqual({
      ok: false,
      reason: "forwarded-for",
    })
    expect(
      checkLocalRequest(
        headers({ ...base, "x-forwarded-for": "127.0.0.1, 203.0.113.9" }),
      ).ok,
    ).toBe(false)
    expect(
      checkLocalRequest(
        headers({ ...base, "x-forwarded-host": "evil.example" }),
      ).ok,
    ).toBe(false)
    expect(
      checkLocalRequest(headers({ ...base, origin: "https://evil.example" }))
        .ok,
    ).toBe(false)
    expect(checkLocalRequest(headers({ ...base, origin: "null" })).ok).toBe(
      false,
    )
    expect(
      checkLocalRequest(headers({ ...base, "sec-fetch-site": "cross-site" }))
        .ok,
    ).toBe(false)
  })

  it("parses loopback hosts strictly", () => {
    expect(isLoopbackHost("127.1.2.3:80")).toBe(true)
    expect(isLoopbackHost("127.0.0.256")).toBe(false)
    expect(isLoopbackHost("[::1")).toBe(false)
    expect(isLoopbackHost("[::1]junk")).toBe(false)
    expect(isLoopbackHost("localhost:abc")).toBe(false)
  })
})
