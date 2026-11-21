import "server-only"

import { promises as fs } from "node:fs"
import path from "node:path"

import type { FfmpegCapabilityReport } from "@/lib/video/capabilities"
import { VIDEO_FORMAT } from "@/lib/video/format"
import type {
  RenderJobErrorCode,
  RenderOutput,
  RenderProgress,
} from "@/lib/video/render-job"
import type { Runner, Spawner } from "@/server/process/run-executable"
import { buildRenderPlan, encoderOptions } from "@/server/video/ffmpeg-command"
import {
  buildAudioPlan,
  loudnessMeasureArgs,
  loudnessTarget,
  parseLoudnormJson,
} from "@/server/video/audio-command"
import {
  createProgressParser,
  outputAudioDecodeArgs,
  outputProbeArgs,
  verifyOutputProbe,
  type VerifiedOutput,
} from "@/server/video/ffprobe"
import {
  VIDEO_FONTS,
  type FontMetrics,
  type VideoFontWeight,
} from "@/server/video/font-metrics"
import {
  resolveInside,
  StorageError,
  type VideoStorage,
} from "@/server/video/storage"

/** A failure with a message written for the user (no paths, no raw output). */
export class RenderFailure extends Error {
  constructor(
    readonly code: RenderJobErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "RenderFailure"
  }
}

export interface RenderDeps {
  storage: VideoStorage
  spawn: Spawner
  run: Runner
  getCapabilities: () => Promise<FfmpegCapabilityReport>
  commands: { ffmpeg: string; ffprobe: string }
  fonts: Record<VideoFontWeight, FontMetrics>
  fontDir: string
  threads: number
  /** audioMs bounds each audio step (measurement, mix); default 2 minutes. */
  timeouts: { sceneMs: number; encodeMs: number; audioMs?: number }
  clock?: () => number
  /** Server-side diagnostics (may include local paths; never sent to clients). */
  log?: (message: string) => void
}

/**
 * FFprobe verification of a file in the work directory, plus (for audio) a
 * full decode of the AAC track: metadata alone doesn't prove it plays.
 */
async function verify(
  deps: RenderDeps,
  file: string,
  totalFrames: number,
  expectAudio: boolean,
): Promise<VerifiedOutput> {
  const probe = await deps.run(deps.commands.ffprobe, outputProbeArgs(file))
  if (!probe.ok)
    throw new RenderFailure(
      "verification-failed",
      "FFprobe couldn't read the finished video, so it wasn't kept.",
    )
  const verified = verifyOutputProbe(probe.stdout, totalFrames, { expectAudio })
  if (!verified.ok)
    throw new RenderFailure(
      "verification-failed",
      `The finished video didn't pass verification (${verified.problems.join("; ")}), so it wasn't kept.`,
    )
  if (expectAudio) {
    const decoded = await deps.run(
      deps.commands.ffmpeg,
      outputAudioDecodeArgs(file),
    )
    if (!decoded.ok || decoded.stderr.trim() !== "")
      throw new RenderFailure(
        "verification-failed",
        "The finished video's audio didn't decode cleanly, so it wasn't kept.",
      )
  }
  return verified.value
}

/**
 * Renders one queued job end to end and returns FFprobe-verified facts about
 * the result. The job's state transitions are the queue's responsibility;
 * this only reads the project and writes inside the job's own directory.
 */
