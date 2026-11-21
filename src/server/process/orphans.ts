import "server-only"

import { promises as fs } from "node:fs"
import path from "node:path"

/**
 * Stops FFmpeg/FFprobe processes left behind by a previous server process
 * (for example after the server was killed mid-render). Linux/WSL only: it
 * reads /proc and only touches processes that
 *
 * - belong to this user (others' /proc entries can't be read),
 * - are ffmpeg or ffprobe, and
 * - run with their working directory inside Pixel Studio's private job
 *   storage (renders always run with cwd = the job's work directory).
 *
 * Anything else is left alone. Returns the stopped process IDs.
 *
 * The /proc reads are runtime OS paths, not project files, so they're marked
 * `turbopackIgnore` to keep Next's output tracing from including the project.
 */
export async function stopOrphanedRenders(
  jobsDir: string,
  {
    procRoot = "/proc",
    waitMs = 2000,
  }: { procRoot?: string; waitMs?: number } = {},
): Promise<number[]> {
  if (process.platform !== "linux") return []
  let root: string
  try {
    root = await fs.realpath(/*turbopackIgnore: true*/ jobsDir)
  } catch {
    return [] // no jobs yet
  }
  let entries: string[]
  try {
    entries = await fs.readdir(/*turbopackIgnore: true*/ procRoot)
  } catch {
    return []
  }
  const stopped: number[] = []
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (pid === process.pid) continue
    try {
      const cwd = await fs.readlink(
        /*turbopackIgnore: true*/ path.join(procRoot, name, "cwd"),
      )
      if (cwd !== root && !cwd.startsWith(root + path.sep)) continue
      const cmdline = await fs.readFile(
        /*turbopackIgnore: true*/ path.join(procRoot, name, "cmdline"),
        "utf8",
      )
      const program = path.basename(cmdline.split("\0")[0] ?? "")
      if (program !== "ffmpeg" && program !== "ffprobe") continue
      process.kill(pid, "SIGKILL")
      stopped.push(pid)
    } catch {
      // Gone already, or not ours to inspect.
    }
  }
  // Wait (bounded) until they have really exited before cleanup continues.
  const deadline = Date.now() + waitMs
  for (const pid of stopped) {
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
        await new Promise((resolve) => setTimeout(resolve, 25))
      } catch {
        break
      }
    }
  }
  return stopped
}
