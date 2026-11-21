import "server-only"

import path from "node:path"

import {
  AUDIO_FILTERS,
  EFFECT_FILTERS,
  REQUIRED_FILTERS,
  type CapabilityIssue,
  type EncoderInfo,
  type ExecutableProblem,
  type ExecutableStatus,
  type FfmpegCapabilityReport,
  type FfmpegLicense,
  type FilterStatus,
} from "@/lib/video/capabilities"
import { VIDEO_FORMAT } from "@/lib/video/format"
import { AAC_PREFERENCE, testAacEncodeArgs } from "@/server/video/audio-command"
import { encoderOptions } from "@/server/video/ffmpeg-command"
import {
  createRunner,
  type RunFailureReason,
  type Runner,
} from "@/server/process/run-executable"

/**
 * Inspects the local FFmpeg/FFprobe installation.
 *
 * Runs four fixed, read-only commands (`-version`, `-encoders`, `-filters`)
 * and parses their output. Never assumes libx264: it lists every H.264
 * encoder the build has and picks the best one.
 */

// ---------------------------------------------------------------------------
// Parsing (pure; unit-tested against captured output)
// ---------------------------------------------------------------------------

/** "ffmpeg version 6.1.1-3ubuntu5 Copyright …" → "6.1.1-3ubuntu5". */
export function parseVersion(
  output: string,
  program: "ffmpeg" | "ffprobe",
): string | null {
  const match = new RegExp(`^${program} version (\\S+)`, "m").exec(output)
  if (!match) return null
  // Keep only characters that appear in real version strings; cap the length.
  const version = match[1].replace(/[^\w.+~-]/g, "").slice(0, 64)
  return version.length > 0 ? version : null
}

/** Major version for comparisons: "6.1.1-3ubuntu5" → 6, "n7.0.2" → 7, git builds → null. */
export function parseMajorVersion(version: string | null) {
  const match = version ? /^n?(\d+)\.\d+/.exec(version) : null
  return match ? Number(match[1]) : null
}

export function parseLicense(versionOutput: string): FfmpegLicense {
  const line = /^\s*configuration:(.*)$/m.exec(versionOutput)?.[1]
  if (line === undefined) return "unknown"
  if (/(^|\s)--enable-nonfree(\s|$)/.test(line)) return "nonfree"
  if (/(^|\s)--enable-gpl(\s|$)/.test(line)) return "gpl"
  return "lgpl"
}

export interface ParsedEncoder {
  name: string
  type: "video" | "audio" | "subtitle"
  /** Codec the encoder produces: from "(codec h264)", else its own name. */
  codec: string
}

/**
 * Parses `ffmpeg -encoders`:
 *
 *    V....D libx264    libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 *    A....D aac        AAC (Advanced Audio Coding)
 */
export function parseEncoders(output: string): ParsedEncoder[] {
  const encoders: ParsedEncoder[] = []
  const body = output.split(/^\s*-{3,}\s*$/m).pop() ?? ""
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*([VAS])[A-Z.]{5}\s+([\w-]+)\s+(.*)$/.exec(line)
    if (!match) continue
    const [, kind, name, description] = match
    encoders.push({
      name,
      type: kind === "V" ? "video" : kind === "A" ? "audio" : "subtitle",
      codec: /\(codec (\w+)\)/.exec(description)?.[1] ?? name,
    })
  }
  return encoders
}

/**
 * Parses `ffmpeg -filters`:
 *
 *    T.C scale             V->V       Scale the input video size …
 *    ... concat            N->N       Concatenate audio and video streams.
 */
export function parseFilters(output: string): Set<string> {
  const filters = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*[A-Z.|]{2,3}\s+([\w-]+)\s+\S*->\S*\s/.exec(line)
    if (match) filters.add(match[1])
  }
  return filters
}

const HARDWARE_SUFFIX =
  /_(nvenc|qsv|amf|vaapi|videotoolbox|v4l2m2m|mf|omx|vulkan|rkmpp|mediacodec|d3d12va|cuvid)$/

/** H.264 encoders that can produce yuv420p (libx264rgb can't), best first. */
export function rankH264Encoders(
  encoders: readonly ParsedEncoder[],
): EncoderInfo[] {
  const h264 = encoders
    .filter(
      (e) =>
        e.type === "video" && e.codec === "h264" && e.name !== "libx264rgb",
    )
    .map((e): EncoderInfo => ({
      name: e.name,
      hardware: HARDWARE_SUFFIX.test(e.name),
      works: null,
    }))
  const rank = (e: EncoderInfo) =>
    e.name === "libx264" ? 0 : e.name === "libopenh264" ? 1 : e.hardware ? 3 : 2
  return h264.sort((a, b) => rank(a) - rank(b))
}

