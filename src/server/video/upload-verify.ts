import "server-only"

import type { RenderJob } from "@/lib/video/render-job"
import { videoEndpoint, type RenderJobStatus } from "@/lib/video/render-api"
import type { RenderProgress } from "@/lib/video/render-job"
import type { Runner } from "@/server/process/run-executable"
import {
  imageDecodeArgs,
  imageProbeArgs,
  parseImageProbe,
} from "@/server/video/ffprobe"
import { StorageError, type UploadVerifier } from "@/server/video/storage"

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
  return async (filePath, asset) => {
    const reject = (reason: string) => {
      throw new StorageError(
        "invalid-upload",
        `“${asset.displayName}” couldn't be verified: ${reason}`,
      )
    }
    const probe = await run(commands.ffprobe, imageProbeArgs(filePath))
    if (!probe.ok) reject("FFprobe couldn't read it.")
    else {
      const parsed = parseImageProbe(probe.stdout, asset)
      if (!parsed.ok) reject(parsed.reason)
    }
    const decode = await run(commands.ffmpeg, imageDecodeArgs(filePath))
    if (!decode.ok || decode.stderr.trim() !== "")
      reject("it doesn't decode cleanly (the file may be damaged).")
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
