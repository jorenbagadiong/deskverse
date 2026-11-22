import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream, promises as fs } from "node:fs"
import path from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

import pg from "pg"

import { getReview } from "@/server/vera/store"
import { isRenderJobId } from "@/lib/video/ids"
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  DATABASE_DUMP_FILE,
  MANIFEST_CHECKSUM_FILE,
  MANIFEST_FILE,
  MEDIA_DIR,
  MEDIA_SOURCE,
  TICKET_MEDIA_SOURCE,
  TICKET_VIDEO_SOURCE,
  manifestProblems,
  type BackupManifest,
  type ManifestFile,
} from "@/server/backup/manifest"
import { redact, type DatabaseConfig } from "@/server/db/config"
import { classifyDatabaseError } from "@/server/db/errors"
import { migrationStatus, type Journal } from "@/server/db/migrations"

/**
 * Offline backup and restore of Deskverse's data (DV-004A).
 *
 * A backup holds:
 *   manifest.json     what is inside, with SHA-256 checksums (no secrets)
 *   manifest.sha256   checksum of the manifest itself
 *   database.dump     pg_dump custom format (no owners, no privileges, no passwords)
 *   media/video/jobs/<jobId>/{job.json, project.json, assets/…, output/…}
 *
 * Each job's work/ folder (temporary render files) is left out.
 *
 * Consistency: a database dump and a file copy aren't one atomic snapshot.
 * The only supported procedure is offline: stop Deskverse (and any worker)
 * first. createBackup refuses while a Deskverse server or render process is
 * running, or while anything else is connected to the database.
 *
 * Restore never overwrites anything: the target database must be empty and
 * the target data folder must not exist yet (or be empty).
 */

export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BackupError"
  }
}

const DIR_MODE = 0o700
const FILE_MODE = 0o600
const TOOL_TIMEOUT_MS = 10 * 60_000

// ---------------------------------------------------------------------------
// PostgreSQL client tools
// ---------------------------------------------------------------------------

/**
 * Runs pg_dump / pg_restore with the connection in libpq environment
 * variables, so the password never appears on a command line (visible to
 * other processes) and never in an error message.
 */
function runPgTool(
  program: "pg_dump" | "pg_restore",
  args: string[],
  db: DatabaseConfig | null,
): Promise<string> {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    PGCONNECT_TIMEOUT: "5",
  }
  if (db) {
    env.PGHOST = db.host
    env.PGPORT = String(db.port)
    env.PGUSER = db.user
    env.PGPASSWORD = db.password
    env.PGDATABASE = db.database
  }
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      {
        // A minimal environment: nothing else from this process leaks in.
        env: env as NodeJS.ProcessEnv,
        timeout: TOOL_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout)
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT"
        const detail = redact(
          String(stderr || error.message)
            .trim()
            .split("\n")
            .slice(0, 3)
            .join(" "),
          db?.password ?? "",
        )
        reject(
          new BackupError(
            missing
              ? `${program} isn't installed. Install it with: sudo apt install postgresql-client`
              : `${program} failed: ${detail}`,
          ),
        )
      },
    )
  })
}

async function toolVersion(program: "pg_dump" | "pg_restore") {
  const out = await runPgTool(program, ["--version"], null)
  return /(\d+(?:\.\d+)*)/.exec(out)?.[1] ?? "unknown"
}

/** Throws unless pg_restore can read the whole table of contents. */
async function checkDumpReadable(file: string) {
  const list = await runPgTool("pg_restore", ["--list", file], null)
  if (!/^; Archive created at/m.test(list))
    throw new BackupError("The database dump isn't a readable pg_dump archive.")
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

async function sha256File(file: string) {
  const hash = createHash("sha256")
  await pipeline(createReadStream(file), hash)
  return hash.digest("hex")
}

/** Copies a file and returns the SHA-256 of the bytes read. */
async function copyWithHash(from: string, to: string) {
  const hash = createHash("sha256")
  let bytes = 0
  await fs.mkdir(path.dirname(to), { recursive: true, mode: DIR_MODE })
  await pipeline(
    createReadStream(from),
    new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk)
        bytes += chunk.byteLength
        done(null, chunk)
      },
    }),
    createWriteStream(to, { flags: "wx", mode: FILE_MODE }),
  )
  return { bytes, sha256: hash.digest("hex") }
}

