import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { stopAbandonedRenders } from "@/server/video/render-queue"
import { RenderGate } from "@/server/video/render-gate"

/**
 * DV-005C: the installation-wide render gate with REAL FFmpeg processes in
 * separate Node processes (Studio-kind and ticket-kind owners). Proves real
 * encodes never overlap, including after SIGKILL, cancellation and Studio
 * startup recovery, and that unrelated FFmpeg processes are never touched.
 */

let data = ""
beforeAll(async () => {
  data = await mkdtemp(path.join(os.tmpdir(), "deskverse-gate-it-"))
})
afterAll(async () => {
  if (data) await rm(data, { recursive: true, force: true })
})

interface Event {
  pid: number
  t: number
  event: string
  ffmpegPid?: number
  startedAt?: number
  ok?: boolean
}

function probe(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./scripts/server-only-hook.mjs",
      "scripts/pixel/gate-probe.ts",
      "--data",
      data,
      ...args,
    ],
    { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
  )
  const events: Event[] = []
  let buffer = ""
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString()
    for (let i; (i = buffer.indexOf("\n")) >= 0;) {
      events.push(JSON.parse(buffer.slice(0, i)))
      buffer = buffer.slice(i + 1)
    }
  })
  child.stderr!.on("data", () => {})
  const exited = new Promise<number | string | null>((resolve) =>
    child.on("exit", (code, signal) => resolve(code ?? signal)),
  )
  const waitFor = async (name: string, timeoutMs = 60_000) => {
    const end = Date.now() + timeoutMs
    for (;;) {
      const e = events.find((x) => x.event === name)
      if (e) return e
      if (Date.now() > end)
        throw new Error(
          `probe never reported ${name}: ${JSON.stringify(events)}`,
        )
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  return { child, events, exited, waitFor }
}

/** Gone, or a zombie (it has exited; its fds, and so its lock, are closed). */
function dead(pid: number) {
  if (!existsSync(`/proc/${pid}`)) return true
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] === "Z"
  } catch {
    return true
  }
}

type Interval = { start: number; end: number; who: string }
function noOverlap(intervals: Interval[]) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i].start < sorted[i - 1].end)
      throw new Error(
        `overlap: ${JSON.stringify(sorted[i - 1])} and ${JSON.stringify(sorted[i])}`,
      )
  return true
}

const intervalsOf = (probes: ReturnType<typeof probe>[], label: string) =>
  probes.map((p, i) => {
    const start = p.events.find((e) => e.event === "ffmpeg-start")!
    const end = p.events.find((e) => e.event === "ffmpeg-end")!
    expect(end.ok, `${label} #${i} encode`).toBe(true)
    return { start: start.startedAt!, end: end.t, who: `${label}#${i}` }
  })

