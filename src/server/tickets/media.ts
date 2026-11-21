import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"

import { TICKET_IMAGE_TYPES, type TicketAsset } from "@/lib/tickets/types"
import { isUuid } from "@/lib/tickets/validation"
import type { ImageMimeType } from "@/lib/video/types"
import { MEDIA_LIMITS } from "@/lib/video/validation"
import type { DeskverseDatabase } from "@/server/db/pool"
import {
  allAssets,
  recordAsset,
  TicketError,
  type NewAssetRecord,
} from "@/server/tickets/repository"
import {
  EXTENSION,
  MediaRejected,
  sniffTicketMedia,
  verifyImage,
  verifyVideo,
  type MediaTools,
} from "@/server/tickets/media-verify"

/**
 * Private file storage for Affiliate Ticket media (DV-004B).
 *
 *   <data dir>/tickets/<ticket id>/assets/<asset id>.<jpg|png|webp|mp4>
 *   <data dir>/tickets/<ticket id>/staging/<asset id>.part   (uploads in progress)
 *
 * Only generated UUIDs become path segments; titles, product names and
 * upload file names never do. Folders are 0700, files 0600. Symlinks
 * anywhere on the path are refused.
 *
 * Consistency (PostgreSQL can't commit a file write):
 *  1. stream the upload into staging/ (size limit enforced while streaming,
 *     SHA-256 computed on the way);
 *  2. verify the bytes (signature, header, FFprobe/FFmpeg);
 *  3. rename into assets/ (same folder tree, so atomic);
 *  4. insert the database record (limits re-checked under the ticket lock);
 *  5. if 4 fails, delete the file.
 * So a database record never points at a missing file. A crash between 3
 * and 4 leaves an unreferenced file, which `yarn tickets:reconcile`
 * quarantines. Deletion is the reverse: delete the record, commit, then
 * remove the file (a crash leaves an orphan, never a dangling record).
 */

export class TicketMediaError extends Error {
  constructor(
    readonly code: "unsafe-path" | "too-large" | "unreadable" | "missing",
    message: string,
  ) {
    super(message)
    this.name = "TicketMediaError"
  }
}

const DIR_MODE = 0o700
const FILE_MODE = 0o600
/** Enough of the file for any header we read (JPEG EXIF can be large). */
const HEAD_BYTES = 256 * 1024

export interface TicketMediaLimits {
  maxImageBytes: number
  maxVideoBytes: number
  maxVideoSeconds: number
  maxVideoSide: number
  minVideoSide: number
  imagesPerProduct: number
  videosPerProduct: number
  maxTicketBytes: number
}

export const DEFAULT_MEDIA_LIMITS: TicketMediaLimits = {
  maxImageBytes: MEDIA_LIMITS.maxBytes,
  maxVideoBytes: 200 * 1024 * 1024,
  maxVideoSeconds: 300,
  maxVideoSide: 4096,
  minVideoSide: 144,
  imagesPerProduct: 20,
  videosPerProduct: 5,
  maxTicketBytes: 2 * 1024 * 1024 * 1024,
}

const MB = 1024 * 1024

/**
 * Limits, with optional overrides (whole numbers in range; anything else
 * is ignored with a warning):
 *   DESKVERSE_TICKET_MAX_VIDEO_MB       1–2048    (default 200)
 *   DESKVERSE_TICKET_MAX_VIDEO_SECONDS  1–3600    (default 300)
 *   DESKVERSE_TICKET_MAX_STORAGE_MB     1–102400  (default 2048, per ticket)
 * Images keep Pixel Studio's limits (10 MB, 320–8192 px).
 */
