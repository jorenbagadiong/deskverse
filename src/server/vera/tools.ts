import { resolveExecutable } from "@/server/video/ffmpeg-capabilities"
import { createRunner } from "@/server/process/run-executable"
export async function veraTools() {
  const ffmpeg = resolveExecutable("ffmpeg", process.env.DESKVERSE_FFMPEG_PATH)
  const ffprobe = resolveExecutable(
    "ffprobe",
    process.env.DESKVERSE_FFPROBE_PATH,
  )
  if (!ffmpeg.ok || !ffprobe.ok) return null
  const run = createRunner({ timeoutMs: 5000 })
  const results = await Promise.all([
    run(ffmpeg.command, ["-version"]),
    run(ffprobe.command, ["-version"]),
  ])
  return results.every((r) => r.ok)
    ? { ffmpeg: ffmpeg.command, ffprobe: ffprobe.command }
    : null
}