describe(
  "render gate across processes (real FFmpeg)",
  { timeout: 120_000 },
  () => {
    it.each([
      ["Studio vs Studio", ["studio", "studio"]],
      ["Studio vs ticket worker", ["studio", "ticket"]],
      ["ticket worker vs ticket worker", ["ticket", "ticket"]],
      [
        "several workers and Studio servers at once",
        ["ticket", "studio", "ticket", "studio", "ticket"],
      ],
    ])("%s: encodes never overlap", async (label, kinds) => {
      const probes = kinds.map((k) => probe(["--kind", k, "--seconds", "1.5"]))
      await Promise.all(probes.map((p) => p.exited))
      for (const p of probes)
        expect(p.events.map((e) => e.event)).toEqual([
          "waiting",
          "acquired",
          "ffmpeg-start",
          "ffmpeg-end",
          "released",
        ])
      expect(noOverlap(intervalsOf(probes, label))).toBe(true)
    })

    it("works with PostgreSQL unavailable (no database settings at all)", async () => {
      const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DATABASE_URL: "postgresql://nobody:x@127.0.0.1:1/none",
      } as unknown as NodeJS.ProcessEnv
      const p = probe(["--kind", "studio", "--seconds", "1.5"], env)
      expect(await p.exited).toBe(0)
      expect(p.events.find((e) => e.event === "ffmpeg-end")?.ok).toBe(true)
    })

    it("a render cancelled while waiting never starts, and the holder is unaffected", async () => {
      const holder = probe(["--kind", "ticket", "--seconds", "3"])
      await holder.waitFor("ffmpeg-start")
      const waiter = probe(["--kind", "studio", "--cancel-ms", "700"])
      expect(await waiter.exited).toBe(0)
      expect(waiter.events.map((e) => e.event)).toEqual([
        "waiting",
        "cancelled-waiting",
      ])
      expect(await holder.exited).toBe(0)
      expect(holder.events.find((e) => e.event === "ffmpeg-end")?.ok).toBe(true)
      // The gate is free again.
      expect((await new RenderGate(data).status()).held).toBe(false)
    })

    it("SIGKILLed holder: its orphaned FFmpeg keeps the gate shut until it is gone", async () => {
      const crashed = probe(["--kind", "studio", "--seconds", "2.5", "--crash"])
      const started = await crashed.waitFor("ffmpeg-start")
      expect(await crashed.exited).toBe("SIGKILL")
      const orphan = started.ffmpegPid!
      expect(dead(orphan)).toBe(false)
      const gate = new RenderGate(data)
      const status = await gate.status()
      expect(status.held).toBe(true)
      expect(status.holders.map((h) => h.program)).toEqual(["ffmpeg"])
      const next = probe(["--kind", "ticket", "--seconds", "1.5"])
      await next.waitFor("acquired")
      // Acquired only once the orphan had exited (finished or reaped).
      expect(dead(orphan)).toBe(true)
      expect(await next.exited).toBe(0)
    })

    it("abandoned FFmpeg is reaped; a live owner's render and unrelated FFmpeg are never touched", async () => {
      const gate = new RenderGate(data)
      // An unrelated FFmpeg on the same machine (not a Deskverse render).
      const work = await mkdtemp(path.join(os.tmpdir(), "deskverse-unrelated-"))
      const unrelated: ChildProcess = spawn(
        "ffmpeg",
        [
          "-nostdin",
          "-loglevel",
          "error",
          "-re",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=320x240:rate=30",
          "-t",
          "20",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-y",
          "u.mp4",
        ],
        { cwd: work, stdio: "ignore" },
      )
      // A live owner: reaping must leave it alone.
      const live = probe(["--kind", "ticket", "--seconds", "2"])
      await live.waitFor("ffmpeg-start")
      expect(await gate.reapAbandoned()).toEqual([])
      expect(await live.exited).toBe(0)
      expect(live.events.find((e) => e.event === "ffmpeg-end")?.ok).toBe(true)
      // An abandoned one (owner SIGKILLed, long encode): reaped.
      const crashed = probe(["--kind", "studio", "--seconds", "30", "--crash"])
      const orphan = (await crashed.waitFor("ffmpeg-start")).ffmpegPid!
      await crashed.exited
      expect(await gate.reapAbandoned()).toEqual([orphan])
      expect(dead(orphan)).toBe(true)
      expect((await gate.status()).held).toBe(false)
      expect(dead(unrelated.pid!)).toBe(false)
      unrelated.kill("SIGKILL")
      await rm(work, { recursive: true, force: true })
    })

    it("Pixel Studio startup recovery never stops a legitimate ticket render, even inside Studio's job folder", async () => {
      const jobs = path.join(
        data,
        "video",
        "jobs",
        "job_0123456789abcdef0123456789abcdef",
        "work",
      )
      await mkdir(jobs, { recursive: true })
      const ticket = probe([
        "--kind",
        "ticket",
        "--seconds",
        "2.5",
        "--cwd",
        jobs,
      ])
      const started = await ticket.waitFor("ffmpeg-start")
      const stopped = await stopAbandonedRenders(
        new RenderGate(data),
        path.join(data, "video", "jobs"),
      )
      expect(stopped).toEqual([])
      expect(dead(started.ffmpegPid!)).toBe(false)
      expect(await ticket.exited).toBe(0)
      expect(ticket.events.find((e) => e.event === "ffmpeg-end")?.ok).toBe(true)
    })
  },
)