function isInside(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}

async function isEmptyOrMissing(dir: string) {
  try {
    return (await fs.readdir(dir)).length === 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw error
  }
}

/** Job files that are backed up; everything else in a job folder is not. */
const JOB_FILES = new Set(["job.json", "project.json"])
const JOB_FOLDERS = new Set(["assets", "output"])
const SCRATCH_FOLDER = "work"

interface MediaPlan {
  files: { source: string; relative: string }[]
  jobs: number
  scratchFolders: number
  unrecognized: number
}

/** Lists what to copy from <dataRoot>/video/jobs. Never follows symlinks. */
export async function planMediaBackup(dataRoot: string): Promise<MediaPlan> {
  const plan: MediaPlan = {
    files: [],
    jobs: 0,
    scratchFolders: 0,
    unrecognized: 0,
  }
  const jobsRoot = path.join(dataRoot, MEDIA_SOURCE)
  let jobs: import("node:fs").Dirent[]
  try {
    jobs = await fs.readdir(jobsRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return plan
    throw error
  }
  for (const job of jobs.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!job.isDirectory() || !isRenderJobId(job.name)) {
      plan.unrecognized++
      continue
    }
    plan.jobs++
    const jobDir = path.join(jobsRoot, job.name)
    for (const entry of await fs.readdir(jobDir, { withFileTypes: true })) {
      const full = path.join(jobDir, entry.name)
      if (entry.isFile() && JOB_FILES.has(entry.name))
        plan.files.push({
          source: full,
          relative: `${MEDIA_SOURCE}/${job.name}/${entry.name}`,
        })
      else if (entry.isDirectory() && entry.name === SCRATCH_FOLDER)
        plan.scratchFolders++
      else if (entry.isDirectory() && JOB_FOLDERS.has(entry.name))
        await collect(full, `${MEDIA_SOURCE}/${job.name}/${entry.name}`, plan)
      else plan.unrecognized++
    }
  }
  return plan
}

async function collect(dir: string, relative: string, plan: MediaPlan) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (!/^[A-Za-z0-9._-]+$/.test(entry.name) || entry.name.startsWith(".")) {
      plan.unrecognized++
    } else if (entry.isFile()) {
      plan.files.push({ source: full, relative: `${relative}/${entry.name}` })
    } else if (entry.isDirectory()) {
      await collect(full, `${relative}/${entry.name}`, plan)
    } else plan.unrecognized++ // symlinks, sockets…
  }
}

/** A registered Affiliate Ticket attachment (from ticket_assets). */
export interface TicketAssetRecord {
  id: string
  ticketId: string
  extension: string
  bytes: number
  sha256: string
}

