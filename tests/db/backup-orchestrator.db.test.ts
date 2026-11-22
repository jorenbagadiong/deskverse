import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { validateNewTicket } from "@/lib/tickets/validation"
import { createBackup, restoreBackup } from "@/server/backup/backup"
import { journal } from "@/server/db/journal"
import { migrationsFolder, runMigrations } from "@/server/db/migrations"
import { createDatabase, createPool } from "@/server/db/pool"
import {
  claimTask,
  completeTask,
  getRun,
  planRun,
  recoverExpiredLeases,
  renewLease,
} from "@/server/orchestrator/store"
import {
  createRegistry,
  VERIFICATION_WORKFLOW,
} from "@/server/orchestrator/workflows"
import { Worker } from "@/server/orchestrator/worker"
import {
  addProduct,
  changeStatus,
  createTicket,
} from "@/server/tickets/repository"

import { createScratchDatabase, type ScratchDatabase } from "./helpers"

/**
 * DV-004C: orchestrator state is part of the offline database backup, and
 * an in-flight lease from the backup can't be resumed by its old worker.
 */
const scratches: ScratchDatabase[] = []
let temp = ""
afterAll(async () => {
  for (const s of scratches) await s.drop()
  if (temp) await rm(temp, { recursive: true, force: true })
})

describe("backup and restore with orchestrator state", () => {
  it(
    "restores runs, snapshots, tasks and results; old leases are recovered, not resumed",
    { timeout: 120_000 },
    async () => {
      temp = await mkdtemp(path.join(os.tmpdir(), "deskverse-backup-orch-"))
      const source = await createScratchDatabase("bkorsrc")
      const target = await createScratchDatabase("bkordst")
      scratches.push(source, target)
      const stages = VERIFICATION_WORKFLOW.stages.map((s) => s.stage)

      let pool = createPool(source.config)
      await runMigrations(pool, journal, migrationsFolder())
      const db = createDatabase(pool)
      const input = validateNewTicket({
        title: "Backed-up workflow",
        requestId: randomUUID(),
      })
      if (!input.ok) throw new Error("bad")
      const ticket = (await createTicket(db, input.value)).ticket
      for (let i = 0; i < 2; i++)
        await addProduct(db, ticket.id, randomUUID(), {
          name: `P${i + 1}`,
          affiliateUrl: `https://shop.example.com/${i}`,
        })
      const v = (
        await pool.query(
          "SELECT version FROM affiliate_tickets WHERE id = $1",
          [ticket.id],
        )
      ).rows[0].version
      const ready = await changeStatus(db, ticket.id, v, "ready")
      const { runId } = await planRun(pool, {
        ticketId: ticket.id,
        ticketVersion: ready.version,
        requestId: randomUUID(),
        mode: "verification",
        productionAvailable: false,
        verificationAllowed: true,
        verification: { durationMs: 10 },
      })
      const done = (await claimTask(pool, {
        workerId: "worker-old-1",
        stages,
        leaseMs: 60_000,
      }))!
      expect(await completeTask(pool, done, { kind: "verification" })).toBe(
        "committed",
      )
      const inFlight = (await claimTask(pool, {
        workerId: "worker-old-2",
        stages,
        leaseMs: 600_000,
      }))!
      await pool.end()

      const { dir, manifest } = await createBackup({
        db: source.config,
        journal,
        dataRoot: path.join(temp, "data"),
        backupsRoot: path.join(temp, "backups"),
        projectRoot: process.cwd(),
        deskverseVersion: "test",
        checkProcesses: false,
      })
      expect(manifest.database.tables).toMatchObject({
        campaign_runs: 1,
        run_product_snapshots: 2,
        worker_tasks: 8,
        task_dependencies: 6,
        task_results: 1,
      })
      await restoreBackup({
        dir,
        target: target.config,
        dataRoot: path.join(temp, "restored"),
        journal,
      })

      pool = createPool(target.config, { max: 10 })
      try {
        const restored = (await getRun(pool, ticket.id, runId))!
        expect(restored.run.status).toBe("running")
        expect(
          restored.products.flatMap((p) => p.tasks).filter((t) => t.hasResult),
        ).toHaveLength(1)
        // The old worker's lease can't be resumed against the restored database.
        expect(await renewLease(pool, inFlight)).toBeNull()
        expect(await recoverExpiredLeases(pool)).toBe(1)
        const outcome = (
          await pool.query(
            "SELECT outcome FROM task_attempts WHERE task_id = $1",
            [inFlight.taskId],
          )
        ).rows
        expect(outcome).toEqual([{ outcome: "lease_expired" }])
        // A new worker finishes the run; the restored result isn't redone.
        await pool.query(
          "UPDATE worker_tasks SET eligible_at = now() WHERE run_id = $1",
          [runId],
        )
        const worker = new Worker({
          pool,
          registry: createRegistry({ verification: true }),
          leaseMs: 2_000,
          pollMs: 25,
          log: () => {},
        }).start()
        try {
          for (let i = 0; i < 400; i++) {
            const s = (
              await pool.query(
                "SELECT status FROM campaign_runs WHERE id = $1",
                [runId],
              )
            ).rows[0].status
            if (s === "completed") break
            await new Promise((r) => setTimeout(r, 50))
          }
        } finally {
          await worker.stop()
        }
        expect(
          (
            await pool.query("SELECT status FROM campaign_runs WHERE id = $1", [
              runId,
            ])
          ).rows[0].status,
        ).toBe("completed")
        const attempts = (
          await pool.query(
            "SELECT outcome FROM task_attempts WHERE task_id = $1 ORDER BY attempt_number",
            [done.taskId],
          )
        ).rows
        expect(attempts).toEqual([{ outcome: "succeeded" }])
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM task_results WHERE run_id = $1",
              [runId],
            )
          ).rows[0].n,
        ).toBe(8)
      } finally {
        await pool.end()
      }
    },
  )
})

