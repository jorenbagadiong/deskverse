import "server-only"

import { randomBytes } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  createAssetId,
  createRenderJobId,
  isAssetId,
  isRenderJobId,
  type RenderJobId,
} from "@/lib/video/ids"
import {
  canTransition,
  isRenderJobState,
  type RenderJob,
  type RenderJobError,
  type RenderJobState,
  type RenderOutput,
} from "@/lib/video/render-job"
import {
  IMAGE_EXTENSIONS,
  type MediaAsset,
  type VideoProject,
} from "@/lib/video/types"
import {
  formatBytes,
  MEDIA_LIMITS,
  sanitizeDisplayName,
  validateMediaAsset,
  validateMediaMetadata,
  validateVideoProject,
} from "@/lib/video/validation"
import { readImageDimensions, sniffImageType } from "@/server/video/image-sniff"

/**
 * Private, local storage for Pixel Studio render jobs.
 *
 * Layout (outside the repository, never under `public/`):
 *
 *   <data dir>/video/jobs/<jobId>/
 *     job.json                 metadata (RenderJob)
 *     project.json             the server-built VideoProject the renderer uses
 *     assets/<assetId>.<ext>   uploaded images, renamed to generated IDs
 *     work/                    temporary render files, safe to wipe
 *     output/video.mp4         the finished render
 *
 * Safety rules:
 * - Only generated IDs become path segments; user file names are display-only.
 * - Every path is resolved and checked to stay inside the storage root, and
 *   symlinks are refused, so `..`, absolute paths and link tricks can't escape.
 * - Uploads are size-limited and identified by their bytes, not their name.
 * - Directories are 0700 and files 0600 (owner-only) where the OS supports it.
 */

export class StorageError extends Error {
  constructor(
    readonly code:
      | "invalid-root"
      | "invalid-id"
      | "unsafe-path"
      | "not-found"
      | "invalid-state"
      | "invalid-upload"
      | "too-many-assets"
      | "corrupt-metadata",
    message: string,
  ) {
    super(message)
    this.name = "StorageError"
  }
}

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

export interface DataRootOptions {
  env?: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
  homedir?: string
  /** The repository; data must never live inside it (or its `public/`). */
  projectRoot?: string
}

/**
 * Where Deskverse keeps private data, by platform:
 * - Linux / WSL: $XDG_DATA_HOME/deskverse, else ~/.local/share/deskverse
 * - macOS:       ~/Library/Application Support/Deskverse
 * - Windows:     %LOCALAPPDATA%\Deskverse
 * `DESKVERSE_DATA_DIR` overrides it (must be absolute and outside the repo).
 */
export function resolveDataRoot({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  projectRoot = process.cwd(),
}: DataRootOptions = {}): string {
  const p = platform === "win32" ? path.win32 : path.posix
  const override = env.DESKVERSE_DATA_DIR?.trim()
  let root: string
  if (override) {
    if (!p.isAbsolute(override))
      throw new StorageError(
        "invalid-root",
        "DESKVERSE_DATA_DIR must be an absolute path.",
      )
    root = p.resolve(override)
  } else if (platform === "win32") {
    root = p.join(
      env.LOCALAPPDATA || p.join(homedir, "AppData", "Local"),
      "Deskverse",
    )
  } else if (platform === "darwin") {
    root = p.join(homedir, "Library", "Application Support", "Deskverse")
  } else {
    const xdg = env.XDG_DATA_HOME
    root = p.join(
      xdg && p.isAbsolute(xdg) ? xdg : p.join(homedir, ".local", "share"),
      "deskverse",
    )
  }
  if (isInside(p, p.resolve(projectRoot), root))
    throw new StorageError(
      "invalid-root",
      "The data directory must be outside the project folder, so private files can't be served or committed.",
    )
  return root
}

/** True when `child` is `parent` itself or anywhere below it. */
function isInside(p: path.PlatformPath, parent: string, child: string) {
  const relative = p.relative(parent, child)
  return (
    relative === "" || (!relative.startsWith("..") && !p.isAbsolute(relative))
  )
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/** One path segment: letters, digits, `_`, `-`, and dots only between them. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/

/**
 * Joins `segments` onto `base` and proves the result stays inside `base`.
 * Rejects separators, `..`, empty or absolute segments and NUL bytes.
 */
export function resolveInside(base: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (!SAFE_SEGMENT.test(segment))
      throw new StorageError("unsafe-path", "Refused an unsafe path segment.")
  }
  const resolvedBase = path.resolve(base)
  const target = path.resolve(resolvedBase, ...segments)
  if (target === resolvedBase || !isInside(path, resolvedBase, target))
    throw new StorageError(
      "unsafe-path",
      "Refused a path outside the storage directory.",
    )
  return target
}

