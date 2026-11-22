import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"

import type { Spawner } from "@/server/process/run-executable"

/**
 * The installation-wide FFmpeg render gate (DV-005C).
 *
 * One physical render pipeline at a time for this Deskverse data folder,
 * across every process: Pixel Studio servers, orchestrator workers, tests.
 * No PostgreSQL involved, so standalone Studio keeps working without it.
 *
 * How it works (Linux/WSL `flock(2)`, an OS advisory lock):
 * - `<data>/locks/render.lock` is opened by Node; the `flock` tool locks
 *   that SAME open file description through an inherited fd (blocking in
 *   the kernel while another holder has it: no busy-waiting).
 * - Every FFmpeg process of the render inherits the fd too. A flock lock
 *   belongs to the open file description, so it is held until the LAST
 *   holder closes it: if Node is SIGKILLed mid-render, its orphaned FFmpeg
 *   keeps the gate shut until it exits. A new render can never overlap a
 *   leftover one.
 * - The kernel reports holders in /proc/<pid>/fdinfo ("FLOCK"). Recovery
 *   ("reaping") kills ONLY processes holding the gate, ONLY when every
 *   holder is ffmpeg/ffprobe (their Node owner is gone). A live owner, or
 *   any unrelated FFmpeg on the machine, is never touched; nothing is
 *   matched by process name alone.
 * - The lock file is never deleted (that would break flock semantics). An
 *   owner record (pid, kind, job) is informational, for status and logs.
 *
 * `renderVideo` refuses to run without a genuine, held lease from this
 * module, so no code path can render around the gate.
 */

export type GateOwnerKind = "studio" | "ticket" | "test"

export interface GateOwner {
  pid: number
  kind: GateOwnerKind
  jobId: string
  storageRoot: string
  startedAt: string
  token: string
}

export class GateCancelled extends Error {
  constructor() {
    super("Stopped while waiting for the renderer.")
    this.name = "GateCancelled"
  }
}

export interface RenderLease {
  readonly owner: GateOwner
  /** Wraps a spawner so every child inherits the gate (renders must use it). */
  wrap(spawner: Spawner): Spawner
  isHeld(): boolean
  release(): Promise<void>
}

const genuine = new WeakSet<object>()

/** True only for a lease issued by RenderGate.acquire and not yet released. */
export function isGenuineLease(lease: unknown): lease is RenderLease {
  return (
    typeof lease === "object" &&
    lease !== null &&
    genuine.has(lease) &&
    (lease as RenderLease).isHeld()
  )
}

export interface GateStatus {
  held: boolean
  owner: GateOwner | null
  /** Live processes holding the gate (Node owners and their FFmpeg children). */
  holders: { pid: number; program: string }[]
}

const DIR_MODE = 0o700
const FILE_MODE = 0o600

export class RenderGate {
  readonly lockPath: string
  readonly ownerPath: string

  constructor(
    dataRoot: string,
    private readonly options: {
      flock?: string
      procRoot?: string
      /** While waiting, how often to check for abandoned holders. */
      reapEveryMs?: number
      log?: (line: string) => void
      /**
       * Test evidence: append a JSON line per acquire/release to this file
       * (DESKVERSE_RENDER_GATE_AUDIT). Off unless set.
       */
      auditFile?: string
    } = {},
  ) {
    const dir = path.join(path.resolve(dataRoot), "locks")
    this.lockPath = path.join(dir, "render.lock")
    this.ownerPath = path.join(dir, "render-owner.json")
  }