interface TicketMediaPlan {
  files: (TicketAssetRecord & { source: string; relative: string })[]
  orphans: number
  staging: number
  unrecognized: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TICKET_FILE = /^([0-9a-f-]{36})\.(jpg|png|webp|mp4)$/

async function lstatOrNull(target: string) {
  try {
    return await fs.lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/**
 * Lists the ticket attachments to back up: exactly the files the database
 * registers. Every record must have its file, as a regular file reached
 * through no symlink, of the recorded size; otherwise the backup stops
 * (run yarn tickets:reconcile). Files without a record are left out and
 * counted, as are unfinished uploads.
 */
export async function planTicketMediaBackup(
  dataRoot: string,
  records: TicketAssetRecord[],
): Promise<TicketMediaPlan> {
  const plan: TicketMediaPlan = {
    files: [],
    orphans: 0,
    staging: 0,
    unrecognized: 0,
  }
  const root = path.join(dataRoot, TICKET_MEDIA_SOURCE)
  const problems: string[] = []
  const registered = new Set<string>()
  for (const record of records) {
    if (
      !UUID.test(record.id) ||
      !UUID.test(record.ticketId) ||
      !/^(jpg|png|webp|mp4)$/.test(record.extension)
    ) {
      problems.push(`a record has an invalid identifier`)
      continue
    }
    const relative = `${TICKET_MEDIA_SOURCE}/${record.ticketId}/assets/${record.id}.${record.extension}`
    registered.add(relative)
    let current = dataRoot
    let ok = true
    for (const part of relative.split("/")) {
      current = path.join(current, part)
      const stat = await lstatOrNull(current)
      if (!stat) {
        problems.push(`${relative} is missing`)
        ok = false
        break
      }
      if (stat.isSymbolicLink()) {
        problems.push(`${relative} is reached through a symbolic link`)
        ok = false
        break
      }
    }
    if (!ok) continue
    const stat = await fs.lstat(current)
    if (!stat.isFile()) problems.push(`${relative} isn't a regular file`)
    else if (stat.size !== record.bytes)
      problems.push(`${relative} doesn't match its recorded size`)
    else plan.files.push({ ...record, source: current, relative })
  }
  if (problems.length > 0)
    throw new BackupError(
      `Some Affiliate Ticket files don't match the database, so nothing was backed up (run yarn tickets:reconcile): ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` and ${problems.length - 5} more` : ""}.`,
    )

  // Count what is deliberately left out.
  const tickets = await fs
    .readdir(root, { withFileTypes: true })
    .catch(() => [])
  for (const ticket of tickets) {
    if (!ticket.isDirectory() || !UUID.test(ticket.name)) {
      plan.unrecognized++
      continue
    }
    for (const folder of await fs.readdir(path.join(root, ticket.name), {
      withFileTypes: true,
    })) {
      const dir = path.join(root, ticket.name, folder.name)
      if (folder.isDirectory() && folder.name === "staging")
        plan.staging += (await fs.readdir(dir)).length
      else if (folder.isDirectory() && folder.name === "assets")
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const relative = `${TICKET_MEDIA_SOURCE}/${ticket.name}/assets/${entry.name}`
          if (registered.has(relative)) continue
          if (entry.isFile() && TICKET_FILE.test(entry.name)) plan.orphans++
          else plan.unrecognized++
        }
      else plan.unrecognized++
    }
  }
  return plan
}

/** A committed ticket video (DV-005C) and its MP4's recorded facts. */
export interface TicketVideoRecord {
  pixelJobId: string
  bytes: number
  sha256: string
}

/** Vera stores compact durable evidence in PostgreSQL; sampled raw frames are disposable. */
async function verifyVeraRecords(client: pg.Client) {
  if (
    !(
      await client.query(
        "SELECT to_regclass('public.vera_reviews') IS NOT NULL AS present",
      )
    ).rows[0].present
  )
    return
  const reviews = (await client.query("SELECT id, ticket_id FROM vera_reviews"))
    .rows
  for (const r of reviews) {
    const review = await getReview(client, r.ticket_id, r.id)
    if (!review || review.integrity !== "verified")
      throw new BackupError(
        "A Vera review fails its checksum; restore its original records before backing up.",
      )
  }
}

async function ticketVideoRecords(
  client: pg.Client,
): Promise<TicketVideoRecord[]> {
  const exists = await client.query<{ present: boolean }>(
    "SELECT to_regclass('public.pixel_deliverables') IS NOT NULL AS present",
  )
  if (!exists.rows[0].present) return []
  const result = await client.query<{
    pixel_job_id: string
    byte_size: string
    sha256: string
  }>(
    "SELECT pixel_job_id, byte_size, sha256 FROM pixel_deliverables ORDER BY pixel_job_id",
  )
  return result.rows.map((r) => ({
    pixelJobId: r.pixel_job_id,
    bytes: Number(r.byte_size),
    sha256: r.sha256,
  }))
}

/**
 * Lists the files of every committed ticket video's Pixel job (format 3):
 * job.json, project.json, input images and output/video.mp4. Each MP4 must
 * exist as a regular file (no symlinks) of the recorded size, else the
 * backup stops (run yarn pixel:reconcile). Scratch folders are left out.
 */
export async function planTicketVideoBackup(
  dataRoot: string,
  records: TicketVideoRecord[],
) {
  const files: {
    source: string
    relative: string
    expect?: TicketVideoRecord
  }[] = []
  for (const record of records) {
    if (!isRenderJobId(record.pixelJobId))
      throw new BackupError("A ticket video record has an invalid job id.")
    const relative = `${TICKET_VIDEO_SOURCE}/${record.pixelJobId}`
    const dir = path.join(dataRoot, ...relative.split("/"))
    const stat = await lstatOrNull(dir)
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink())
      throw new BackupError(
        `The folder of ticket video ${record.pixelJobId} is missing, so nothing was backed up (run yarn pixel:reconcile).`,
      )
    for (const name of ["job.json", "project.json"]) {
      const f = await lstatOrNull(path.join(dir, name))
      if (f?.isFile())
        files.push({
          source: path.join(dir, name),
          relative: `${relative}/${name}`,
        })
    }
    const assets = path.join(dir, "assets")
    const entries = await fs
      .readdir(assets, { withFileTypes: true })
      .catch(() => [])
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name)))
      if (e.isFile() && /^asset_[0-9a-f]{32}\.(jpg|png|webp)$/.test(e.name))
        files.push({
          source: path.join(assets, e.name),
          relative: `${relative}/assets/${e.name}`,
        })
    const video = path.join(dir, "output", "video.mp4")
    const v = await lstatOrNull(video)
    if (!v || !v.isFile() || v.isSymbolicLink() || v.size !== record.bytes)
      throw new BackupError(
        `The MP4 of ticket video ${record.pixelJobId} is missing or changed, so nothing was backed up (run yarn pixel:reconcile).`,
      )
    files.push({
      source: video,
      relative: `${relative}/output/video.mp4`,
      expect: record,
    })
  }
  return files
}