export function readMediaLimits(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TicketMediaLimits {
  const limits = { ...DEFAULT_MEDIA_LIMITS }
  const read = (name: string, min: number, max: number) => {
    const raw = env[name]
    if (raw === undefined || raw === "") return null
    const value = Number(raw)
    if (!/^\d+$/.test(raw) || value < min || value > max) {
      console.warn(
        `[deskverse] ignoring ${name}: expected a whole number ${min}–${max}`,
      )
      return null
    }
    return value
  }
  const video = read("DESKVERSE_TICKET_MAX_VIDEO_MB", 1, 2048)
  if (video !== null) limits.maxVideoBytes = video * MB
  const seconds = read("DESKVERSE_TICKET_MAX_VIDEO_SECONDS", 1, 3600)
  if (seconds !== null) limits.maxVideoSeconds = seconds
  const storage = read("DESKVERSE_TICKET_MAX_STORAGE_MB", 1, 102_400)
  if (storage !== null) limits.maxTicketBytes = storage * MB
  return limits
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ASSET_FILE = /^([0-9a-f-]{36})\.(jpg|png|webp|mp4)$/

function isInside(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  )
}

function checkIds(...ids: string[]) {
  for (const id of ids)
    if (!isUuid(id))
      throw new TicketMediaError("unsafe-path", "Refused an unsafe media path.")
}

export function ticketsRoot(dataRoot: string) {
  return path.join(path.resolve(dataRoot), "tickets")
}

export function assetFilePath(
  dataRoot: string,
  ticketId: string,
  assetId: string,
  extension: string,
) {
  checkIds(ticketId, assetId)
  if (!Object.values(EXTENSION).includes(extension))
    throw new TicketMediaError("unsafe-path", "Refused an unsafe media path.")
  return path.join(
    ticketsRoot(dataRoot),
    ticketId,
    "assets",
    `${assetId}.${extension}`,
  )
}

/** Creates (0700) each folder from the data root down, refusing symlinks. */
async function ensureDir(dataRoot: string, ...segments: string[]) {
  let current = path.resolve(dataRoot)
  await fs.mkdir(current, { recursive: true, mode: DIR_MODE })
  for (const segment of segments) {
    current = path.join(current, segment)
    try {
      await fs.mkdir(current, { mode: DIR_MODE })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new TicketMediaError(
        "unsafe-path",
        "Refused to use a media folder that is a link or not a folder.",
      )
  }
  return current
}

/** Proves `file` is a regular file inside the data root, through no symlink. */
async function assertSafeFile(dataRoot: string, file: string) {
  const root = await fs.realpath(path.resolve(dataRoot))
  let current = path.resolve(dataRoot)
  for (const part of path.relative(current, file).split(path.sep)) {
    current = path.join(current, part)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink())
      throw new TicketMediaError(
        "unsafe-path",
        "Refused to follow a symbolic link.",
      )
  }
  const real = await fs.realpath(file)
  if (!isInside(root, real))
    throw new TicketMediaError(
      "unsafe-path",
      "Refused a path outside the media folder.",
    )
  const stat = await fs.lstat(real)
  if (!stat.isFile())
    throw new TicketMediaError(
      "unsafe-path",
      "That media entry isn't a regular file.",
    )
  return stat
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

interface Staged {
  bytes: number
  sha256: string
  head: Uint8Array
}

/** Streams a request body to `file`, stopping as soon as it passes maxBytes. */
export async function streamToFile(
  body: ReadableStream<Uint8Array> | null,
  file: string,
  maxBytes: number,
): Promise<Staged> {
  const handle = await fs.open(file, "wx", FILE_MODE)
  const hash = createHash("sha256")
  const head = new Uint8Array(HEAD_BYTES)
  let headLength = 0
  let bytes = 0
  try {
    if (!body) throw new TicketMediaError("unreadable", "The upload was empty.")
    const reader = body.getReader()
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch {
        throw new TicketMediaError(
          "unreadable",
          "The upload was interrupted before it finished. Try again.",
        )
      }
      if (chunk.done) break
      const value = chunk.value
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new TicketMediaError("too-large", "too large")
      }
      hash.update(value)
      if (headLength < HEAD_BYTES) {
        const take = Math.min(HEAD_BYTES - headLength, value.byteLength)
        head.set(value.subarray(0, take), headLength)
        headLength += take
      }
      await handle.write(value)
    }
    if (bytes === 0)
      throw new TicketMediaError("unreadable", "The upload was empty.")
    await handle.sync()
  } finally {
    await handle.close()
  }
  return {
    bytes,
    sha256: hash.digest("hex"),
    head: head.subarray(0, headLength),
  }
}

export interface UploadInput {
  db: DeskverseDatabase
  dataRoot: string
  ticketId: string
  productId: string
  body: ReadableStream<Uint8Array> | null
  /** Content-Length, if the client sent one (checked before reading). */
  declaredLength: number | null
  declaredType: string
  fileName: string
  limits: TicketMediaLimits
  tools: MediaTools
  /** Test hook: runs after the file is in place, before the database insert. */
  beforeRecord?: () => Promise<void> | void
}

