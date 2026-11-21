import "server-only"

import type { RenderJob } from "@/lib/video/render-job"
import { videoEndpoint, type RenderJobStatus } from "@/lib/video/render-api"
import type { RenderProgress } from "@/lib/video/render-job"
import type { Runner } from "@/server/process/run-executable"
import {
  audioDecodeArgs,
  audioProbeArgs,
  imageDecodeArgs,
  imageProbeArgs,
  parseAudioProbe,
  parseImageProbe,
} from "@/server/video/ffprobe"
import {
  StorageError,
  type AudioInspector,
  type UploadVerifier,
} from "@/server/video/storage"

/**
 * Second-line upload check, after byte sniffing and header dimensions:
 * FFprobe must agree on the codec and size, and FFmpeg must decode the first
 * frame without errors (catches truncated or corrupt files that still have a
 * valid header).
 */
export function createUploadVerifier(
  run: Runner,
  commands: { ffmpeg: string; ffprobe: string },
): UploadVerifier {
  return async (filePath, asset, stored) => {
    const reject = (reason: string) => {
      throw new StorageError(
        "invalid-upload",
        `“${asset.displayName}” couldn't be verified: ${reason}`,
      )
    }
    const probe = await run(commands.ffprobe, imageProbeArgs(filePath))
    if (!probe.ok) reject("FFprobe couldn't read it.")
    else {
      // FFprobe reports the stored size, before any EXIF orientation.
      const parsed = parseImageProbe(probe.stdout, {
        mimeType: asset.mimeType,
        ...stored,
      })
      if (!parsed.ok) reject(parsed.reason)
    }
    const decode = await run(commands.ffmpeg, imageDecodeArgs(filePath))
    if (!decode.ok || decode.stderr.trim() !== "")
      reject("it doesn't decode cleanly (the file may be damaged).")
  }
}

/**
 * Audio upload check (DV-003C): FFprobe must find exactly one audio stream
 * with an accepted codec in the sniffed container (no video, cover art or
 * other streams), and FFmpeg must decode the whole stream without errors.
 * Returns the probed facts; the caller checks them against the limits.
 */
export function createAudioInspector(
  run: Runner,
  commands: { ffmpeg: string; ffprobe: string },
): AudioInspector {
  return async (filePath, container, displayName) => {
    const reject = (reason: string): never => {
      throw new StorageError(
        "invalid-upload",
        `“${displayName}” couldn't be used: ${reason}`,
      )
    }
    const probe = await run(
      commands.ffprobe,
      audioProbeArgs(filePath, container),
    )
    if (!probe.ok) reject("FFprobe couldn't read it.")
    const parsed = parseAudioProbe(probe.ok ? probe.stdout : "", container)
    if (!parsed.ok) return reject(parsed.reason)
    const decode = await run(
      commands.ffmpeg,
      audioDecodeArgs(filePath, container),
    )
    if (!decode.ok || decode.stderr.trim() !== "")
      reject("it doesn't decode cleanly (the file may be damaged).")
    return parsed.value
  }
}

/** Public status of a job: no paths, only verified output facts. */
export function jobStatus(
  job: RenderJob,
  progress: RenderProgress | null,
): RenderJobStatus {
  const done = job.state === "completed" && job.output !== null
  return {
    jobId: job.id,
    state: job.state,
    progress:
      job.state === "queued" || job.state === "rendering" ? progress : null,
    error: job.state === "failed" ? job.error : null,
    output: done ? job.output : null,
    videoUrl: done ? videoEndpoint(job.id) : null,
    downloadUrl: done ? videoEndpoint(job.id, true) : null,
  }
}