  private async openLock() {
    const dir = path.dirname(this.lockPath)
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE })
    const stat = await fs.lstat(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("render lock directory isn't a private directory")
    await fs.chmod(dir, DIR_MODE).catch(() => undefined)
    const existing = await fs.lstat(this.lockPath).catch(() => null)
    if (existing && (!existing.isFile() || existing.isSymbolicLink()))
      throw new Error("render lock isn't a regular file")
    // O_NOFOLLOW: never lock through a symlink planted at the lock path.
    const { constants } = await import("node:fs")
    return fs.open(
      this.lockPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      FILE_MODE,
    )
  }

  /** Runs `flock` on an inherited fd; resolves with its exit code. */
  private flockOn(fd: number, args: string[], signal?: AbortSignal) {
    return new Promise<number>((resolve, reject) => {
      const child = spawn(
        /*turbopackIgnore: true*/ this.options.flock ?? "flock",
        [...args, "3"],
        {
          stdio: ["ignore", "ignore", "pipe", fd],
          shell: false,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
          } as unknown as NodeJS.ProcessEnv,
        },
      ) as import("node:child_process").ChildProcess
      child.stderr?.resume()
      const onAbort = () => child.kill("SIGKILL")
      signal?.addEventListener("abort", onAbort, { once: true })
      child.on("error", (e) => {
        signal?.removeEventListener("abort", onAbort)
        reject(new Error(`flock couldn't run: ${e.message}`))
      })
      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort)
        resolve(code ?? -1)
      })
    })
  }

  /**
   * Waits for the gate and returns a lease. Aborting `signal` while waiting
   * rejects with GateCancelled and leaves the gate untouched for others.
   */
  async acquire(
    owner: { kind: GateOwnerKind; jobId: string; storageRoot: string },
    signal?: AbortSignal,
  ): Promise<RenderLease> {
    if (process.platform !== "linux")
      throw new Error("The render gate needs Linux or WSL (flock).")
    if (signal?.aborted) throw new GateCancelled()
    const handle = await this.openLock()
    let acquired = false
    const reaper = setInterval(() => {
      void this.reapAbandoned().catch(() => undefined)
    }, this.options.reapEveryMs ?? 2_000)
    try {
      // Fast path, then a blocking wait in the kernel.
      if ((await this.flockOn(handle.fd, ["-x", "-n"])) !== 0) {
        await this.reapAbandoned().catch(() => undefined)
        const code = await this.flockOn(handle.fd, ["-x"], signal)
        if (signal?.aborted) throw new GateCancelled()
        if (code !== 0) throw new Error(`flock exited with ${code}`)
      }
      if (signal?.aborted) throw new GateCancelled()
      acquired = true
    } finally {
      clearInterval(reaper)
      // Closing our fd releases the lock if we got it (no child holds it yet).
      if (!acquired) await handle.close().catch(() => undefined)
    }

    const record: GateOwner = {
      pid: process.pid,
      kind: owner.kind,
      jobId: owner.jobId,
      storageRoot: owner.storageRoot,
      startedAt: new Date().toISOString(),
      token: randomBytes(8).toString("hex"),
    }
    const tmp = `${this.ownerPath}.${process.pid}.${record.token}.tmp`
    await fs.writeFile(tmp, JSON.stringify(record), { mode: FILE_MODE })
    await fs.rename(tmp, this.ownerPath)
    const audit =
      this.options.auditFile ?? process.env.DESKVERSE_RENDER_GATE_AUDIT
    const note = (event: string) =>
      audit
        ? fs
            .appendFile(
              audit,
              `${JSON.stringify({ event, t: Date.now(), mono: process.hrtime.bigint().toString(), pid: process.pid, kind: record.kind, jobId: record.jobId, token: record.token })}\n`,
            )
            .catch(() => undefined)
        : Promise.resolve()
    await note("acquired")

    let held = true
    const fd = handle.fd
    const ownerPath = this.ownerPath
    const lease: RenderLease = {
      owner: record,
      isHeld: () => held,
      wrap: (spawner) => (command, args, options) => {
        if (!held) throw new Error("render gate lease already released")
        return spawner(command, args, { ...options, extraFds: [fd] })
      },
      async release() {
        if (!held) return
        held = false
        genuine.delete(lease)
        try {
          const current = JSON.parse(
            await fs.readFile(ownerPath, "utf8"),
          ) as GateOwner
          if (current.token === record.token)
            await fs.rm(ownerPath, { force: true })
        } catch {
          // No record, or someone else's.
        }
        // Logged just BEFORE the lock closes (every render process has exited).
        await note("released")
        await handle.close().catch(() => undefined)
      },
    }
    genuine.add(lease)
    return lease
  }

  /** Processes holding the gate's lock (kernel fdinfo "FLOCK" on this file). */
  async holders(): Promise<{ pid: number; program: string }[]> {
    const proc = this.options.procRoot ?? "/proc"
    let target: string
    try {
      target = await fs.realpath(this.lockPath)
    } catch {
      return []
    }
    const out: { pid: number; program: string }[] = []
    for (const name of await fs
      .readdir(/*turbopackIgnore: true*/ proc)
      .catch(() => [] as string[])) {
      if (!/^\d+$/.test(name)) continue
      try {
        const fdDir = path.join(proc, name, "fd")
        for (const fd of await fs.readdir(/*turbopackIgnore: true*/ fdDir)) {
          let link: string
          try {
            link = await fs.readlink(
              /*turbopackIgnore: true*/ path.join(fdDir, fd),
            )
          } catch {
            continue
          }
          if (link !== target) continue
          const info = await fs.readFile(
            /*turbopackIgnore: true*/ path.join(proc, name, "fdinfo", fd),
            "utf8",
          )
          if (!/^lock:.*\bFLOCK\b/m.test(info)) continue
          const cmdline = await fs.readFile(
            /*turbopackIgnore: true*/ path.join(proc, name, "cmdline"),
            "utf8",
          )
          out.push({
            pid: Number(name),
            program: path.basename(cmdline.split("\0")[0] ?? ""),
          })
          break
        }
      } catch {
        // Gone, or not ours to inspect.
      }
    }
    return out
  }

  async status(): Promise<GateStatus> {
    const holders = await this.holders()
    let owner: GateOwner | null = null
    try {
      owner = JSON.parse(await fs.readFile(this.ownerPath, "utf8")) as GateOwner
    } catch {
      owner = null
    }
    return {
      held: holders.length > 0,
      owner: holders.length > 0 ? owner : null,
      holders,
    }
  }

  /**
   * Stops renders whose owning Node process is gone: kills the gate's
   * holders only if every holder is ffmpeg/ffprobe. Returns killed PIDs.
   * A live owner (any non-FFmpeg holder) means the render is legitimate.
   */
  async reapAbandoned({ waitMs = 3_000 }: { waitMs?: number } = {}): Promise<
    number[]
  > {
    const holders = await this.holders()
    if (holders.length === 0) return []
    if (holders.some((h) => h.program !== "ffmpeg" && h.program !== "ffprobe"))
      return []
    const killed: number[] = []
    for (const h of holders) {
      if (h.pid === process.pid) continue
      try {
        process.kill(h.pid, "SIGKILL")
        killed.push(h.pid)
      } catch {
        // Already gone.
      }
    }
    const deadline = Date.now() + waitMs
    for (const pid of killed)
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0)
          await new Promise((r) => setTimeout(r, 25))
        } catch {
          break
        }
      }
    if (killed.length)
      this.options.log?.(
        `[render-gate] stopped ${killed.length} abandoned FFmpeg process(es): ${killed.join(", ")}`,
      )
    return killed
  }
}
