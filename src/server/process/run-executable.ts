import "server-only"

import { execFile, spawn } from "node:child_process"

/**
 * The only way Deskverse starts external programs.
 *
 * - `execFile` / `spawn` with `shell: false`, never `exec`: no shell, so arguments are passed verbatim and
 *   cannot be interpreted as shell syntax (no `;`, `|`, `$()`, globbing).
 * - Arguments come from server code only. Nothing a browser sends is ever
 *   appended to an argument list.
 * - Hard timeout and output cap, so a hung or chatty process can't pin the server.
 * - A minimal environment: the child sees PATH (to resolve the program) and a
 *   few OS essentials, not the app's secrets.
 * - Errors are mapped to a small set of reasons; raw messages (which include
 *   absolute paths) never leave this module.
 */

export type RunFailureReason =
  "not-found" | "not-executable" | "timed-out" | "failed" | "output-too-large"

export type RunResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; reason: RunFailureReason; exitCode: number | null }

export type Runner = (
  command: string,
  args: readonly string[],
) => Promise<RunResult>

export interface RunOptions {
  timeoutMs?: number
  maxOutputBytes?: number
}

const ENV_ALLOWLIST = [
  "PATH",
  // Windows needs these to resolve and start programs.
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
] as const

export function minimalEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = { LC_ALL: "C" }
  for (const key of ENV_ALLOWLIST) {
    const value = source[key]
    if (typeof value === "string") env[key] = value
  }
  return env
}

interface ExecError extends Error {
  code?: string | number | null
  killed?: boolean
  signal?: NodeJS.Signals | null
}

/** Maps a child_process error to a reason without keeping its message. */
export function classifyRunError(error: ExecError): {
  reason: RunFailureReason
  exitCode: number | null
} {
  if (error.code === "ENOENT") return { reason: "not-found", exitCode: null }
  if (
    error.code === "EACCES" ||
    error.code === "EPERM" ||
    error.code === "ENOEXEC"
  )
    return { reason: "not-executable", exitCode: null }
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return { reason: "output-too-large", exitCode: null }
  if (error.killed || error.signal)
    return { reason: "timed-out", exitCode: null }
  return {
    reason: "failed",
    exitCode: typeof error.code === "number" ? error.code : null,
  }
}

export function createRunner({
  timeoutMs = 5_000,
  maxOutputBytes = 4 * 1024 * 1024,
}: RunOptions = {}): Runner {
  return (command, args) =>
    new Promise<RunResult>((resolve) => {
      try {
        const child = execFile(
          command,
          [...args],
          {
            shell: false,
            timeout: timeoutMs,
            killSignal: "SIGKILL",
            maxBuffer: maxOutputBytes,
            windowsHide: true,
            encoding: "utf8",
            // Next.js types mark NODE_ENV as required; the child doesn't need it.
            env: minimalEnvironment() as NodeJS.ProcessEnv,
          },
          (error, stdout, stderr) => {
            if (error) resolve({ ok: false, ...classifyRunError(error) })
            else resolve({ ok: true, stdout, stderr })
          },
        )
        // FFmpeg can read keyboard commands from stdin; give it none.
        child.stdin?.end()
      } catch (error) {
        // Synchronous spawn failures (e.g. invalid arguments on some platforms).
        resolve({ ok: false, ...classifyRunError(error as ExecError) })
      }
    })
}

// ---------------------------------------------------------------------------
// Long-running tools (rendering)
// ---------------------------------------------------------------------------

export interface SpawnOptions {
  /** Working directory (the job's private work dir for renders). */
  cwd: string
  timeoutMs: number
  /** Receives stdout text as it arrives (e.g. FFmpeg -progress output). */
  onStdout?: (chunk: string) => void
  /** Keep at most this much of stderr, for server-side diagnostics only. */
  maxStderrBytes?: number
}

export type SpawnResult =
  | { ok: true; stderrTail: string }
  | {
      ok: false
      reason: RunFailureReason
      exitCode: number | null
      stderrTail: string
    }

export type Spawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => Promise<SpawnResult>

/**
 * Streams a long-running tool: stdin is closed ("ignore") so it can never
 * wait for input, stdout is streamed to `onStdout`, stderr is capped, and
 * the process is killed with SIGKILL at the deadline.
 */
export const spawnTool: Spawner = (
  command,
  args,
  { cwd, timeoutMs, onStdout, maxStderrBytes = 64 * 1024 },
) =>
  new Promise<SpawnResult>((resolve) => {
    let stderr = ""
    let timedOut = false
    let settled = false
    const finish = (result: SpawnResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: minimalEnvironment() as NodeJS.ProcessEnv,
      })
    } catch (error) {
      resolve({
        ok: false,
        ...classifyRunError(error as ExecError),
        stderrTail: "",
      })
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)

    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => onStdout?.(chunk))
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-maxStderrBytes)
    })
    child.on("error", (error) =>
      finish({
        ok: false,
        ...classifyRunError(error as ExecError),
        stderrTail: stderr,
      }),
    )
    child.on("close", (code, signal) => {
      if (timedOut)
        finish({
          ok: false,
          reason: "timed-out",
          exitCode: null,
          stderrTail: stderr,
        })
      else if (code === 0) finish({ ok: true, stderrTail: stderr })
      else
        finish({
          ok: false,
          reason: "failed",
          exitCode: code ?? (signal ? null : -1),
          stderrTail: stderr,
        })
    })
  })
