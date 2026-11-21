import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { validateNewTicket } from "@/lib/tickets/validation"
import {
  BackupError,
  createBackup,
  restoreBackup,
  verifyBackup,
} from "@/server/backup/backup"
import { journal } from "@/server/db/journal"
import {
  migrationsFolder,
  migrationStatus,
  runMigrations,
  type Journal,
} from "@/server/db/migrations"
import { createDatabase, createPool } from "@/server/db/pool"
import { createRunner } from "@/server/process/run-executable"
import {
  assetFilePath,
  DEFAULT_MEDIA_LIMITS,
  openAssetFile,
  storeUpload,
} from "@/server/tickets/media"
import {
  addProduct,
  createTicket,
  findAsset,
  getTicket,
} from "@/server/tickets/repository"
import { createVideoStorage } from "@/server/video/storage"

import { createScratchDatabase, type ScratchDatabase } from "./helpers"

/**
 * DV-004B: backups (format 2) include Affiliate Ticket attachments, and
 * DV-004A's format 1 backups still restore. Scratch databases and temporary
 * folders only.
 */

/** The DV-004A commit whose backup writer produces format 1. */
const DV_004A = "81fca881574a254205dd4be49e868916fefc4f2a"

const tools = {
  run: createRunner({ timeoutMs: 60_000 }),
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
}
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")

let temp: string
const scratches: ScratchDatabase[] = []

async function scratchDb(label: string) {
  const s = await createScratchDatabase(label)
  scratches.push(s)
  return s
}

function bodyOf(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

beforeAll(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-backup-tickets-"))
})
afterAll(async () => {
  for (const s of scratches) await s.drop()
  if (temp) await fs.rm(temp, { recursive: true, force: true })
})

