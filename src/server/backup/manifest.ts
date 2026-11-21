/**
 * The manifest written into every Deskverse backup (DV-004A).
 *
 * It identifies what the backup holds and lets `yarn db:backup:verify`
 * prove nothing changed since: a SHA-256 for the database dump and for
 * every media file. It never contains a password, a user name, a
 * connection string or an absolute path.
 */

export const BACKUP_FORMAT = "deskverse-backup"
export const BACKUP_FORMAT_VERSION = 1

export const DATABASE_DUMP_FILE = "database.dump"
export const MANIFEST_FILE = "manifest.json"
export const MANIFEST_CHECKSUM_FILE = "manifest.sha256"
/** Media files live under this folder of the backup, mirroring the data folder. */
export const MEDIA_DIR = "media"
/** The part of the data folder that is backed up. */
export const MEDIA_SOURCE = "video/jobs"

export interface ManifestFile {
  /** POSIX path relative to the backup's media/ folder, e.g. video/jobs/job_…/job.json. */
  path: string
  bytes: number
  sha256: string
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT
  formatVersion: typeof BACKUP_FORMAT_VERSION
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
}

const SHA256 = /^[0-9a-f]{64}$/
const SAFE_PATH = /^video\/jobs\/job_[0-9a-f]{32}(\/[A-Za-z0-9._-]+)+$/

/** Shape check for a manifest read back from disk. Returns problems found. */
export function manifestProblems(value: unknown): string[] {
  const problems: string[] = []
  const m = value as Partial<BackupManifest> | null
  if (typeof m !== "object" || m === null) return ["manifest isn't an object"]
  if (m.format !== BACKUP_FORMAT) problems.push("not a Deskverse backup")
  if (m.formatVersion !== BACKUP_FORMAT_VERSION)
    problems.push(
      `unsupported backup format version ${String(m.formatVersion)} (this version reads ${BACKUP_FORMAT_VERSION})`,
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
  const media = m.media
  if (!media || !Array.isArray(media.files))
    problems.push("media section is invalid")
  else
    for (const file of media.files)
      if (
        typeof file?.path !== "string" ||
        !SAFE_PATH.test(file.path) ||
        file.path.split("/").some((part) => part === "." || part === "..") ||
        typeof file.bytes !== "number" ||
        typeof file.sha256 !== "string" ||
        !SHA256.test(file.sha256)
      ) {
        problems.push("media file list has an invalid entry")
        break
      }
  return problems
}
