import { createHash } from "node:crypto"
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  BackupError,
  createBackup,
  restoreBackup,
  verifyBackup,
} from "@/server/backup/backup"
import { journal } from "@/server/db/journal"
import { migrationsFolder, runMigrations } from "@/server/db/migrations"
import { createDatabase, createPool } from "@/server/db/pool"
import { appMetadata } from "@/server/db/schema"
import { createVideoStorage } from "@/server/video/storage"

import { createScratchDatabase, type ScratchDatabase } from "./helpers"

/**
 * DV-004A: offline backup and isolated restore, against scratch databases
 * and temporary folders only. Never the owner's database or media.
 */

function png(width: number, height: number) {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  b.set([0x49, 0x48, 0x44, 0x52], 12)
  const view = new DataView(b.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return b
}

const TAGS = journal.entries.map((entry) => entry.tag)
const LATEST = TAGS[TAGS.length - 1]

const sha256 = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex")

describe("backup and isolated restore", () => {
  let source: ScratchDatabase
  let target: ScratchDatabase
  let temp: string
  let dataRoot: string
  let backupsRoot: string
  let backupDir: string
  let jobId: string
  let assetId: string

  beforeAll(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), "deskverse-backup-test-"))
    dataRoot = path.join(temp, "data")
    backupsRoot = path.join(temp, "backups")
    source = await createScratchDatabase("bksrc")
    target = await createScratchDatabase("bkdst")

    // Source database: migrated, plus fixture records.
    const pool = createPool(source.config)
    await runMigrations(pool, journal, migrationsFolder())
    await createDatabase(pool)
      .insert(appMetadata)
      .values([
        { key: "fixture.one", value: { n: 1 } },
        { key: "fixture.two", value: { text: "naïve ✓" } },
      ])
    await pool.end()

    // Source media: a real Pixel Studio job made by Pixel's own storage code.
    const storage = createVideoStorage(dataRoot)
    const job = await storage.createJob()
    jobId = job.id
    assetId = (
      await storage.addImageAsset(job.id, {
        bytes: png(1080, 1920),
        declaredType: "image/png",
        fileName: "product.png",
      })
    ).id
    const work = await storage.workDir(job.id)
    await writeFile(path.join(work, "segment-0.mp4"), "temporary scratch")
    const output = path.join(dataRoot, "video", "jobs", job.id, "output")
    await mkdir(output, { recursive: true })
    await writeFile(path.join(output, "video.mp4"), Buffer.alloc(4096, 7))
  })

  afterAll(async () => {
    await source?.drop()
    await target?.drop()
    await rm(temp, { recursive: true, force: true })
  })

  it("refuses while another program is connected to the database", async () => {
    const pool = createPool(source.config)
    await pool.query("SELECT 1") // keeps one idle connection open
    try {
      await expect(
        createBackup({
          db: source.config,
          journal,
          dataRoot,
          backupsRoot,
          projectRoot: process.cwd(),
          deskverseVersion: "test",
          checkProcesses: false,
        }),
      ).rejects.toThrow(/Another program is connected/)
    } finally {
      await pool.end()
    }
  })

  it("refuses a backup folder inside the data folder or the repository", async () => {
    for (const root of [
      path.join(dataRoot, "b"),
      path.join(process.cwd(), "b"),
    ])
      await expect(
        createBackup({
          db: source.config,
          journal,
          dataRoot,
          backupsRoot: root,
          projectRoot: process.cwd(),
          deskverseVersion: "test",
          checkProcesses: false,
        }),
      ).rejects.toBeInstanceOf(BackupError)
  })

  it("writes a verified backup with a manifest and no secrets", async () => {
    const { dir, manifest } = await createBackup({
      db: source.config,
      journal,
      dataRoot,
      backupsRoot,
      projectRoot: process.cwd(),
      deskverseVersion: "0.1.0",
      now: () => new Date("2026-11-21T12:34:56.789Z"),
      checkProcesses: false,
    })
    backupDir = dir
    expect(path.basename(dir)).toBe("deskverse-backup-20261121T123456Z")
    expect((await readdir(backupsRoot)).sort()).toEqual([
      "deskverse-backup-20261121T123456Z",
    ])
    expect((await readdir(dir)).sort()).toEqual([
      "database.dump",
      "manifest.json",
      "manifest.sha256",
      "media",
    ])
    expect(manifest.database).toMatchObject({
      format: "pg_dump-custom",
      migrations: { applied: TAGS.length, current: LATEST },
      tables: { app_metadata: 3 },
    })
    expect(manifest.database.serverVersion).toMatch(/^\d+\.\d+/)
    expect(manifest.media.jobs).toBe(1)
    expect(manifest.media.files.map((f) => f.path).sort()).toEqual(
      [
        `video/jobs/${jobId}/assets/${assetId}.png`,
        `video/jobs/${jobId}/job.json`,
        `video/jobs/${jobId}/output/video.mp4`,
      ].sort(),
    )
    expect(manifest.media.excluded.scratchFolders).toBe(1)
    expect(await verifyBackup(dir)).toEqual([])

    // Private, and free of credentials and absolute paths.
    expect((await stat(dir)).mode & 0o077).toBe(0)
    expect((await stat(path.join(dir, "database.dump"))).mode & 0o077).toBe(0)
    const text = await readFile(path.join(dir, "manifest.json"), "utf8")
    for (const secret of [source.config.password, source.config.user, temp])
      expect(text).not.toContain(secret)
    const dump = await readFile(path.join(dir, "database.dump"))
    expect(dump.includes(source.config.password)).toBe(false)
  })

  it("detects damage", async () => {
    const copy = path.join(temp, "damaged")
    await cp(backupDir, copy, { recursive: true })
    const video = path.join(
      copy,
      "media",
      "video",
      "jobs",
      jobId,
      "output",
      "video.mp4",
    )
    await writeFile(video, Buffer.alloc(4096, 8))
    await writeFile(path.join(copy, "media", "extra.txt"), "sneaky")
    expect(await verifyBackup(copy)).toEqual([
      `video/jobs/${jobId}/output/video.mp4 checksum mismatch`,
      "1 file(s) in media/ aren't in the manifest",
    ])
    await writeFile(path.join(copy, "manifest.json"), "{}")
    expect((await verifyBackup(copy))[0]).toBe(
      "manifest.json doesn't match manifest.sha256",
    )
    // A damaged backup is never restored.
    await expect(
      restoreBackup({
        dir: copy,
        target: target.config,
        dataRoot: path.join(temp, "never"),
        journal,
      }),
    ).rejects.toThrow(/failed verification, so nothing was restored/)
  })

  it("refuses to restore over a non-empty database or folder", async () => {
    await expect(
      restoreBackup({
        dir: backupDir,
        target: source.config,
        dataRoot: path.join(temp, "fresh"),
        journal,
      }),
    ).rejects.toThrow(/target database isn't empty/)
    await expect(
      restoreBackup({
        dir: backupDir,
        target: target.config,
        dataRoot,
        journal,
      }),
    ).rejects.toThrow(/data folder isn't empty/)
  })

  it("restores into an empty database and a new folder that the app can read", async () => {
    const restoredRoot = path.join(temp, "restored")
    const result = await restoreBackup({
      dir: backupDir,
      target: target.config,
      dataRoot: restoredRoot,
      journal,
    })
    expect(result).toMatchObject({
      files: 3,
      migration: LATEST,
      tables: { app_metadata: 3 },
    })

    // Records, through the app's own Drizzle schema.
    const pool = createPool(target.config)
    try {
      const db = createDatabase(pool)
      const rows = await db
        .select()
        .from(appMetadata)
        .where(eq(appMetadata.key, "fixture.two"))
      expect(rows[0].value).toEqual({ text: "naïve ✓" })
      // Restored schema is current: migrating again changes nothing.
      expect(await runMigrations(pool, journal, migrationsFolder())).toEqual([])
    } finally {
      await pool.end()
    }

    // Files, identical, and readable by Pixel Studio's own storage code.
    for (const relative of [
      `video/jobs/${jobId}/output/video.mp4`,
      `video/jobs/${jobId}/assets/${assetId}.png`,
    ])
      expect(await sha256(path.join(restoredRoot, relative))).toBe(
        await sha256(path.join(dataRoot, relative)),
      )
    const storage = createVideoStorage(restoredRoot)
    const job = await storage.readJob(jobId)
    expect(job.assets.map((a) => a.id)).toEqual([assetId])
    expect(await storage.assetPath(jobId, assetId)).toBe(
      path.join(
        restoredRoot,
        "video",
        "jobs",
        jobId,
        "assets",
        `${assetId}.png`,
      ),
    )
    // The temporary work/ files were deliberately not backed up.
    await expect(
      stat(path.join(restoredRoot, "video", "jobs", jobId, "work")),
    ).rejects.toThrow()

    // The source was never touched.
    expect(
      await sha256(
        path.join(dataRoot, "video", "jobs", jobId, "work", "segment-0.mp4"),
      ),
    ).toBe(createHash("sha256").update("temporary scratch").digest("hex"))
  })
})