const isImageType = (type: string): type is ImageMimeType =>
  (TICKET_IMAGE_TYPES as readonly string[]).includes(type)

const MIB = (bytes: number) => `${Math.round(bytes / MB)} MB`

/** Stores one upload. Throws MediaRejected, TicketMediaError or TicketError. */
export async function storeUpload(input: UploadInput): Promise<TicketAsset> {
  const { dataRoot, ticketId, productId, limits } = input
  checkIds(ticketId, productId)
  const declared =
    input.declaredType === "image/jpg" ? "image/jpeg" : input.declaredType
  const isVideo = declared === "video/mp4"
  if (!isVideo && !isImageType(declared))
    throw new MediaRejected(
      "Upload JPEG, PNG or WebP images, or MP4 video clips.",
    )
  const maxBytes = isVideo ? limits.maxVideoBytes : limits.maxImageBytes
  const tooLarge = () =>
    new TicketMediaError(
      "too-large",
      `${isVideo ? "Video clips" : "Images"} must be ${MIB(maxBytes)} or smaller.`,
    )
  if (input.declaredLength !== null && input.declaredLength > maxBytes)
    throw tooLarge()

  const assetId = randomUUID()
  const staging = await ensureDir(dataRoot, "tickets", ticketId, "staging")
  const stagedFile = path.join(staging, `${assetId}.part`)
  let finalFile: string | null = null
  try {
    let staged: Staged
    try {
      staged = await streamToFile(input.body, stagedFile, maxBytes)
    } catch (error) {
      if (error instanceof TicketMediaError && error.code === "too-large")
        throw tooLarge()
      throw error
    }
    const detected = sniffTicketMedia(staged.head)
    if (!detected)
      throw new MediaRejected(
        "The file's contents aren't a JPEG, PNG, WebP image or MP4 video, whatever its name says.",
      )
    if (detected !== declared)
      throw new MediaRejected(
        `The file's contents are ${detected === "video/mp4" ? "an MP4 video" : `a ${detected.slice(6).toUpperCase()} image`}, not the ${declared} it was sent as.`,
      )
    const verified =
      detected === "video/mp4"
        ? await verifyVideo(
            stagedFile,
            {
              maxSeconds: limits.maxVideoSeconds,
              maxSide: limits.maxVideoSide,
              minSide: limits.minVideoSide,
            },
            input.tools,
          )
        : await verifyImage(stagedFile, detected, staged.head, input.tools)

    const record: NewAssetRecord = {
      id: assetId,
      kind: verified.kind,
      mimeType: detected,
      extension: EXTENSION[detected],
      byteSize: staged.bytes,
      sha256: staged.sha256,
      width: verified.width,
      height: verified.height,
      durationMs: verified.kind === "video" ? verified.durationMs : null,
      originalName: displayName(input.fileName, EXTENSION[detected]),
    }
    await ensureDir(dataRoot, "tickets", ticketId, "assets")
    finalFile = assetFilePath(dataRoot, ticketId, assetId, record.extension)
    await fs.rename(stagedFile, finalFile)
    await input.beforeRecord?.()
    return await recordAsset(input.db, ticketId, productId, record, limits)
  } catch (error) {
    await fs.rm(stagedFile, { force: true }).catch(() => {})
    if (finalFile) await fs.rm(finalFile, { force: true }).catch(() => {})
    throw error
  }
}

/** A display-only name: no path parts, no control characters, bounded. */
export function displayName(raw: string, extension: string) {
  const base = raw.split(/[\\/]/).pop() ?? ""
  const clean = base
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 200)
  return clean || `file.${extension}`
}

// ---------------------------------------------------------------------------
// Read and delete
// ---------------------------------------------------------------------------

export interface AssetLocation {
  ticketId: string
  id: string
  extension: string
  byteSize: number
}