async function ticketAssetRecords(
  client: pg.Client,
): Promise<TicketAssetRecord[]> {
  const exists = await client.query<{ present: boolean }>(
    "SELECT to_regclass('public.ticket_assets') IS NOT NULL AS present",
  )
  if (!exists.rows[0].present) return []
  const result = await client.query<{
    id: string
    ticket_id: string
    extension: string
    byte_size: string
    sha256: string
  }>(
    "SELECT id, ticket_id, extension, byte_size, sha256 FROM ticket_assets ORDER BY ticket_id, id",
  )
  return result.rows.map((r) => ({
    id: r.id,
    ticketId: r.ticket_id,
    extension: r.extension,
    bytes: Number(r.byte_size),
    sha256: r.sha256,
  }))
}

// ---------------------------------------------------------------------------
// Is Deskverse running?
// ---------------------------------------------------------------------------

export interface ActiveProcess {
  pid: number
  kind: "deskverse-server" | "data-folder"
}

/**
 * Finds a running Deskverse Next.js server (any process whose working
 * directory is the repository and whose command is `next …` or
 * `next-server`) and any process working inside the data folder (FFmpeg
 * renders). Linux only (/proc); elsewhere returns null ("can't tell").
 */
export async function findActiveProcesses(
  projectRoot: string,
  dataRoot: string,
  procRoot = "/proc",
): Promise<ActiveProcess[] | null> {
  let pids: string[]
  try {
    pids = (await fs.readdir(procRoot)).filter((name) => /^\d+$/.test(name))
  } catch {
    return null
  }
  const active: ActiveProcess[] = []
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue
    let cwd: string
    let cmdline: string
    try {
      cwd = await fs.readlink(path.join(procRoot, pid, "cwd"))
      cmdline = (await fs.readFile(path.join(procRoot, pid, "cmdline"), "utf8"))
        .split("\0")
        .join(" ")
    } catch {
      continue // another user's process, or it just exited
    }
    if (isInside(dataRoot, cwd))
      active.push({ pid: Number(pid), kind: "data-folder" })
    else if (
      cwd === projectRoot &&
      /(^|[\s/])next(-server)?(\s|$)/.test(cmdline)
    )
      active.push({ pid: Number(pid), kind: "deskverse-server" })
  }
  return active
}

// ---------------------------------------------------------------------------
// Database facts
// ---------------------------------------------------------------------------

function connect(db: DatabaseConfig, applicationName: string) {
  const client = new pg.Client({
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.user,
    password: db.password,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    application_name: applicationName,
  })
  client.on("error", () => {})
  return client
}

async function withClient<T>(
  db: DatabaseConfig,
  applicationName: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = connect(db, applicationName)
  try {
    await client.connect()
  } catch (error) {
    throw new BackupError(classifyDatabaseError(error).message)
  }
  try {
    return await work(client)
  } finally {
    await client.end().catch(() => {})
  }
}

