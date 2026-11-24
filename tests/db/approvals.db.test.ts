import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { createBackup, restoreBackup } from "@/server/backup/backup"
import { journal } from "@/server/db/journal"
import { migrationsFolder, runMigrations } from "@/server/db/migrations"
import { createPool } from "@/server/db/pool"
import { listApprovals } from "@/server/approvals/store"
import { createScratchDatabase } from "./helpers"

describe("Approval Inbox migration", () => {
  it("upgrades from 0006 and restores an empty format-3 approval table", async () => {
    const source = await createScratchDatabase("approvalsmigrate")
    const target = await createScratchDatabase("approvalsrestore")
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "deskverse-approval-db-"),
    )
    const pool = createPool(source.config, { max: 2 })
    try {
      const oldMigrations = path.join(root, "old-migrations")
      const folder = migrationsFolder()
      await fs.cp(folder, oldMigrations, { recursive: true })
      const oldJournal = { ...journal, entries: journal.entries.slice(0, 7) }
      await fs.writeFile(
        path.join(oldMigrations, "meta", "_journal.json"),
        JSON.stringify(oldJournal),
      )
      const upgraded = await runMigrations(pool, oldJournal, oldMigrations)
      expect(upgraded.at(-1)).toBe("0006_vera_reviews")
      expect(await runMigrations(pool, journal, folder)).toEqual([
        "0007_approval_inbox",
        "0008_automatic_campaign_handoffs",
      ])
      expect(await runMigrations(pool, journal, folder)).toEqual([])
      expect(
        await listApprovals(pool, {
          status: "pending",
          search: "",
          platform: "",
          offset: 0,
        }),
      ).toEqual({
        items: [],
        hasMore: false,
      })
      const constraints = await pool.query(
        "SELECT conname FROM pg_constraint WHERE conrelid='approval_decisions'::regclass",
      )
      expect(constraints.rows.map((row) => row.conname)).toEqual(
        expect.arrayContaining([
          "approval_decisions_review_pin_fk",
          "approval_decisions_previous_fk",
          "approval_decisions_checklist_check",
        ]),
      )
      await pool.end()
      const dataRoot = path.join(root, "data")
      await fs.mkdir(dataRoot)
      const backup = await createBackup({
        db: source.config,
        journal,
        dataRoot,
        backupsRoot: path.join(root, "backups"),
        projectRoot: process.cwd(),
        deskverseVersion: "DV-006B migration test",
        checkProcesses: false,
      })
      expect(backup.manifest.formatVersion).toBe(3)
      expect(backup.manifest.database.tables.approval_decisions).toBe(0)
      const restore = await restoreBackup({
        dir: backup.dir,
        target: target.config,
        dataRoot: path.join(root, "restored"),
        journal,
      })
      expect(restore.migration).toBe("0008_automatic_campaign_handoffs")
      expect(restore.tables.approval_decisions).toBe(0)
    } finally {
      if (!pool.ended) await pool.end()
      await source.drop()
      await target.drop()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
