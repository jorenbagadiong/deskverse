import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { afterAll, describe, expect, it } from "vitest"

import {
  FIXTURE_PRODUCTS,
  startFixtureSites,
} from "../../scripts/scout/fixture-sites"
import { validateNewTicket } from "@/lib/tickets/validation"
import { createBackup, restoreBackup } from "@/server/backup/backup"
import { journal } from "@/server/db/journal"
import { migrationsFolder, runMigrations } from "@/server/db/migrations"
import { createDatabase, createPool } from "@/server/db/pool"
import {
  checkInWorker,
  claimTask,
  completeTask,
  getRun,
  planRun,
} from "@/server/orchestrator/store"
import {
  createRegistry,
  RESEARCH_WORKFLOW,
} from "@/server/orchestrator/workflows"
import { Worker } from "@/server/orchestrator/worker"
import { readScoutConfig } from "@/server/scout/config"
import { createScoutHandler } from "@/server/scout/handler"
import { testNetwork } from "@/server/scout/net/test-network"
import { getResearchReport, listResearch } from "@/server/scout/store"
import {
  addProduct,
  changeStatus,
  createTicket,
} from "@/server/tickets/repository"

import { createScratchDatabase, type ScratchDatabase } from "./helpers"

/**
 * DV-005A: Scout's research records are part of the offline database
 * backup. A restore (into a separate scratch database) keeps every
 * report's sources, evidence, claims, checksums and run linkage, and the
 * recomputed checksum still matches. Worker check-ins are cleared.
 */
const scratches: ScratchDatabase[] = []
let temp = ""
afterAll(async () => {
  for (const s of scratches) await s.drop()
  if (temp) await rm(temp, { recursive: true, force: true })
})