/** Row counts of every ordinary table in the public schema. */
async function tableCounts(client: pg.Client) {
  const tables = await client.query<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`,
  )
  const counts: Record<string, number> = {}
  for (const { name } of tables.rows) {
    // Identifiers can't be query parameters; this quotes them safely.
    const result = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM public.${client.escapeIdentifier(name)}`,
    )
    counts[name] = Number(result.rows[0].n)
  }
  return counts
}

/** Number of user objects (tables, views, sequences…) outside system schemas. */
async function userObjectCount(client: pg.Client) {
  const result = await client.query<{ n: string }>(
    `SELECT count(*) AS n
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp%'`,
  )
  return Number(result.rows[0].n)
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

export interface CreateBackupOptions {
  db: DatabaseConfig
  journal: Journal
  /** Deskverse's data folder (resolveDataRoot()). */
  dataRoot: string
  /** Folder that receives deskverse-backup-<time>/. */
  backupsRoot: string
  /** The repository, to detect a running Deskverse server. */
  projectRoot: string
  deskverseVersion: string
  now?: () => Date
  /** Tests that don't start a server may skip the /proc scan. */
  checkProcesses?: boolean
}

export interface BackupResult {
  dir: string
  manifest: BackupManifest
}

export async function createBackup(
  options: CreateBackupOptions,
): Promise<BackupResult> {
  const {
    db,
    journal,
    dataRoot,
    backupsRoot,
    projectRoot,
    deskverseVersion,
    now = () => new Date(),
    checkProcesses = true,
  } = options
  for (const [label, dir] of [
    ["backup folder", backupsRoot],
    ["data folder", dataRoot],
  ] as const)
    if (!path.isAbsolute(dir))
      throw new BackupError(`The ${label} must be an absolute path.`)
  if (isInside(dataRoot, backupsRoot) || isInside(backupsRoot, dataRoot))
    throw new BackupError(
      "Keep backups outside the Deskverse data folder (and vice versa).",
    )
  if (isInside(projectRoot, backupsRoot))
    throw new BackupError(
      "Keep backups outside the repository, so media and dumps can't be committed.",
    )

  // 1. Offline check.
  if (checkProcesses) {
    const active = await findActiveProcesses(projectRoot, dataRoot)
    if (active === null)
      throw new BackupError(
        "Can't check for running Deskverse processes on this system (no /proc).",
      )
    if (active.length > 0)
      throw new BackupError(
        `Stop Deskverse before backing up. Still running: ${active
          .map((p) =>
            p.kind === "deskverse-server"
              ? `Deskverse server (pid ${p.pid})`
              : `a process using the data folder (pid ${p.pid})`,
          )
          .join(", ")}.`,
      )
  }

  // 2. Database facts, and nobody else connected.
  const facts = await withClient(db, "deskverse-backup", async (client) => {
    const others = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    )
    if (Number(others.rows[0].n) > 0)
      throw new BackupError(
        "Another program is connected to the Deskverse database. Stop Deskverse (and any worker) first.",
      )
    const status = await migrationStatus(client, journal)
    if (status.ahead || status.pending.length > 0)
      throw new BackupError(
        "The database schema isn't current. Run yarn db:migrate (or update the code) before backing up.",
      )
    await verifyVeraRecords(client)
    const version = await client.query<{ v: string }>(
      "SELECT current_setting('server_version') AS v",
    )
    return {
      status,
      serverVersion: version.rows[0].v.split(" ")[0],
      tables: await tableCounts(client),
      ticketAssets: await ticketAssetRecords(client),
      ticketVideos: await ticketVideoRecords(client),
    }
  })
  // Checked before anything is written.
  const ticketPlan = await planTicketMediaBackup(dataRoot, facts.ticketAssets)
  const videoPlan = await planTicketVideoBackup(dataRoot, facts.ticketVideos)

  // 3. Write into a .partial folder; rename only when complete and verified.
  const stamp = now()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
  const name = `deskverse-backup-${stamp}`
  const finalDir = path.join(backupsRoot, name)
  const workDir = `${finalDir}.partial`
  await fs.mkdir(backupsRoot, { recursive: true, mode: DIR_MODE })
  if (!(await isEmptyOrMissing(finalDir)))
    throw new BackupError(`A backup named ${name} already exists.`)
  await fs.mkdir(workDir, { mode: DIR_MODE })

  try {
    const dumpFile = path.join(workDir, DATABASE_DUMP_FILE)
    await runPgTool(
      "pg_dump",
      [
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--no-password",
        `--file=${dumpFile}`,
      ],
      db,
    )
    await fs.chmod(dumpFile, FILE_MODE)
    await checkDumpReadable(dumpFile)

    const plan = await planMediaBackup(dataRoot)
    const files: ManifestFile[] = []
    let bytes = 0
    for (const file of plan.files) {
      const copied = await copyWithHash(
        file.source,
        path.join(workDir, MEDIA_DIR, ...file.relative.split("/")),
      )
      files.push({ path: file.relative, ...copied })
      bytes += copied.bytes
    }
    const ticketFiles: ManifestFile[] = []
    let ticketBytes = 0
    for (const file of ticketPlan.files) {
      const copied = await copyWithHash(
        file.source,
        path.join(workDir, MEDIA_DIR, ...file.relative.split("/")),
      )
      if (copied.sha256 !== file.sha256 || copied.bytes !== file.bytes)
        throw new BackupError(
          `${file.relative} doesn't match the checksum recorded when it was uploaded, so nothing was backed up (run yarn tickets:reconcile).`,
        )
      ticketFiles.push({ path: file.relative, ...copied })
      ticketBytes += copied.bytes
    }

    const videoFiles: ManifestFile[] = []
    let videoBytes = 0
    for (const file of videoPlan) {
      const copied = await copyWithHash(
        file.source,
        path.join(workDir, MEDIA_DIR, ...file.relative.split("/")),
      )
      if (
        file.expect &&
        (copied.sha256 !== file.expect.sha256 ||
          copied.bytes !== file.expect.bytes)
      )
        throw new BackupError(
          `${file.relative} doesn't match the checksum recorded when it was verified, so nothing was backed up (run yarn pixel:reconcile).`,
        )
      videoFiles.push({ path: file.relative, ...copied })
      videoBytes += copied.bytes
    }

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: now().toISOString(),
      procedure: "offline",
      deskverse: { version: deskverseVersion },
      database: {
        file: DATABASE_DUMP_FILE,
        format: "pg_dump-custom",
        bytes: (await fs.stat(dumpFile)).size,
        sha256: await sha256File(dumpFile),
        serverVersion: facts.serverVersion,
        pgDumpVersion: await toolVersion("pg_dump"),
        migrations: {
          applied: facts.status.applied,
          current: facts.status.current,
        },
        tables: facts.tables,
      },
      media: {
        source: MEDIA_SOURCE,
        jobs: plan.jobs,
        files,
        bytes,
        excluded: {
          scratchFolders: plan.scratchFolders,
          unrecognized: plan.unrecognized,
        },
      },
      ticketMedia: {
        source: TICKET_MEDIA_SOURCE,
        assets: ticketFiles.length,
        files: ticketFiles,
        bytes: ticketBytes,
        excluded: {
          orphans: ticketPlan.orphans,
          staging: ticketPlan.staging,
          unrecognized: ticketPlan.unrecognized,
        },
      },
      ticketVideos: {
        source: TICKET_VIDEO_SOURCE,
        deliverables: facts.ticketVideos.length,
        files: videoFiles,
        bytes: videoBytes,
      },
    }
    await writeManifest(workDir, manifest)
    const problems = await verifyBackup(workDir)
    if (problems.length > 0)
      throw new BackupError(
        `The new backup failed verification: ${problems.join("; ")}`,
      )
    await fs.rename(workDir, finalDir)
    return { dir: finalDir, manifest }
  } catch (error) {
    // Leave nothing half-written that could be mistaken for a backup.
    await fs.rm(workDir, { recursive: true, force: true })
    throw error
  }
}