describe("format 2 backups with Affiliate Ticket attachments", () => {
  let source: ScratchDatabase
  let dataRoot: string
  let ticketId: string
  let productId: string
  let png: Buffer
  let mp4: Buffer
  const assetIds: string[] = []
  let backupDir: string

  const backup = (root = dataRoot) =>
    createBackup({
      db: source.config,
      journal,
      dataRoot: root,
      backupsRoot: path.join(temp, `backups-${randomUUID()}`),
      projectRoot: process.cwd(),
      deskverseVersion: "test",
      checkProcesses: false,
    })

  beforeAll(async () => {
    source = await scratchDb("bk2src")
    dataRoot = path.join(temp, "data")
    const pool = createPool(source.config)
    await runMigrations(pool, journal, migrationsFolder())
    const db = createDatabase(pool)
    const input = validateNewTicket({
      title: "Backup campaign",
      requestId: randomUUID(),
    })
    if (!input.ok) throw new Error("bad")
    ticketId = (await createTicket(db, input.value)).ticket.id
    productId = (
      await addProduct(db, ticketId, randomUUID(), {
        name: "Kettle",
        affiliateUrl: "https://shop.example.com/kettle?tag=me-20",
        references: [
          {
            kind: "review",
            url: "https://reviews.example.org/kettle",
            label: "Review",
          },
        ],
      })
    ).productId
    png = execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x480",
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-c:v",
      "png",
      "-",
    ])
    const clip = path.join(temp, "clip.mp4")
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240:rate=30",
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      clip,
    ])
    mp4 = await fs.readFile(clip)
    for (const [bytes, type] of [
      [png, "image/png"],
      [mp4, "video/mp4"],
    ] as const) {
      const asset = await storeUpload({
        db,
        dataRoot,
        ticketId,
        productId,
        body: bodyOf(bytes),
        declaredLength: bytes.length,
        declaredType: type,
        fileName: "f",
        limits: DEFAULT_MEDIA_LIMITS,
        tools,
      })
      assetIds.push(asset.id)
    }
    await pool.end()
    // A Pixel job alongside, plus an orphan and an unfinished upload (left out).
    const storage = createVideoStorage(dataRoot)
    await storage.createJob()
    const dir = path.join(dataRoot, "tickets", ticketId)
    await fs.writeFile(path.join(dir, "assets", `${randomUUID()}.png`), png)
    await fs.writeFile(
      path.join(dir, "staging", `${randomUUID()}.part`),
      "half",
    )
  })

  it("backs up exactly the registered attachments, checked against the database", async () => {
    const result = await backup()
    backupDir = result.dir
    const m = result.manifest
    expect(m.formatVersion).toBe(2)
    expect(m.ticketMedia).toMatchObject({
      source: "tickets",
      assets: 2,
      bytes: png.length + mp4.length,
      excluded: { orphans: 1, staging: 1, unrecognized: 0 },
    })
    expect(m.ticketMedia!.files.map((f) => f.sha256).sort()).toEqual(
      [sha(png), sha(mp4)].sort(),
    )
    expect(m.media.jobs).toBe(1)
    expect(m.database.tables).toMatchObject({
      affiliate_tickets: 1,
      ticket_products: 1,
      ticket_references: 1,
      ticket_assets: 2,
    })
    expect(await verifyBackup(backupDir)).toEqual([])
    const text = await fs.readFile(
      path.join(backupDir, "manifest.json"),
      "utf8",
    )
    expect(text).not.toContain(temp)
    expect(text).not.toContain(source.config.password)
  })

  it("restores records and attachment bytes that the app can read back", async () => {
    const target = await scratchDb("bk2dst")
    const restoredRoot = path.join(temp, "restored")
    const result = await restoreBackup({
      dir: backupDir,
      target: target.config,
      dataRoot: restoredRoot,
      journal,
    })
    // The Pixel draft's job.json plus the two ticket attachments.
    expect(result.files).toBe(3)
    const pool = createPool(target.config)
    try {
      const db = createDatabase(pool)
      const ticket = (await getTicket(db, ticketId))!
      expect(ticket.title).toBe("Backup campaign")
      expect(ticket.products[0]).toMatchObject({
        name: "Kettle",
        affiliateUrl: "https://shop.example.com/kettle?tag=me-20",
        references: [
          {
            kind: "review",
            url: "https://reviews.example.org/kettle",
            label: "Review",
          },
        ],
      })
      expect(ticket.products[0].assets.map((a) => a.id).sort()).toEqual(
        [...assetIds].sort(),
      )
      for (const id of assetIds) {
        const row = (await findAsset(db, ticketId, productId, id))!
        const { file } = await openAssetFile(restoredRoot, row)
        expect(sha(await fs.readFile(file))).toBe(row.sha256)
      }
    } finally {
      await pool.end()
    }
    // Orphans and unfinished uploads were not restored.
    expect(
      await fs.readdir(path.join(restoredRoot, "tickets", ticketId)),
    ).toEqual(["assets"])
    expect(
      (await fs.readdir(path.join(restoredRoot, "tickets", ticketId, "assets")))
        .length,
    ).toBe(2)
  })

  it("refuses to back up when a registered file is missing or changed", async () => {
    const copy = path.join(temp, "data-damaged")
    await fs.cp(dataRoot, copy, { recursive: true })
    const file = assetFilePath(copy, ticketId, assetIds[0], "png")
    // Same size, different bytes: only the checksum can tell.
    const bytes = await fs.readFile(file)
    bytes[bytes.length - 20] ^= 0xff
    await fs.writeFile(file, bytes)
    const changed = await backup(copy).then(
      () => null,
      (e: unknown) => e,
    )
    expect(changed).toBeInstanceOf(BackupError)
    expect((changed as Error).message).toMatch(
      /doesn't match the checksum recorded when it was uploaded/,
    )
    await fs.rm(file)
    const missing = await backup(copy).then(
      () => null,
      (e: unknown) => e,
    )
    expect((missing as Error).message).toMatch(
      /don't match the database.*is missing/,
    )
    // Nothing half-written was left behind.
    const leftovers = (await fs.readdir(temp)).filter((n) =>
      n.startsWith("backups-"),
    )
    for (const dir of leftovers)
      expect(
        (await fs.readdir(path.join(temp, dir))).filter(
          (n) => !n.endsWith(".partial"),
        ).length,
      ).toBeLessThanOrEqual(1)
  })

  it("refuses a registered file that is a symbolic link", async () => {
    const copy = path.join(temp, "data-linked")
    await fs.cp(dataRoot, copy, { recursive: true })
    const file = assetFilePath(copy, ticketId, assetIds[0], "png")
    const elsewhere = path.join(temp, "elsewhere.png")
    await fs.rename(file, elsewhere)
    await fs.symlink(elsewhere, file)
    const error = await backup(copy).then(
      () => null,
      (e: unknown) => e,
    )
    expect((error as Error).message).toMatch(/symbolic link/)
  })

  it("rejects a manifest that points outside the backup", async () => {
    const copy = path.join(temp, "tampered")
    await fs.cp(backupDir, copy, { recursive: true })
    const manifestFile = path.join(copy, "manifest.json")
    const m = JSON.parse(await fs.readFile(manifestFile, "utf8"))
    m.ticketMedia.files[0].path = `tickets/${ticketId}/assets/../../../../etc/passwd`
    const text = `${JSON.stringify(m, null, 2)}\n`
    await fs.writeFile(manifestFile, text)
    await fs.writeFile(
      path.join(copy, "manifest.sha256"),
      `${sha(Buffer.from(text))}  manifest.json\n`,
    )
    expect(await verifyBackup(copy)).toContain(
      "Invalid manifest: ticket media file list has an invalid entry",
    )
  })
})