/** The file of a registered asset, checked: regular, no symlink, right size. */
export async function openAssetFile(dataRoot: string, asset: AssetLocation) {
  const file = assetFilePath(
    dataRoot,
    asset.ticketId,
    asset.id,
    asset.extension,
  )
  let stat
  try {
    stat = await assertSafeFile(dataRoot, file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new TicketMediaError(
        "missing",
        "This file is missing from the media folder. Remove it and upload it again.",
      )
    throw error
  }
  if (stat.size !== asset.byteSize)
    throw new TicketMediaError(
      "missing",
      "This file has changed on disk since it was uploaded. Remove it and upload it again.",
    )
  return { file, size: stat.size }
}

/** Deletes an asset's file after its record is gone. Missing is fine. */
export async function deleteAssetFile(dataRoot: string, asset: AssetLocation) {
  const file = assetFilePath(
    dataRoot,
    asset.ticketId,
    asset.id,
    asset.extension,
  )
  try {
    const stat = await fs.lstat(file)
    if (stat.isSymbolicLink() || stat.isFile()) await fs.unlink(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn(
        "[deskverse] couldn't delete a removed ticket file; yarn tickets:reconcile will",
      )
  }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface ReconcileReport {
  /** Unfinished uploads (staging/*.part). */
  staging: string[]
  /** Files in assets/ with no database record (relative paths). */
  orphans: string[]
  /** Records whose file is missing, a link, or the wrong size/checksum. */
  damaged: { ticketId: string; assetId: string; problem: string }[]
  /** Entries that aren't ticket folders or asset files. */
  unrecognized: string[]
}

async function sha256File(file: string) {
  const hash = createHash("sha256")
  hash.update(await fs.readFile(file))
  return hash.digest("hex")
}

/**
 * Compares the media folder with the database. With `apply`, deletes
 * unfinished uploads and moves orphans to <data dir>/tickets-orphaned/
 * (nothing referenced is ever touched). Damaged records are only reported.
 */
export async function reconcileTicketMedia(
  db: DeskverseDatabase,
  dataRoot: string,
  { apply = false, now = new Date() }: { apply?: boolean; now?: Date } = {},
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    staging: [],
    orphans: [],
    damaged: [],
    unrecognized: [],
  }
  const root = ticketsRoot(dataRoot)
  const records = await allAssets(db)
  const byFile = new Map(
    records.map((r) => [`${r.ticketId}/assets/${r.id}.${r.extension}`, r]),
  )

  let tickets: import("node:fs").Dirent[] = []
  try {
    tickets = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const seen = new Set<string>()
  for (const ticket of tickets) {
    if (!ticket.isDirectory() || !isUuid(ticket.name)) {
      report.unrecognized.push(ticket.name)
      continue
    }
    for (const folder of await fs.readdir(path.join(root, ticket.name), {
      withFileTypes: true,
    })) {
      const dir = path.join(root, ticket.name, folder.name)
      if (folder.name === "staging" && folder.isDirectory()) {
        for (const entry of await fs.readdir(dir))
          report.staging.push(`${ticket.name}/staging/${entry}`)
      } else if (folder.name === "assets" && folder.isDirectory()) {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const relative = `${ticket.name}/assets/${entry.name}`
          if (!entry.isFile() || !ASSET_FILE.test(entry.name)) {
            report.unrecognized.push(relative)
            continue
          }
          if (byFile.has(relative)) seen.add(relative)
          else report.orphans.push(relative)
        }
      } else report.unrecognized.push(`${ticket.name}/${folder.name}`)
    }
  }
  for (const [relative, record] of byFile) {
    const file = path.join(root, relative)
    let problem: string | null = null
    if (!seen.has(relative)) problem = "file missing"
    else {
      const stat = await fs.lstat(file)
      if (stat.size !== record.byteSize) problem = "wrong size"
      else if ((await sha256File(file)) !== record.sha256)
        problem = "checksum mismatch"
    }
    if (problem)
      report.damaged.push({
        ticketId: record.ticketId,
        assetId: record.id,
        problem,
      })
  }

  if (apply) {
    for (const relative of report.staging)
      await fs.rm(path.join(root, relative), { force: true })
    if (report.orphans.length > 0) {
      const stamp = now
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "Z")
      const quarantine = path.join(
        path.resolve(dataRoot),
        "tickets-orphaned",
        stamp,
      )
      for (const relative of report.orphans) {
        const target = path.join(quarantine, relative)
        await fs.mkdir(path.dirname(target), {
          recursive: true,
          mode: DIR_MODE,
        })
        await fs.rename(path.join(root, relative), target)
      }
    }
  }
  return report
}

export { MediaRejected, TicketError }