async function writeManifest(dir: string, manifest: BackupManifest) {
  const text = `${JSON.stringify(manifest, null, 2)}\n`
  await fs.writeFile(path.join(dir, MANIFEST_FILE), text, {
    mode: FILE_MODE,
    flag: "wx",
  })
  const digest = createHash("sha256").update(text).digest("hex")
  await fs.writeFile(
    path.join(dir, MANIFEST_CHECKSUM_FILE),
    `${digest}  ${MANIFEST_FILE}\n`,
    { mode: FILE_MODE, flag: "wx" },
  )
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export async function readManifest(dir: string): Promise<BackupManifest> {
  let text: string
  try {
    text = await fs.readFile(path.join(dir, MANIFEST_FILE), "utf8")
  } catch {
    throw new BackupError(`${dir} has no ${MANIFEST_FILE}; it isn't a backup.`)
  }
  const value: unknown = JSON.parse(text)
  const problems = manifestProblems(value)
  if (problems.length > 0)
    throw new BackupError(`Invalid manifest: ${problems.join("; ")}`)
  return value as BackupManifest
}

/** Re-checks every checksum. Returns problems; empty means intact. */
export async function verifyBackup(dir: string): Promise<string[]> {
  const problems: string[] = []
  let text: string
  try {
    text = await fs.readFile(path.join(dir, MANIFEST_FILE), "utf8")
  } catch {
    return [`no ${MANIFEST_FILE}`]
  }
  try {
    const recorded = (
      await fs.readFile(path.join(dir, MANIFEST_CHECKSUM_FILE), "utf8")
    ).split(/\s+/)[0]
    if (createHash("sha256").update(text).digest("hex") !== recorded)
      problems.push("manifest.json doesn't match manifest.sha256")
  } catch {
    problems.push(`no ${MANIFEST_CHECKSUM_FILE}`)
  }
  let manifest: BackupManifest
  try {
    manifest = await readManifest(dir)
  } catch (error) {
    return [...problems, (error as Error).message]
  }

  const dump = path.join(dir, DATABASE_DUMP_FILE)
  try {
    if ((await sha256File(dump)) !== manifest.database.sha256)
      problems.push("database.dump checksum mismatch")
    else await checkDumpReadable(dump)
  } catch (error) {
    problems.push(
      error instanceof BackupError ? error.message : "database.dump is missing",
    )
  }

  const listed = new Set<string>()
  for (const file of [
    ...manifest.media.files,
    ...(manifest.ticketMedia?.files ?? []),
    ...(manifest.ticketVideos?.files ?? []),
  ]) {
    listed.add(file.path)
    const full = path.join(dir, MEDIA_DIR, ...file.path.split("/"))
    try {
      const stat = await fs.lstat(full)
      if (!stat.isFile()) problems.push(`${file.path} isn't a regular file`)
      else if (stat.size !== file.bytes)
        problems.push(`${file.path} has the wrong size`)
      else if ((await sha256File(full)) !== file.sha256)
        problems.push(`${file.path} checksum mismatch`)
    } catch {
      problems.push(`${file.path} is missing`)
    }
  }
  // Nothing unlisted may hide in the media folder.
  const present = await listFiles(path.join(dir, MEDIA_DIR))
  const extra = present.filter((file) => !listed.has(file))
  if (extra.length > 0)
    problems.push(`${extra.length} file(s) in media/ aren't in the manifest`)
  return problems
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...(await listFiles(root, relative)))
    else files.push(relative)
  }
  return files
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface RestoreOptions {
  /** A verified backup folder. */
  dir: string
  /** Must be an empty database. */
  target: DatabaseConfig
  /** Becomes a Deskverse data folder; must not exist yet, or be empty. */
  dataRoot: string
  journal: Journal
}

