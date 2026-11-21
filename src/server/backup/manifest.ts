/**
 * The manifest written into every Deskverse backup (DV-004A, v2 in DV-004B).
 *
 * Versions:
 * - 1 (DV-004A): database + Pixel Studio's video/jobs files.
 * - 2 (DV-004B): adds `ticketMedia`, the registered Affiliate Ticket
 *   attachments under tickets/. Version 1 backups remain restorable.
 *
 * It identifies what the backup holds and lets `yarn db:backup:verify`
 * prove nothing changed since: a SHA-256 for the database dump and for
 * every media file. It never contains a password, a user name, a
 * connection string or an absolute path.
 */

export const BACKUP_FORMAT = "deskverse-backup"
export const BACKUP_FORMAT_VERSION = 2
/** Versions this code can verify and restore. */
export const READABLE_FORMAT_VERSIONS = [1, 2] as const

export const DATABASE_DUMP_FILE = "database.dump"
export const MANIFEST_FILE = "manifest.json"
export const MANIFEST_CHECKSUM_FILE = "manifest.sha256"
/** Media files live under this folder of the backup, mirroring the data folder. */
export const MEDIA_DIR = "media"
/** Pixel Studio's part of the data folder. */
export const MEDIA_SOURCE = "video/jobs"
/** Affiliate Ticket attachments (format 2). */
export const TICKET_MEDIA_SOURCE = "tickets"

export interface ManifestFile {
  /** POSIX path relative to the backup's media/ folder, e.g. video/jobs/job_…/job.json. */
  path: string
  bytes: number
  sha256: string
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT
  formatVersion: (typeof READABLE_FORMAT_VERSIONS)[number]
  createdAt: string
  /** Taken with Deskverse and its workers stopped (the only supported procedure). */
  procedure: "offline"
  deskverse: { version: string }
  database: {
    file: typeof DATABASE_DUMP_FILE
    format: "pg_dump-custom"
    bytes: number
    sha256: string
    /** e.g. "16.10"; restore needs PostgreSQL this version or newer. */
    serverVersion: string
    pgDumpVersion: string
    migrations: { applied: number; current: string | null }
    /** Row counts of every table in the public schema at backup time. */
    tables: Record<string, number>
  }
  media: {
    source: typeof MEDIA_SOURCE
    jobs: number
    files: ManifestFile[]
    bytes: number
    /** What was deliberately left out, for the record. */
    excluded: {
      /** Per-job temporary render folders (work/). */
      scratchFolders: number
      /** Entries that aren't render jobs or job files, and symlinks. */
      unrecognized: number
    }
  }
  /**
   * Format 2: every Affiliate Ticket attachment registered in the database,
   * each checked against its record (size and SHA-256) when backed up.
   */
  ticketMedia?: {
    source: typeof TICKET_MEDIA_SOURCE
    /** Number of ticket_assets records (equals files.length). */
    assets: number
    files: ManifestFile[]
    bytes: number
    excluded: {
      /** Files with no database record (see yarn tickets:reconcile). */
      orphans: number
      /** Unfinished uploads. */
      staging: number
      unrecognized: number
    }
  }
}

const SHA256 = /^[0-9a-f]{64}$/
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const PIXEL_PATH = /^video\/jobs\/job_[0-9a-f]{32}(\/[A-Za-z0-9._-]+)+$/
const TICKET_PATH = new RegExp(
  `^tickets/${UUID}/assets/${UUID}\\.(jpg|png|webp|mp4)$`,
)

function validFiles(files: unknown, pattern: RegExp) {
  return (
    Array.isArray(files) &&
    files.every(
      (file) =>
        typeof file?.path === "string" &&
        pattern.test(file.path) &&
        !file.path
          .split("/")
          .some((part: string) => part === "." || part === "..") &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes >= 0 &&
        typeof file.sha256 === "string" &&
        SHA256.test(file.sha256),
    )
  )
}

/** Shape check for a manifest read back from disk. Returns problems found. */
export function manifestProblems(value: unknown): string[] {
  const problems: string[] = []
  const m = value as Partial<BackupManifest> | null
  if (typeof m !== "object" || m === null) return ["manifest isn't an object"]
  if (m.format !== BACKUP_FORMAT) problems.push("not a Deskverse backup")
  if (
    !(READABLE_FORMAT_VERSIONS as readonly unknown[]).includes(m.formatVersion)
  )
    problems.push(
      `unsupported backup format version ${String(m.formatVersion)} (this version reads ${READABLE_FORMAT_VERSIONS.join(" and ")})`,
    )
  const db = m.database
  if (
    !db ||
    db.file !== DATABASE_DUMP_FILE ||
    typeof db.bytes !== "number" ||
    typeof db.sha256 !== "string" ||
    !SHA256.test(db.sha256)
  )
    problems.push("database section is invalid")
  if (!m.media || !Array.isArray(m.media.files))
    problems.push("media section is invalid")
  else if (!validFiles(m.media.files, PIXEL_PATH))
    problems.push("media file list has an invalid entry")
  if (m.formatVersion === 2) {
    const tickets = m.ticketMedia
    if (!tickets || tickets.source !== TICKET_MEDIA_SOURCE)
      problems.push("ticket media section is missing or invalid")
    else if (!validFiles(tickets.files, TICKET_PATH))
      problems.push("ticket media file list has an invalid entry")
    else if (tickets.assets !== tickets.files.length)
      problems.push("ticket media count doesn't match its file list")
  } else if (m.formatVersion === 1 && m.ticketMedia !== undefined)
    problems.push("a version 1 backup can't contain ticket media")
  return problems
}