/** Fails if `target` is a symlink or (once real paths are compared) outside `root`. */
async function assertRealPathInside(root: string, target: string) {
  const stat = await fs.lstat(target)
  if (stat.isSymbolicLink())
    throw new StorageError("unsafe-path", "Refused to follow a symbolic link.")
  const [realRoot, realTarget] = await Promise.all([
    fs.realpath(root),
    fs.realpath(target),
  ])
  if (realTarget === realRoot || !isInside(path, realRoot, realTarget))
    throw new StorageError(
      "unsafe-path",
      "Refused a path outside the storage directory.",
    )
  return stat
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface ImageUpload {
  bytes: Uint8Array
  /** What the client claimed. Must match what the bytes actually are. */
  declaredType: string
  fileName: string
}

/**
 * Extra check run on an upload after it is written (privately) but before it
 * is recorded in job.json, e.g. FFprobe decoding. Throw a StorageError with
 * code "invalid-upload" to reject: the file is deleted again.
 */
export type UploadVerifier = (
  filePath: string,
  asset: MediaAsset,
) => Promise<void>

export interface CompletedOutput {
  /** Absolute path for server-side streaming only. Never send it to a browser. */
  path: string
  sizeBytes: number
}

export interface VideoStorage {
  readonly root: string
  createJob(): Promise<RenderJob>
  readJob(id: string): Promise<RenderJob>
  transitionJob(
    id: string,
    to: RenderJobState,
    details?: { error?: RenderJobError; output?: RenderJob["output"] },
  ): Promise<RenderJob>
  addImageAsset(
    jobId: string,
    upload: ImageUpload,
    options?: { verify?: UploadVerifier },
  ): Promise<MediaAsset>
  /** Stores the server-built project (project.json) for the renderer. */
  writeProject(jobId: string, project: VideoProject): Promise<void>
  /** Reads and re-validates project.json against the job's own assets. */
  readProject(jobId: string): Promise<VideoProject>
  /** The job's private scratch directory (exists; inside storage). */
  workDir(jobId: string): Promise<string>
  /**
   * Moves a verified file from work/ to output/video.mp4 while the job is
   * rendering. Only called after FFprobe verification.
   */
  commitOutput(jobId: string, workFileName: string): Promise<void>
  /** Removes output/video.mp4 if present (after a failed render). */
  discardOutput(jobId: string): Promise<void>
  /** IDs of jobs currently in one of `states`. */
  findJobs(states: readonly RenderJobState[]): Promise<RenderJobId[]>
  /** Server-side path of a stored asset, for the render pipeline. */
  assetPath(jobId: string, assetId: string): Promise<string>
  /** Empties the job's `work/` directory. */
  cleanupWork(jobId: string): Promise<void>
  deleteJob(jobId: string): Promise<void>
  /** Deletes finished/abandoned jobs not updated within `olderThanMs`. Returns their IDs. */
  cleanupStaleJobs(options: {
    olderThanMs: number
    /** Only remove jobs in these states (default: any inactive state). */
    states?: readonly RenderJobState[]
  }): Promise<RenderJobId[]>
  /** The finished video, only if the job completed and the file is a real file inside storage. */
  resolveCompletedOutput(jobId: string): Promise<CompletedOutput | null>
}

const DIR_MODE = 0o700
const FILE_MODE = 0o600
const OUTPUT_FILE = "video.mp4"
const PROJECT_FILE = "project.json"

export function createVideoStorage(
  dataRoot: string,
  { now = () => new Date() }: { now?: () => Date } = {},
): VideoStorage {
  if (!path.isAbsolute(dataRoot))
    throw new StorageError(
      "invalid-root",
      "The storage root must be an absolute path.",
    )
  const root = path.resolve(dataRoot, "video")
  const jobsDir = path.join(root, "jobs")
  const locks = new Map<string, Promise<unknown>>()

  /** Serializes read-modify-write of one job's metadata. */
  function withLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    locks.set(id, next)
    return next.finally(() => {
      if (locks.get(id) === next) locks.delete(id)
    })
  }

  function parseJobId(id: string): RenderJobId {
    if (!isRenderJobId(id))
      throw new StorageError("invalid-id", "Unknown render job.")
    return id
  }

  async function jobDir(id: string) {
    const dir = resolveInside(jobsDir, parseJobId(id))
    try {
      const stat = await assertRealPathInside(jobsDir, dir)
      if (!stat.isDirectory())
        throw new StorageError("not-found", "Unknown render job.")
    } catch (error) {
      if (isErrno(error, "ENOENT"))
        throw new StorageError("not-found", "Unknown render job.")
      throw error
    }
    return dir
  }

  /** Writes JSON via a temp file + rename, so readers never see half a file. */
  async function writeJsonAtomic(dir: string, name: string, value: unknown) {
    const file = resolveInside(dir, name)
    const temp = resolveInside(
      dir,
      `${name}.${randomBytes(6).toString("hex")}.tmp`,
    )
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
      mode: FILE_MODE,
      flag: "wx",
    })
    await fs.rename(temp, file)
  }

  const writeJob = (dir: string, job: RenderJob) =>
    writeJsonAtomic(dir, "job.json", job)

  async function readJobFrom(dir: string, id: RenderJobId): Promise<RenderJob> {
    let parsed: unknown
    try {
      parsed = JSON.parse(
        await fs.readFile(resolveInside(dir, "job.json"), "utf8"),
      )
    } catch (error) {
      if (isErrno(error, "ENOENT"))
        throw new StorageError("not-found", "Unknown render job.")
      throw new StorageError(
        "corrupt-metadata",
        "This job's metadata can't be read.",
      )
    }
    return parseJob(parsed, id)
  }

  return {
    root,

    async createJob() {
      await fs.mkdir(jobsDir, { recursive: true, mode: DIR_MODE })
      const id = createRenderJobId()
      const dir = resolveInside(jobsDir, id)
      await fs.mkdir(dir, { mode: DIR_MODE }) // fails if it somehow exists
      for (const sub of ["assets", "work", "output"])
        await fs.mkdir(resolveInside(dir, sub), { mode: DIR_MODE })
      const timestamp = now().toISOString()
      const job: RenderJob = {
        id,
        state: "draft",
        createdAt: timestamp,
        updatedAt: timestamp,
        assets: [],
        error: null,
        output: null,
      }
      await writeJob(dir, job)
      return job
    },

    async readJob(id) {
      const dir = await jobDir(id)
      return readJobFrom(dir, parseJobId(id))
    },

    transitionJob(id, to, details = {}) {
      return withLock(id, async () => {
        const dir = await jobDir(id)
        const job = await readJobFrom(dir, parseJobId(id))
        if (!canTransition(job.state, to))
          throw new StorageError(
            "invalid-state",
            `A ${job.state} job can't become ${to}.`,
          )
        const next: RenderJob = {
          ...job,
          state: to,
          updatedAt: now().toISOString(),
          error: to === "failed" ? (details.error ?? null) : null,
          output: to === "completed" ? (details.output ?? null) : job.output,
        }
        await writeJob(dir, next)
        return next
      })
    },

    addImageAsset(jobId, upload, options = {}) {
      return withLock(jobId, async () => {
        const dir = await jobDir(jobId)
        const job = await readJobFrom(dir, parseJobId(jobId))
        if (job.state !== "draft")
          throw new StorageError(
            "invalid-state",
            "Images can only be added before rendering starts.",
          )
        if (job.assets.length >= MEDIA_LIMITS.maxCount)
          throw new StorageError(
            "too-many-assets",
            `A video can use at most ${MEDIA_LIMITS.maxCount} images.`,
          )

        const { bytes } = upload
        const name = sanitizeDisplayName(upload.fileName)
        if (bytes.byteLength === 0)
          throw new StorageError("invalid-upload", `“${name}” is empty.`)
        if (bytes.byteLength > MEDIA_LIMITS.maxBytes)
          throw new StorageError(
            "invalid-upload",
            `“${name}” is larger than ${formatBytes(MEDIA_LIMITS.maxBytes)}.`,
          )
        const actualType = sniffImageType(bytes)
        if (actualType === null || actualType !== upload.declaredType)
          throw new StorageError(
            "invalid-upload",
            `“${name}” isn't a JPEG, PNG or WebP image (its contents don't match its type).`,
          )
        const dimensions = readImageDimensions(bytes, actualType)
        if (!dimensions)
          throw new StorageError(
            "invalid-upload",
            `“${name}” has no readable dimensions.`,
          )
        const metadata = validateMediaMetadata({
          fileName: upload.fileName,
          mimeType: actualType,
          sizeBytes: bytes.byteLength,
          width: dimensions.width,
          height: dimensions.height,
        })
        if (!metadata.ok)
          throw new StorageError("invalid-upload", metadata.issues[0].message)

        const asset: MediaAsset = {
          id: createAssetId(),
          kind: "image",
          mimeType: actualType,
          sizeBytes: bytes.byteLength,
          width: dimensions.width,
          height: dimensions.height,
          displayName: name,
        }
        const file = resolveInside(dir, "assets", assetFileName(asset))
        // "wx": never overwrite an existing file.
        await fs.writeFile(file, bytes, { mode: FILE_MODE, flag: "wx" })
        try {
          if (options.verify) await options.verify(file, asset)
          await writeJob(dir, {
            ...job,
            assets: [...job.assets, asset],
            updatedAt: now().toISOString(),
          })
        } catch (error) {
          await fs.rm(file, { force: true })
          throw error
        }
        return asset
      })
    },

    async assetPath(jobId, assetId) {
      if (!isAssetId(assetId))
        throw new StorageError("invalid-id", "Unknown image.")
      const dir = await jobDir(jobId)
      const job = await readJobFrom(dir, parseJobId(jobId))
      const asset = job.assets.find((a) => a.id === assetId)
      if (!asset) throw new StorageError("not-found", "Unknown image.")
      const file = resolveInside(dir, "assets", assetFileName(asset))
      await assertRealPathInside(dir, file)
      return file
    },

    writeProject(jobId, project) {
      return withLock(jobId, async () => {
        const dir = await jobDir(jobId)
        const job = await readJobFrom(dir, parseJobId(jobId))
        if (job.state !== "draft")
          throw new StorageError(
            "invalid-state",
            "This video has already been sent for rendering.",
          )
        await writeJsonAtomic(dir, PROJECT_FILE, project)
      })
    },

    async readProject(jobId) {
      const dir = await jobDir(jobId)
      const job = await readJobFrom(dir, parseJobId(jobId))
      let parsed: unknown
      try {
        parsed = JSON.parse(
          await fs.readFile(resolveInside(dir, PROJECT_FILE), "utf8"),
        )
      } catch {
        throw new StorageError(
          "corrupt-metadata",
          "This job's video project can't be read.",
        )
      }
      const result = validateVideoProject(parsed)
      // Every asset must be one this job actually stored, with the same facts.
      if (
        !result.ok ||
        result.value.assets.some(
          (asset) =>
            JSON.stringify(job.assets.find((a) => a.id === asset.id)) !==
            JSON.stringify(asset),
        )
      )
        throw new StorageError(
          "corrupt-metadata",
          "This job's video project is invalid.",
        )
      return result.value
    },

    async workDir(jobId) {
      const dir = await jobDir(jobId)
      const work = resolveInside(dir, "work")
      await assertRealPathInside(dir, work)
      return work
    },

    commitOutput(jobId, workFileName) {
      return withLock(jobId, async () => {
        const dir = await jobDir(jobId)
        const job = await readJobFrom(dir, parseJobId(jobId))
        if (job.state !== "rendering")
          throw new StorageError(
            "invalid-state",
            "Only a rendering job can produce output.",
          )
        const source = resolveInside(dir, "work", workFileName)
        const stat = await assertRealPathInside(dir, source)
        if (!stat.isFile())
          throw new StorageError("not-found", "The rendered file is missing.")
        const target = resolveInside(dir, "output", OUTPUT_FILE)
        await fs.chmod(source, FILE_MODE)
        await fs.rename(source, target)
      })
    },

    async discardOutput(jobId) {
      const dir = await jobDir(jobId)
      await fs.rm(resolveInside(dir, "output", OUTPUT_FILE), { force: true })
    },

    async findJobs(states) {
      let entries: import("node:fs").Dirent[]
      try {
        entries = await fs.readdir(jobsDir, { withFileTypes: true })
      } catch (error) {
        if (isErrno(error, "ENOENT")) return []
        throw error
      }
      const found: RenderJobId[] = []
      for (const entry of entries) {
        if (!entry.isDirectory() || !isRenderJobId(entry.name)) continue
        try {
          const job = await readJobFrom(
            resolveInside(jobsDir, entry.name),
            entry.name,
          )
          if (states.includes(job.state)) found.push(job.id)
        } catch (error) {
          if (!(error instanceof StorageError)) throw error
        }
      }
      return found
    },

    async cleanupWork(jobId) {
      const dir = await jobDir(jobId)
      const work = resolveInside(dir, "work")
      await fs.rm(work, { recursive: true, force: true })
      await fs.mkdir(work, { mode: DIR_MODE })
    },

    deleteJob(jobId) {
      return withLock(jobId, async () => {
        const dir = await jobDir(jobId)
        await fs.rm(dir, { recursive: true, force: true })
      })
    },

    async cleanupStaleJobs({ olderThanMs, states }) {
      let entries: import("node:fs").Dirent[]
      try {
        entries = await fs.readdir(jobsDir, { withFileTypes: true })
      } catch (error) {
        if (isErrno(error, "ENOENT")) return []
        throw error
      }
      const cutoff = now().getTime() - olderThanMs
      const removed: RenderJobId[] = []
      for (const entry of entries) {
        // Never touch anything we didn't create: only real directories named like job IDs.
        if (!entry.isDirectory() || !isRenderJobId(entry.name)) continue
        const id = entry.name
        await withLock(id, async () => {
          const dir = resolveInside(jobsDir, id)
          let updatedAt: number
          try {
            const job = await readJobFrom(dir, id)
            if (job.state === "queued" || job.state === "rendering") return
            if (states && !states.includes(job.state)) return
            updatedAt = Date.parse(job.updatedAt)
          } catch (error) {
            if (!(error instanceof StorageError)) throw error
            // Unreadable metadata: fall back to the directory's age.
            updatedAt = (await fs.stat(dir)).mtimeMs
          }
          if (updatedAt < cutoff) {
            await fs.rm(dir, { recursive: true, force: true })
            removed.push(id)
          }
        })
      }
      return removed
    },

    async resolveCompletedOutput(jobId) {
      const dir = await jobDir(jobId)
      const job = await readJobFrom(dir, parseJobId(jobId))
      if (job.state !== "completed" || !job.output) return null
      const file = resolveInside(dir, "output", OUTPUT_FILE)
      try {
        const stat = await assertRealPathInside(dir, file)
        if (!stat.isFile()) return null
        return { path: file, sizeBytes: stat.size }
      } catch (error) {
        if (isErrno(error, "ENOENT")) return null
        throw error
      }
    },
  }
}