export interface RestoreResult {
  manifest: BackupManifest
  files: number
  tables: Record<string, number>
  migration: string | null
}

export async function restoreBackup({
  dir,
  target,
  dataRoot,
  journal,
}: RestoreOptions): Promise<RestoreResult> {
  const problems = await verifyBackup(dir)
  if (problems.length > 0)
    throw new BackupError(
      `The backup failed verification, so nothing was restored: ${problems.join("; ")}`,
    )
  const manifest = await readManifest(dir)

  if (!path.isAbsolute(dataRoot))
    throw new BackupError("The restore data folder must be an absolute path.")
  if (!(await isEmptyOrMissing(dataRoot)))
    throw new BackupError(
      "The restore data folder isn't empty. Restore never overwrites files: choose a new folder.",
    )
  await withClient(target, "deskverse-restore", async (client) => {
    if ((await userObjectCount(client)) > 0)
      throw new BackupError(
        "The target database isn't empty. Restore never overwrites data: create a new, empty database.",
      )
  })

  // Database: all or nothing.
  await runPgTool(
    "pg_restore",
    [
      "--no-owner",
      "--no-privileges",
      "--no-password",
      "--single-transaction",
      "--exit-on-error",
      `--dbname=${target.database}`,
      path.join(dir, DATABASE_DUMP_FILE),
    ],
    target,
  )

  // Orchestrator leases (DV-004C) belong to worker processes of the old
  // database. Mark them all expired, so no old worker identity can resume
  // ownership; new workers recover those tasks by the normal lease rules.
  await withClient(target, "deskverse-restore", async (client) => {
    const exists = await client.query<{ present: boolean }>(
      "SELECT to_regclass('public.worker_tasks') IS NOT NULL AS present",
    )
    await verifyVeraRecords(client)
    if (exists.rows[0].present)
      await client.query(
        "UPDATE worker_tasks SET lease_expires_at = now() WHERE status = 'running'",
      )
  })

  // Media: copy, then check every checksum of the copies.
  await fs.mkdir(dataRoot, { recursive: true, mode: DIR_MODE })
  const allFiles = [
    ...manifest.media.files,
    ...(manifest.ticketMedia?.files ?? []),
    ...(manifest.ticketVideos?.files ?? []),
  ]
  for (const file of allFiles) {
    const parts = file.path.split("/")
    const copied = await copyWithHash(
      path.join(dir, MEDIA_DIR, ...parts),
      path.join(dataRoot, ...parts),
    )
    if (copied.sha256 !== file.sha256 || copied.bytes !== file.bytes)
      throw new BackupError(`Restored ${file.path} doesn't match the backup.`)
  }

  // The restored database must match what the manifest recorded.
  const restored = await withClient(
    target,
    "deskverse-restore",
    async (client) => ({
      status: await migrationStatus(client, journal),
      tables: await tableCounts(client),
      ticketAssets: await ticketAssetRecords(client),
      ticketVideos: await ticketVideoRecords(client),
    }),
  )
  if (restored.status.current !== manifest.database.migrations.current)
    throw new BackupError(
      "The restored database's schema version doesn't match the backup.",
    )
  for (const [table, count] of Object.entries(manifest.database.tables))
    if (restored.tables[table] !== count)
      throw new BackupError(
        `The restored table ${table} has ${restored.tables[table] ?? 0} rows; the backup recorded ${count}.`,
      )
  // Format 2: every restored ticket record has exactly its restored file.
  if (manifest.ticketMedia) {
    const files = new Map(manifest.ticketMedia.files.map((f) => [f.path, f]))
    if (restored.ticketAssets.length !== files.size)
      throw new BackupError(
        "The restored database's ticket media records don't match the backed-up files.",
      )
    for (const record of restored.ticketAssets) {
      const file = files.get(
        `${TICKET_MEDIA_SOURCE}/${record.ticketId}/assets/${record.id}.${record.extension}`,
      )
      if (!file || file.sha256 !== record.sha256 || file.bytes !== record.bytes)
        throw new BackupError(
          "A restored ticket media record doesn't match its restored file.",
        )
    }
  }
  // Format 3: every restored ticket video record has exactly its restored MP4.
  if (manifest.ticketVideos) {
    const files = new Map(manifest.ticketVideos.files.map((f) => [f.path, f]))
    if (restored.ticketVideos.length !== manifest.ticketVideos.deliverables)
      throw new BackupError(
        "The restored database's ticket videos don't match the backed-up files.",
      )
    for (const record of restored.ticketVideos) {
      const file = files.get(
        `${TICKET_VIDEO_SOURCE}/${record.pixelJobId}/output/video.mp4`,
      )
      if (!file || file.sha256 !== record.sha256 || file.bytes !== record.bytes)
        throw new BackupError(
          "A restored ticket video record doesn't match its restored MP4.",
        )
    }
  }
  // Worker check-ins (DV-005A) describe processes of the old database;
  // clear them (after verification) so no absent worker looks "running".
  await withClient(target, "deskverse-restore", async (client) => {
    const exists = await client.query<{ present: boolean }>(
      "SELECT to_regclass('public.orchestrator_workers') IS NOT NULL AS present",
    )
    if (exists.rows[0].present)
      await client.query("DELETE FROM orchestrator_workers")
  })
  return {
    manifest,
    files: allFiles.length,
    tables: restored.tables,
    migration: restored.status.current,
  }
}
