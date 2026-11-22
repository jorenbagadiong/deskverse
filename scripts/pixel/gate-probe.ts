import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

import { spawnTool } from "@/server/process/run-executable"
import { GateCancelled, RenderGate } from "@/server/video/render-gate"

/**
 * TEST TOOL (DV-005C): one process that takes the installation's render
 * gate and runs a REAL FFmpeg encode through it, printing JSON lines with
 * wall-clock times so tests can prove renders never overlap across
 * processes. Never touches real Deskverse data: --data is a temp folder.
 *
 *   --data DIR       data folder whose locks/render.lock is the gate
 *   --kind K         studio | ticket (owner kind)
 *   --seconds N      length of the encoded test clip (default 1.5)
 *   --crash          SIGKILL this process right after FFmpeg starts
 *   --cancel-ms M    abort while waiting for the gate after M ms
 *   --cwd DIR        run FFmpeg in DIR (e.g. inside a Studio job folder)
 */
const { values } = parseArgs({
  options: {
    data: { type: "string" },
    kind: { type: "string", default: "studio" },
    seconds: { type: "string", default: "1.5" },
    crash: { type: "boolean" },
    "cancel-ms": { type: "string" },
    cwd: { type: "string" },
  },
})
const out = (event: Record<string, unknown>) =>
  process.stdout.write(
    `${JSON.stringify({ pid: process.pid, t: Date.now(), ...event })}\n`,
  )

async function main() {
  const gate = new RenderGate(values.data!)
  const controller = new AbortController()
  if (values["cancel-ms"])
    setTimeout(() => controller.abort(), Number(values["cancel-ms"]))
  out({ event: "waiting" })
  let lease
  try {
    lease = await gate.acquire(
      {
        kind: values.kind === "ticket" ? "ticket" : "studio",
        jobId: `probe-${process.pid}`,
        storageRoot: values.data!,
      },
      controller.signal,
    )
  } catch (error) {
    if (error instanceof GateCancelled) {
      out({ event: "cancelled-waiting" })
      return
    }
    throw error
  }
  out({ event: "acquired" })
  const work =
    values.cwd ??
    (await mkdtemp(path.join(os.tmpdir(), "deskverse-gate-probe-")))
  try {
    const spawn = lease.wrap((command, args, options) => {
      const promise = spawnTool(command, args, options)
      return promise
    })
    const started = Date.now()
    const run = spawn(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        // Real time: the encode really lasts --seconds (a stand-in render).
        "-re",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x360:rate=30",
        "-t",
        values.seconds!,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-y",
        "clip.mp4",
      ],
      { cwd: work, timeoutMs: 120_000 },
    )
    // The FFmpeg child is the newest process we started; report its PID.
    await new Promise((r) => setTimeout(r, 150))
    const { execFileSync } = await import("node:child_process")
    let child: number | null = null
    try {
      child = Number(
        execFileSync("pgrep", ["-P", String(process.pid), "-x", "ffmpeg"], {
          encoding: "utf8",
        })
          .trim()
          .split("\n")[0],
      )
    } catch {
      child = null // already finished
    }
    out({ event: "ffmpeg-start", ffmpegPid: child, startedAt: started })
    if (values.crash) process.kill(process.pid, "SIGKILL")
    const result = await run
    out({ event: "ffmpeg-end", ok: result.ok })
  } finally {
    await lease.release()
    out({ event: "released" })
    if (!values.cwd) await rm(work, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  out({
    event: "error",
    message: error instanceof Error ? error.message : String(error),
  })
  process.exit(1)
})