describe("DV-004B-era backups migrate forward", () => {
  it(
    "restores a database at schema 0001 and applies every later migration on top, keeping tickets",
    { timeout: 120_000 },
    async () => {
      const { cp, readFile, writeFile } = await import("node:fs/promises")
      temp ||= await mkdtemp(path.join(os.tmpdir(), "deskverse-backup-orch-"))
      const source = await createScratchDatabase("bk4bsrc")
      const target = await createScratchDatabase("bk4bdst")
      scratches.push(source, target)
      // Migrations as they were at DV-004B (0000 and 0001 only).
      const folder = path.join(temp, "migrations-0001")
      await cp(migrationsFolder(), folder, { recursive: true })
      const meta = JSON.parse(
        await readFile(path.join(folder, "meta", "_journal.json"), "utf8"),
      )
      meta.entries = meta.entries.filter((e: { tag: string }) => e.tag < "0002")
      await writeFile(
        path.join(folder, "meta", "_journal.json"),
        JSON.stringify(meta),
      )
      const v4b = { entries: journal.entries.filter((e) => e.tag < "0002") }

      let pool = createPool(source.config)
      await runMigrations(pool, v4b, folder)
      const db = createDatabase(pool)
      const input = validateNewTicket({
        title: "From DV-004B",
        requestId: randomUUID(),
      })
      if (!input.ok) throw new Error("bad")
      const ticket = (await createTicket(db, input.value)).ticket
      await addProduct(db, ticket.id, randomUUID(), {
        name: "Kept",
        affiliateUrl: "https://shop.example.com/k",
      })
      await pool.end()
      const { dir } = await createBackup({
        db: source.config,
        journal: v4b,
        dataRoot: path.join(temp, "data-4b"),
        backupsRoot: path.join(temp, "backups-4b"),
        projectRoot: process.cwd(),
        deskverseVersion: "test",
        checkProcesses: false,
      })
      const result = await restoreBackup({
        dir,
        target: target.config,
        dataRoot: path.join(temp, "restored-4b"),
        journal,
      })
      expect(result.migration).toBe("0001_affiliate_tickets")
      pool = createPool(target.config)
      try {
        expect(await runMigrations(pool, journal, migrationsFolder())).toEqual([
          "0002_campaign_orchestrator",
          "0003_scout_research",
          "0004_quill_scripts",
          "0005_pixel_deliverables",
        ])
        expect(
          (
            await pool.query(
              "SELECT to_regclass('public.scout_reports') IS NOT NULL AS ok",
            )
          ).rows[0].ok,
        ).toBe(true)
        const kept = await pool.query(
          "SELECT t.title, p.name FROM affiliate_tickets t JOIN ticket_products p ON p.ticket_id = t.id",
        )
        expect(kept.rows).toEqual([{ title: "From DV-004B", name: "Kept" }])
        expect(
          (await pool.query("SELECT count(*)::int AS n FROM campaign_runs"))
            .rows[0].n,
        ).toBe(0)
      } finally {
        await pool.end()
      }
    },
  )
})