describe("format 1 (DV-004A) backups still restore", () => {
  it("restores a backup written by DV-004A's own code, then migrates forward", async () => {
    // DV-004A's backup writer and manifest, exactly as committed.
    const oldDir = path.join(temp, "dv004a")
    await fs.mkdir(oldDir, { recursive: true })
    const show = (file: string) =>
      execFileSync("git", ["show", `${DV_004A}:${file}`], { encoding: "utf8" })
    await fs.writeFile(
      path.join(oldDir, "manifest.ts"),
      show("src/server/backup/manifest.ts"),
    )
    await fs.writeFile(
      path.join(oldDir, "backup.ts"),
      show("src/server/backup/backup.ts").replace(
        '"@/server/backup/manifest"',
        '"./manifest"',
      ),
    )
    const old = (await import(
      path.join(oldDir, "backup.ts")
    )) as typeof import("@/server/backup/backup")

    // A database at DV-004A's schema (0000_init only).
    const folder = path.join(temp, "migrations-0000")
    await fs.cp(migrationsFolder(), folder, { recursive: true })
    const v1Journal: Journal = { entries: journal.entries.slice(0, 1) }
    const meta = JSON.parse(
      await fs.readFile(path.join(folder, "meta", "_journal.json"), "utf8"),
    )
    meta.entries = meta.entries.slice(0, 1)
    await fs.writeFile(
      path.join(folder, "meta", "_journal.json"),
      JSON.stringify(meta),
    )
    const source = await scratchDb("v1src")
    const pool = createPool(source.config)
    await runMigrations(pool, v1Journal, folder)
    await pool.query(
      "INSERT INTO app_metadata (key, value) VALUES ('fixture.v1', '{\"n\": 1}')",
    )
    await pool.end()
    const dataRoot = path.join(temp, "v1-data")
    const job = await createVideoStorage(dataRoot).createJob()

    const { dir, manifest } = await old.createBackup({
      db: source.config,
      journal: v1Journal,
      dataRoot,
      backupsRoot: path.join(temp, "v1-backups"),
      projectRoot: process.cwd(),
      deskverseVersion: "0.1.0",
      checkProcesses: false,
    })
    expect(manifest.formatVersion).toBe(1)
    expect("ticketMedia" in manifest).toBe(false)

    // Today's code verifies and restores it.
    expect(await verifyBackup(dir)).toEqual([])
    const target = await scratchDb("v1dst")
    const restoredRoot = path.join(temp, "v1-restored")
    const result = await restoreBackup({
      dir,
      target: target.config,
      dataRoot: restoredRoot,
      journal,
    })
    expect(result.migration).toBe("0000_init")
    expect(
      await createVideoStorage(restoredRoot).readJob(job.id),
    ).toMatchObject({ id: job.id })

    // Then the normal upgrade path: migrate to the current schema.
    const restored = createPool(target.config)
    try {
      const status = await migrationStatus(restored, journal)
      expect(status.pending).toEqual(journal.entries.slice(1).map((e) => e.tag))
      await runMigrations(restored, journal, migrationsFolder())
      const rows = await restored.query(
        "SELECT key FROM app_metadata ORDER BY key",
      )
      expect(rows.rows.map((r) => r.key)).toEqual([
        "database.initialized",
        "fixture.v1",
      ])
      const tickets = await restored.query(
        "SELECT count(*)::int AS n FROM affiliate_tickets",
      )
      expect(tickets.rows[0].n).toBe(0)
    } finally {
      await restored.end()
    }
  })
})