function assetFileName(asset: Pick<MediaAsset, "id" | "mimeType">) {
  return `${asset.id}.${IMAGE_EXTENSIONS[asset.mimeType][0]}`
}

/** Validates job.json contents; our own file, but checked like any input. */
function parseJob(input: unknown, expectedId: RenderJobId): RenderJob {
  const corrupt = () =>
    new StorageError("corrupt-metadata", "This job's metadata can't be read.")
  if (typeof input !== "object" || input === null) throw corrupt()
  const job = input as Record<string, unknown>
  if (job.id !== expectedId || !isRenderJobState(job.state)) throw corrupt()
  if (typeof job.createdAt !== "string" || typeof job.updatedAt !== "string")
    throw corrupt()
  if (!Array.isArray(job.assets)) throw corrupt()
  const assets = job.assets.map((raw) => {
    const result = validateMediaAsset(raw)
    if (!result.ok) throw corrupt()
    return result.value
  })
  const error = job.error as RenderJob["error"]
  const output = job.output as RenderJob["output"]
  return {
    id: expectedId,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    assets,
    error: error && typeof error.message === "string" ? error : null,
    output: isRenderOutput(output) ? output : null,
  }
}

function isRenderOutput(value: unknown): value is RenderOutput {
  if (typeof value !== "object" || value === null) return false
  const o = value as Record<string, unknown>
  return (
    o.fileName === OUTPUT_FILE &&
    ["sizeBytes", "durationSeconds", "width", "height", "fps", "renderSeconds"]
      .map((key) => o[key])
      .every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) &&
    typeof o.videoCodec === "string" &&
    typeof o.pixelFormat === "string" &&
    typeof o.encoder === "string"
  )
}

function isErrno(error: unknown, code: string) {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === code
  )
}