export async function renderVideo(
  jobId: string,
  deps: RenderDeps,
  onProgress: (progress: RenderProgress) => void,
): Promise<RenderOutput> {
  const clock = deps.clock ?? Date.now
  const started = clock()
  const { storage } = deps
  onProgress({ phase: "preparing" })

  // 1. Prerequisites: FFmpeg ready, with an encoder that passed a test encode.
  const capabilities = await deps.getCapabilities()
  if (capabilities.status !== "ready" || !capabilities.selectedH264Encoder) {
    const issue = capabilities.issues.find((i) => i.severity === "error")
    throw new RenderFailure(
      capabilities.status === "ready"
        ? "no-working-encoder"
        : "ffmpeg-unavailable",
      issue?.message ?? "FFmpeg isn't ready to render on this computer.",
    )
  }
  const encoderName = capabilities.selectedH264Encoder

  // 2. The server-built project, re-validated against this job's own assets.
  let project
  try {
    project = await storage.readProject(jobId)
  } catch {
    throw new RenderFailure(
      "invalid-project",
      "This video's project couldn't be read. Start a new render.",
    )
  }
  const assetPaths = new Map<string, string>()
  for (const asset of project.assets)
    assetPaths.set(asset.id, await storage.assetPath(jobId, asset.id))

  // Audio prerequisites are checked before any encoding, so a missing AAC
  // encoder fails fast. Silent projects never depend on them.
  const audioConfig =
    project.audio && project.audio.mode !== "none" ? project.audio : null
  if (audioConfig && (!capabilities.audio.ready || !capabilities.aacEncoder))
    throw new RenderFailure(
      "audio-unavailable",
      capabilities.audio.reason ??
        "This FFmpeg can't encode AAC audio, so the video can't include sound. Choose No audio, or install a full FFmpeg build.",
    )

  const plan = buildRenderPlan({
    project,
    assetPaths,
    fonts: deps.fonts,
    encoder: { name: encoderName, options: encoderOptions(encoderName) },
    threads: deps.threads,
  })

  // 3. Private scratch space: fonts and caption files, by generated names.
  await storage.cleanupWork(jobId)
  const work = await storage.workDir(jobId)
  try {
    for (const font of plan.fonts)
      await fs.copyFile(
        path.join(deps.fontDir, VIDEO_FONTS[font.weight]),
        resolveInside(work, font.name),
      )
    for (const scene of plan.scenes)
      for (const file of scene.textFiles)
        await fs.writeFile(resolveInside(work, file.name), file.content, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        })

    // 4. One still frame per scene.
    for (const [index, scene] of plan.scenes.entries()) {
      onProgress({
        phase: "composing",
        completedScenes: index,
        totalScenes: plan.scenes.length,
      })
      const result = await deps.spawn(deps.commands.ffmpeg, scene.args, {
        cwd: work,
        timeoutMs: deps.timeouts.sceneMs,
      })
      if (!result.ok) {
        deps.log?.(
          `[pixel] ${jobId} scene ${index + 1} failed (${result.reason}): ${result.stderrTail}`,
        )
        throw new RenderFailure(
          result.reason === "timed-out" ? "timed-out" : "render-failed",
          result.reason === "timed-out"
            ? `Preparing scene ${index + 1} took too long and was stopped.`
            : `FFmpeg couldn't prepare scene ${index + 1}. Check that the image opens on your computer, or try a different one.`,
        )
      }
    }
    onProgress({
      phase: "composing",
      completedScenes: plan.scenes.length,
      totalScenes: plan.scenes.length,
    })

    // 5. Encode, with progress from FFmpeg's own -progress output.
    const totalSeconds = plan.totalFrames / VIDEO_FORMAT.fps
    onProgress({
      phase: "encoding",
      fraction: 0,
      encodedSeconds: 0,
      totalSeconds,
    })
    const parse = createProgressParser(({ encodedSeconds }) =>
      onProgress({
        phase: "encoding",
        fraction: Math.min(Math.max(encodedSeconds / totalSeconds, 0), 1),
        encodedSeconds: Math.min(encodedSeconds, totalSeconds),
        totalSeconds,
      }),
    )
    const encoded = await deps.spawn(deps.commands.ffmpeg, plan.encode.args, {
      cwd: work,
      timeoutMs: deps.timeouts.encodeMs,
      onStdout: parse,
    })
    if (!encoded.ok) {
      deps.log?.(
        `[pixel] ${jobId} encode with ${encoderName} failed (${encoded.reason}): ${encoded.stderrTail}`,
      )
      throw new RenderFailure(
        encoded.reason === "timed-out" ? "timed-out" : "render-failed",
        encoded.reason === "timed-out"
          ? `Encoding took longer than ${Math.round(deps.timeouts.encodeMs / 60000)} minutes and was stopped.`
          : `The ${encoderName} encoder failed while encoding the video.`,
      )
    }

    // 6. Verify the encoded picture before anything else is built on it.
    onProgress({ phase: "verifying" })
    let verified = await verify(
      deps,
      resolveInside(work, plan.encode.output),
      plan.totalFrames,
      false,
    )
    let published = plan.encode.output

    // 7. Audio (DV-003C): mix the user's files and mux them with the copied
    // H.264 stream, then verify the result again, now with its AAC track.
    if (audioConfig) {
      onProgress({ phase: "audio", step: "measuring", fraction: null })
      const audioMs = deps.timeouts.audioMs ?? 120_000
      const source = async (assetId: string | null) => {
        if (!assetId) return null
        const asset = project.audioAssets?.find((a) => a.id === assetId)
        if (!asset)
          throw new RenderFailure(
            "invalid-project",
            "An audio file of this video is missing. Start a new render.",
          )
        const path = await storage.audioAssetPath(jobId, asset.id)
        const measured = await deps.spawn(
          deps.commands.ffmpeg,
          loudnessMeasureArgs(
            asset,
            path,
            plan.totalFrames,
            loudnessTarget(asset.role, audioConfig),
          ),
          { cwd: work, timeoutMs: audioMs },
        )
        const measurement = measured.ok
          ? parseLoudnormJson(measured.stderrTail)
          : null
        if (!measurement) {
          deps.log?.(
            `[pixel] ${jobId} loudness measurement of ${asset.role} failed: ${measured.stderrTail.slice(-2000)}`,
          )
          throw new RenderFailure(
            "audio-failed",
            `The ${asset.role === "voiceover" ? "voiceover" : "background music"} seems to be silent or couldn't be measured. Check the file plays and isn't silent.`,
          )
        }
        return { asset, path, measurement }
      }
      const audioPlan = buildAudioPlan({
        config: audioConfig,
        voiceover: await source(audioConfig.voiceoverAssetId),
        music: await source(audioConfig.musicAssetId),
        totalFrames: plan.totalFrames,
        aacEncoder: capabilities.aacEncoder!,
        videoFile: plan.encode.output,
      })
      onProgress({ phase: "audio", step: "mixing", fraction: 0 })
      const parseMix = createProgressParser(({ encodedSeconds }) =>
        onProgress({
          phase: "audio",
          step: "mixing",
          fraction: Math.min(
            Math.max(encodedSeconds / audioPlan.totalSeconds, 0),
            1,
          ),
        }),
      )
      const mixed = await deps.spawn(deps.commands.ffmpeg, audioPlan.args, {
        cwd: work,
        timeoutMs: audioMs,
        onStdout: parseMix,
      })
      if (!mixed.ok) {
        deps.log?.(
          `[pixel] ${jobId} audio mix failed (${mixed.reason}): ${mixed.stderrTail}`,
        )
        throw new RenderFailure(
          mixed.reason === "timed-out" ? "timed-out" : "audio-failed",
          mixed.reason === "timed-out"
            ? "Adding the audio took too long and was stopped."
            : "FFmpeg couldn't add the audio to the video. Try different audio files.",
        )
      }
      onProgress({ phase: "verifying" })
      verified = await verify(
        deps,
        resolveInside(work, audioPlan.output),
        plan.totalFrames,
        true,
      )
      published = audioPlan.output
    }

    // 8. Publish into output/ (atomic rename inside the job directory).
    await storage.commitOutput(jobId, published)
    return {
      audio: verified.audio,
      fileName: "video.mp4",
      sizeBytes: verified.sizeBytes,
      durationSeconds: verified.durationSeconds,
      width: verified.width,
      height: verified.height,
      fps: verified.fps,
      videoCodec: verified.videoCodec,
      pixelFormat: verified.pixelFormat,
      encoder: encoderName,
      renderSeconds: Math.round((clock() - started) / 100) / 10,
    }
  } catch (error) {
    if (error instanceof RenderFailure) throw error
    deps.log?.(`[pixel] ${jobId} unexpected render error: ${String(error)}`)
    throw new RenderFailure(
      error instanceof StorageError ? "invalid-project" : "render-failed",
      "Rendering stopped because of an unexpected error. Try again.",
    )
  } finally {
    // Nothing temporary survives a render, successful or not.
    await storage.cleanupWork(jobId).catch(() => undefined)
  }
}