/**
 * A short real encode with the exact options and pixel format renders use,
 * discarded by the null muxer. Listing in `-encoders` only means "compiled
 * in"; hardware encoders in particular often fail without a GPU or drivers.
 */
export function testEncodeArgs(encoder: string) {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${VIDEO_FORMAT.width}x${VIDEO_FORMAT.height}:r=${VIDEO_FORMAT.fps}`,
    "-frames:v",
    "6",
    "-c:v",
    encoder,
    ...encoderOptions(encoder),
    "-pix_fmt",
    VIDEO_FORMAT.pixelFormat,
    "-f",
    "null",
    "-",
  ]
}

/** Test-encodes candidates in preference order until one works. */
export async function verifyEncoders(
  run: Runner,
  command: string,
  candidates: readonly EncoderInfo[],
): Promise<EncoderInfo[]> {
  const results = candidates.map((e) => ({
    ...e,
    works: null as boolean | null,
  }))
  for (const encoder of results) {
    const result = await run(command, testEncodeArgs(encoder.name))
    encoder.works = result.ok
    if (result.ok) break
  }
  return results
}

/** Listed AAC encoders, best first (native "aac" preferred). */
export function rankAacEncoders(encoders: readonly ParsedEncoder[]): string[] {
  const rank = (name: string) =>
    (AAC_PREFERENCE as readonly string[]).indexOf(name) + 1 || 99
  return encoders
    .filter((e) => e.type === "audio" && e.codec === "aac")
    .map((e) => e.name)
    .sort((a, b) => rank(a) - rank(b))
}

/** The best listed AAC encoder (not yet tested). */
export function pickAacEncoder(
  encoders: readonly ParsedEncoder[],
): string | null {
  return rankAacEncoders(encoders)[0] ?? null
}

/** Test-encodes AAC candidates in order; returns the first that works. */
export async function verifyAacEncoder(
  run: Runner,
  command: string,
  candidates: readonly string[],
): Promise<string | null> {
  for (const name of candidates)
    if ((await run(command, testAacEncodeArgs(name))).ok) return name
  return null
}

// ---------------------------------------------------------------------------
// Executable resolution
// ---------------------------------------------------------------------------

export type ExecutableResolution =
  | { ok: true; command: string }
  | { ok: false; problem: "invalid-configuration" }

/**
 * By default the programs are looked up on PATH by name. An override
 * (DESKVERSE_FFMPEG_PATH / DESKVERSE_FFPROBE_PATH) must be an absolute path
 * whose file name is the expected program, so it can't point at `sh` or a
 * relative path. The resolved command is used server-side only.
 */
export function resolveExecutable(
  program: "ffmpeg" | "ffprobe",
  override: string | undefined,
): ExecutableResolution {
  if (override === undefined || override.trim() === "")
    return { ok: true, command: program }
  const value = override.trim()
  const isAbsolute = path.isAbsolute(value) || path.win32.isAbsolute(value)
  const base = value.split(/[\\/]/).pop() ?? ""
  const expected = new RegExp(`^${program}(\\.exe)?$`, "i")
  if (!isAbsolute || !expected.test(base) || /[\0\r\n]/.test(value))
    return { ok: false, problem: "invalid-configuration" }
  return { ok: true, command: value }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface DetectOptions {
  run?: Runner
  env?: Readonly<Record<string, string | undefined>>
  now?: () => Date
}

const PROBLEM_FOR_REASON: Record<RunFailureReason, ExecutableProblem> = {
  "not-found": "not-found",
  "not-executable": "not-executable",
  "timed-out": "timed-out",
  failed: "failed",
  "output-too-large": "unrecognized-output",
  // Detection is never cancelled; listed for completeness.
  cancelled: "failed",
}

async function probeVersion(
  run: Runner,
  resolution: ExecutableResolution,
  program: "ffmpeg" | "ffprobe",
): Promise<{
  status: ExecutableStatus
  output: string
  command: string | null
}> {
  if (!resolution.ok)
    return {
      status: { available: false, version: null, problem: resolution.problem },
      output: "",
      command: null,
    }
  const result = await run(resolution.command, ["-hide_banner", "-version"])
  if (!result.ok)
    return {
      status: {
        available: false,
        version: null,
        problem: PROBLEM_FOR_REASON[result.reason],
      },
      output: "",
      command: null,
    }
  const version = parseVersion(result.stdout, program)
  if (version === null)
    return {
      status: {
        available: false,
        version: null,
        problem: "unrecognized-output",
      },
      output: "",
      command: null,
    }
  return {
    status: { available: true, version, problem: null },
    output: result.stdout,
    command: resolution.command,
  }
}

const MISSING_HELP =
  "Install it in your WSL Ubuntu terminal with: sudo apt install ffmpeg. Then select Check again."

function executableIssue(
  program: "FFmpeg" | "FFprobe",
  problem: ExecutableProblem,
): CapabilityIssue {
  const missingCode =
    program === "FFmpeg" ? "ffmpeg-missing" : "ffprobe-missing"
  const unusableCode =
    program === "FFmpeg" ? "ffmpeg-unusable" : "ffprobe-unusable"
  switch (problem) {
    case "not-found":
      return {
        code: missingCode,
        severity: "error",
        message: `${program} wasn't found on this computer. ${MISSING_HELP}`,
      }
    case "invalid-configuration":
      return {
        code: "invalid-configuration",
        severity: "error",
        message: `The configured ${program} location isn't valid. It must be an absolute path to the ${program.toLowerCase()} program itself. Fix or remove DESKVERSE_${program.toUpperCase()}_PATH and restart the server.`,
      }
    case "not-executable":
      return {
        code: unusableCode,
        severity: "error",
        message: `${program} was found but couldn't be started (permission denied). Reinstall it or check its file permissions.`,
      }
    case "timed-out":
      return {
        code: unusableCode,
        severity: "error",
        message: `${program} didn't respond within 5 seconds. Try again; if it keeps happening, reinstall it.`,
      }
    case "failed":
    case "unrecognized-output":
      return {
        code: unusableCode,
        severity: "error",
        message: `${program} started but didn't report a version, so it may be broken or not the real ${program}. Reinstall it.`,
      }
  }
}