describe("backup and restore with Scout research", () => {
  it(
    "restores reports with their evidence, checksums and linkage intact",
    { timeout: 120_000 },
    async () => {
      temp = await mkdtemp(path.join(os.tmpdir(), "deskverse-backup-scout-"))
      const sites = await startFixtureSites()
      const source = await createScratchDatabase("bkscsrc")
      const target = await createScratchDatabase("bkscdst")
      scratches.push(source, target)

      let pool = createPool(source.config, { max: 8 })
      await runMigrations(pool, journal, migrationsFolder())
      const db = createDatabase(pool)
      const input = validateNewTicket({
        title: "Backed-up research",
        requestId: randomUUID(),
      })
      if (!input.ok) throw new Error("bad")
      const ticket = (await createTicket(db, input.value)).ticket
      for (const p of [FIXTURE_PRODUCTS.kettle, FIXTURE_PRODUCTS.buds])
        await addProduct(db, ticket.id, randomUUID(), {
          name: p.name,
          affiliateUrl: p.affiliateUrl,
          specifications: p.specifications,
          description: p.description,
          references: p.references.map((r) => ({
            kind: r.kind,
            url: r.url,
            label: r.label,
          })),
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
        mode: "production",
        workflow: RESEARCH_WORKFLOW.id,
        productionAvailable: false,
        verificationAllowed: false,
        availableWorkflows: [RESEARCH_WORKFLOW.id],
      })
      const worker = new Worker({
        pool,
        registry: createRegistry({
          verification: false,
          production: [
            createScoutHandler({
              config: readScoutConfig({
                DESKVERSE_SCOUT_RETRIEVAL: "on",
                DESKVERSE_SCOUT_HOST_INTERVAL_MS: "0",
              }),
              network: testNetwork({ port: sites.port }),
            }),
          ],
        }),
        leaseMs: 3_000,
        pollMs: 50,
        log: () => {},
      }).start()
      for (let i = 0; i < 400; i++) {
        const s = (
          await pool.query("SELECT status FROM campaign_runs WHERE id = $1", [
            runId,
          ])
        ).rows[0].status
        if (s === "completed") break
        await sleep(50)
      }
      await worker.stop()
      await sites.close()
      const detail = (await getRun(pool, ticket.id, runId))!
      expect(detail.run.status).toBe("completed")
      const before = await Promise.all(
        detail.products.map((p) =>
          getResearchReport(pool, ticket.id, runId, p.snapshotId),
        ),
      )
      expect(before.every((r) => r?.integrity === "verified")).toBe(true)
      // A stale check-in from a worker of this database.
      await checkInWorker(pool, {
        workerId: "worker-old-machine",
        pid: 1,
        stages: ["scout.research"],
      })
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
      expect(manifest.database.migrations.current).toBe(
        journal.entries.at(-1)!.tag,
      )
      expect(manifest.database.tables).toMatchObject({ scout_reports: 2 })
      expect(manifest.database.tables.scout_sources).toBe(4)
      expect(manifest.database.tables.scout_evidence).toBeGreaterThan(4)
      expect(manifest.database.tables.scout_claims).toBeGreaterThan(4)

      await restoreBackup({
        dir,
        target: target.config,
        dataRoot: path.join(temp, "restored"),
        journal,
      })
      pool = createPool(target.config, { max: 4 })
      try {
        for (const [i, p] of detail.products.entries()) {
          const after = (await getResearchReport(
            pool,
            ticket.id,
            runId,
            p.snapshotId,
          ))!
          expect(after.integrity).toBe("verified")
          expect(after.checksum).toBe(before[i]!.checksum)
          expect(after).toMatchObject({
            runId,
            taskId: p.tasks[0].id,
            snapshotId: p.snapshotId,
            snapshotChecksum: p.checksum,
          })
          expect(
            after.sources.map((s) => [
              s.requestedUrl,
              s.contentSha256,
              s.retrievedAt,
            ]),
          ).toEqual(
            before[i]!.sources.map((s) => [
              s.requestedUrl,
              s.contentSha256,
              s.retrievedAt,
            ]),
          )
          expect(after.claims).toEqual(before[i]!.claims)
          expect(after.evidence).toEqual(before[i]!.evidence)
        }
        expect((await listResearch(pool, ticket.id)).reports).toHaveLength(2)
        // Restored research is still immutable, and still guarded.
        await expect(pool.query("DELETE FROM scout_reports")).rejects.toThrow(
          /immutable/,
        )
        expect(
          Number(
            (await pool.query("SELECT count(*) FROM orchestrator_workers"))
              .rows[0].count,
          ),
        ).toBe(0)
      } finally {
        await pool.end()
      }
    },
  )

  it(
    "restores a DV-004C-era backup (schema 0002) and migrates it forward, keeping verification results",
    { timeout: 120_000 },
    async () => {
      const { cp, readFile, writeFile } = await import("node:fs/promises")
      temp ||= await mkdtemp(path.join(os.tmpdir(), "deskverse-backup-scout-"))
      const source = await createScratchDatabase("bk4csrc")
      const target = await createScratchDatabase("bk4cdst")
      scratches.push(source, target)
      const folder = path.join(temp, "migrations-0002")
      await cp(migrationsFolder(), folder, { recursive: true })
      const meta = JSON.parse(
        await readFile(path.join(folder, "meta", "_journal.json"), "utf8"),
      )
      meta.entries = meta.entries.filter((e: { tag: string }) => e.tag < "0003")
      await writeFile(
        path.join(folder, "meta", "_journal.json"),
        JSON.stringify(meta),
      )
      const v4c = { entries: journal.entries.filter((e) => e.tag < "0003") }

      let pool = createPool(source.config)
      await runMigrations(pool, v4c, folder)
      const db = createDatabase(pool)
      const input = validateNewTicket({
        title: "From DV-004C",
        requestId: randomUUID(),
      })
      if (!input.ok) throw new Error("bad")
      const ticket = (await createTicket(db, input.value)).ticket
      await addProduct(db, ticket.id, randomUUID(), {
        name: "Kept",
        affiliateUrl: "https://shop.example.com/k",
      })
      const v = (
        await pool.query(
          "SELECT version FROM affiliate_tickets WHERE id = $1",
          [ticket.id],
        )
      ).rows[0].version
      const ready = await changeStatus(db, ticket.id, v, "ready")
      await planRun(pool, {
        ticketId: ticket.id,
        ticketVersion: ready.version,
        requestId: randomUUID(),
        mode: "verification",
        productionAvailable: false,
        verificationAllowed: true,
        verification: { durationMs: 0 },
      })
      const claim = (await claimTask(pool, {
        workerId: "w-4c",
        stages: ["verify.collect"],
        leaseMs: 60_000,
      }))!
      expect(
        await completeTask(pool, claim, { kind: "verification", note: "kept" }),
      ).toBe("committed")
      await pool.end()
      const { dir } = await createBackup({
        db: source.config,
        journal: v4c,
        dataRoot: path.join(temp, "data-4c"),
        backupsRoot: path.join(temp, "backups-4c"),
        projectRoot: process.cwd(),
        deskverseVersion: "test",
        checkProcesses: false,
      })
      const result = await restoreBackup({
        dir,
        target: target.config,
        dataRoot: path.join(temp, "restored-4c"),
        journal,
      })
      expect(result.migration).toBe("0002_campaign_orchestrator")
      pool = createPool(target.config)
      try {
        expect(await runMigrations(pool, journal, migrationsFolder())).toEqual([
          "0003_scout_research",
          "0004_quill_scripts",
          "0005_pixel_deliverables",
          "0006_vera_reviews",
          "0007_approval_inbox",
        ])
        const kept = (
          await pool.query("SELECT kind, payload FROM task_results")
        ).rows
        expect(kept).toEqual([
          {
            kind: "verification",
            payload: { kind: "verification", note: "kept" },
          },
        ])
        expect(
          Number(
            (await pool.query("SELECT count(*) FROM scout_reports")).rows[0]
              .count,
          ),
        ).toBe(0)
      } finally {
        await pool.end()
      }
    },
  )
})