export async function detectFfmpegCapabilities({
  run = createRunner(),
  env = process.env,
  now = () => new Date(),
}: DetectOptions = {}): Promise<FfmpegCapabilityReport> {
  const [ffmpeg, ffprobe] = await Promise.all([
    probeVersion(
      run,
      resolveExecutable("ffmpeg", env.DESKVERSE_FFMPEG_PATH),
      "ffmpeg",
    ),
    probeVersion(
      run,
      resolveExecutable("ffprobe", env.DESKVERSE_FFPROBE_PATH),
      "ffprobe",
    ),
  ])

  const issues: CapabilityIssue[] = []
  if (ffmpeg.status.problem)
    issues.push(executableIssue("FFmpeg", ffmpeg.status.problem))
  if (ffprobe.status.problem)
    issues.push(executableIssue("FFprobe", ffprobe.status.problem))

  let filters: FilterStatus[] = []
  let h264Encoders: EncoderInfo[] = []
  let aacEncoder: string | null = null
  let license: FfmpegLicense = "unknown"
  let audio: FfmpegCapabilityReport["audio"] = {
    ready: false,
    missingFilters: [],
    reason: "FFmpeg isn't available, so audio can't be added.",
  }

  if (ffmpeg.command) {
    const [encoderResult, filterResult] = await Promise.all([
      run(ffmpeg.command, ["-hide_banner", "-encoders"]),
      run(ffmpeg.command, ["-hide_banner", "-filters"]),
    ])
    const encoders = encoderResult.ok ? parseEncoders(encoderResult.stdout) : []
    const available = filterResult.ok
      ? parseFilters(filterResult.stdout)
      : new Set<string>()
    license = parseLicense(ffmpeg.output)

    filters = [
      ...REQUIRED_FILTERS.map((name) => ({
        name,
        available: available.has(name),
        required: true,
        purpose: "video" as const,
      })),
      ...EFFECT_FILTERS.map((name) => ({
        name,
        available: available.has(name),
        required: false,
        purpose: "video" as const,
      })),
      ...AUDIO_FILTERS.map((name) => ({
        name,
        available: available.has(name),
        required: true,
        purpose: "audio" as const,
      })),
    ]
    h264Encoders = await verifyEncoders(
      run,
      ffmpeg.command,
      rankH264Encoders(encoders),
    )
    // Listed isn't proof: the AAC encoder must pass a real test encode.
    const aacCandidates = rankAacEncoders(encoders)
    aacEncoder = await verifyAacEncoder(run, ffmpeg.command, aacCandidates)

    const missingRequired = filters
      .filter((f) => f.purpose === "video" && f.required && !f.available)
      .map((f) => f.name)
    const missingAudio = filters
      .filter((f) => f.purpose === "audio" && !f.available)
      .map((f) => f.name)
    audio = {
      ready: aacEncoder !== null && missingAudio.length === 0,
      missingFilters: missingAudio,
      reason:
        aacEncoder === null
          ? aacCandidates.length === 0
            ? "This FFmpeg build has no AAC encoder, so videos can only be silent."
            : `The AAC encoder (${aacCandidates.join(", ")}) failed a test encode, so videos can only be silent.`
          : missingAudio.length > 0
            ? `This FFmpeg build is missing audio filters (${missingAudio.join(", ")}), so videos can only be silent.`
            : null,
    }
    if (missingRequired.length > 0)
      issues.push({
        code: "missing-filters",
        severity: "error",
        message: `This FFmpeg build is missing required filters: ${missingRequired.join(", ")}. ${
          missingRequired.includes("drawtext")
            ? "drawtext needs a build with libfreetype; the Ubuntu ffmpeg package includes it. "
            : ""
        }Install a full build (for example with: sudo apt install ffmpeg).`,
      })

    if (h264Encoders.length === 0)
      issues.push({
        code: "no-h264-encoder",
        severity: "error",
        message:
          "This FFmpeg build has no H.264 encoder, so it can't produce MP4 videos that play everywhere. Install a build with libx264 or libopenh264.",
      })
    else if (!h264Encoders.some((e) => e.works)) {
      issues.push({
        code: "no-working-encoder",
        severity: "error",
        message: `None of this FFmpeg's H.264 encoders (${h264Encoders.map((e) => e.name).join(", ")}) could encode a test video, so rendering can't work. Install a build with libx264 (for example with: sudo apt install ffmpeg).`,
      })
    } else if (h264Encoders.find((e) => e.works)?.name !== "libx264") {
      const best = h264Encoders.find((e) => e.works)!
      issues.push(
        best.hardware
          ? {
              code: "hardware-encoder-only",
              severity: "warning",
              message: `libx264 isn't available or didn't work, so the hardware encoder ${best.name} will be used. It passed a test encode, but it depends on your GPU drivers.`,
            }
          : {
              code: "no-libx264",
              severity: "warning",
              message: `libx264 isn't available or didn't work; ${best.name} will be used instead. Quality per megabyte may be lower.`,
            },
      )
    }

    // Audio problems never block silent rendering: warnings only.
    if (aacEncoder === null)
      issues.push({
        code: "no-aac-encoder",
        severity: "warning",
        message: `${audio.reason} Silent videos still render normally.`,
      })
    else if (missingAudio.length > 0)
      issues.push({
        code: "audio-unavailable",
        severity: "warning",
        message: `${audio.reason} Silent videos still render normally.`,
      })

    const major = parseMajorVersion(ffmpeg.status.version)
    if (major !== null && major < 5)
      issues.push({
        code: "old-version",
        severity: "warning",
        message: `FFmpeg ${ffmpeg.status.version} is older than 5.0 and hasn't been tested with Deskverse.`,
      })

    if (license === "nonfree")
      issues.push({
        code: "nonfree-build",
        severity: "warning",
        message:
          "This FFmpeg build is configured with --enable-nonfree. It's fine to use locally, but it can't be redistributed.",
      })
  }

  const blocking = issues.some((i) => i.severity === "error")
  const missing = !ffmpeg.status.available || !ffprobe.status.available

  return {
    status: missing ? "missing" : blocking ? "unsupported" : "ready",
    checkedAt: now().toISOString(),
    ffmpeg: ffmpeg.status,
    ffprobe: ffprobe.status,
    filters,
    h264Encoders,
    selectedH264Encoder: h264Encoders.find((e) => e.works)?.name ?? null,
    aacEncoder,
    audio,
    license,
    issues,
  }
}

// ---------------------------------------------------------------------------
// Cache: one detection at a time, reused briefly.
// ---------------------------------------------------------------------------

const CACHE_MS = 30_000
let cached: { report: FfmpegCapabilityReport; at: number } | null = null
let inFlight: Promise<FfmpegCapabilityReport> | null = null

export async function getFfmpegCapabilities({
  refresh = false,
}: { refresh?: boolean } = {}): Promise<FfmpegCapabilityReport> {
  if (!refresh && cached && Date.now() - cached.at < CACHE_MS)
    return cached.report
  if (inFlight) return inFlight
  inFlight = detectFfmpegCapabilities()
    .then((report) => {
      cached = { report, at: Date.now() }
      return report
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}
