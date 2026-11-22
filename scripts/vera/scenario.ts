import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { createScratchDatabase, databaseUrl } from "../../tests/db/helpers"
import { startFixtureSites } from "../scout/fixture-sites"
import { planVera, seedVideos, settle, worker } from "./fixtures"
import { createPool } from "@/server/db/pool"
import { journal } from "@/server/db/journal"
import { migrationsFolder, runMigrations } from "@/server/db/migrations"
import { createVeraHandler } from "@/server/vera/handler"
import { getReview } from "@/server/vera/store"
import { loadInputs } from "@/server/vera/inputs"
import { ticketRenderStorage } from "@/server/pixel/store"
import { createBackup, restoreBackup } from "@/server/backup/backup"
import { canonicalJson, sha256 } from "@/server/orchestrator/canonical"

export async function runVeraScenario(options: {
  batches: number[]
  log: (s: string) => void
}) {
  if (
    !options.batches.length ||
    options.batches.some((n) => ![1, 3, 10].includes(n))
  )
    throw Error("Use batches 1,3,10")
  const scratch = await createScratchDatabase("veraverify")
  const target = await createScratchDatabase("verarestore")
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "deskverse-vera-verify-"),
  )
  const dataRoot = path.join(root, "data")
  await fs.mkdir(dataRoot, { recursive: true })
  let pool = createPool(scratch.config, { max: 8 })
  const sites = await startFixtureSites()
  const checks: Record<string, boolean> = {}
  const evidence: Record<string, unknown> = {}
  const assert = (name: string, ok: boolean) => {
    checks[name] = ok
    options.log(`${ok ? "PASS" : "FAIL"} ${name}`)
    if (!ok) throw Error(name)
  }
  let first: Awaited<ReturnType<typeof seedVideos>> | null = null
  try {
    await runMigrations(pool, journal, migrationsFolder())
    for (const count of options.batches) {
      options.log(
        `Rendering ${count} genuine Pixel outputs from persisted Scout/Quill fixtures…`,
      )
      const seed = await seedVideos({
        pool,
        dataRoot,
        fixturePort: sites.port,
        count,
        unspecified: count > 1,
      })
      first ??= seed
      const sourceTables = [
        "scout_reports",
        "scout_sources",
        "scout_evidence",
        "scout_claims",
        "scout_claim_evidence",
        "quill_scripts",
        "quill_scenes",
        "quill_scene_claims",
        "pixel_render_jobs",
        "pixel_deliverables",
      ]
      const sourceHashes = async () => {
        const records: Record<string, string[]> = {}
        for (const table of sourceTables)
          records[table] = (
            await pool.query(
              `SELECT row_to_json(x)::text AS value FROM ${table} x ORDER BY row_to_json(x)::text`,
            )
          ).rows.map((r) => r.value)
        return sha256(canonicalJson(records))
      }
      const beforeQA = await sourceHashes()
      const selections = seed.deliverables.map((d) => ({
        productId: d.product_id as string,
        deliverableId: d.id as string,
      }))
      const requestId = randomUUID()
      const run = await planVera(
        pool,
        dataRoot,
        seed.ticketId,
        selections,
        requestId,
      )
      assert(
        `${count}: idempotent planning`,
        (await planVera(pool, dataRoot, seed.ticketId, selections, requestId))
          .runId === run.runId,
      )
      const restore: { file: string; bytes: Buffer }[] = []
      if (count >= 3) {
        const file = (await ticketRenderStorage(
          dataRoot,
        ).resolveCompletedOutput(seed.deliverables[1].pixel_job_id))!
        restore.push({ file: file.path, bytes: await fs.readFile(file.path) })
        await fs.chmod(file.path, 0o600)
        await fs.writeFile(file.path, "corrupted after explicit QA pin")
      }
      const w = worker(pool, [
        createVeraHandler({
          pool,
          dataRoot,
          commands: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
        }),
      ])
      try {
        assert(
          `${count}: tasks complete despite quality verdicts`,
          (await settle(pool, run.runId)) === "completed",
        )
      } finally {
        await w.stop()
        for (const f of restore) {
          await fs.writeFile(f.file, f.bytes)
          await fs.chmod(f.file, 0o400)
        }
      }
      const rows = (
        await pool.query(
          "SELECT id,verdict FROM vera_reviews WHERE run_id=$1",
          [run.runId],
        )
      ).rows
      assert(
        `${count}: one committed report per product`,
        rows.length === count,
      )
      const counts: Record<string, number> = {}
      for (const r of rows) {
        counts[r.verdict] = (counts[r.verdict] ?? 0) + 1
        assert(
          `${count}: report ${r.id.slice(0, 8)} checksum`,
          (await getReview(pool, seed.ticketId, r.id))?.integrity ===
            "verified",
        )
      }
      assert(
        `${count}: valid products pass independently`,
        counts.pass === (count === 1 ? 1 : count === 3 ? 1 : 8),
      )
      if (count > 1)
        assert(
          `${count}: unresolved rights need owner`,
          counts.needs_owner_input === 1,
        )
      if (count >= 3)
        assert(`${count}: altered MP4 fails QA`, counts.failed === 1)
      assert(
        `${count}: source records unchanged`,
        (await sourceHashes()) === beforeQA,
      )
      evidence[`batch${count}`] = counts
    }
    if (!first) throw Error("Missing first fixture")
    const d = first.deliverables[0]
    for (const mode of [
      "SIGTERM",
      "SIGKILL",
      "before-commit",
      "after-commit",
    ] as const) {
      options.log(`Crash recovery: ${mode}`)
      const { runId } = await planVera(pool, dataRoot, first.ticketId, [
        { productId: d.product_id, deliverableId: d.id },
      ])
      let started = false
      let workerError = ""
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          "./scripts/server-only-hook.mjs",
          "scripts/vera/crash-worker.ts",
        ],
        {
          cwd: process.cwd(),
          env: {
            NODE_ENV: "test",
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            DATABASE_TEST_URL: databaseUrl(scratch.config),
            DESKVERSE_DATA_DIR: dataRoot,
            VERA_CRASH_POINT: mode,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      )
      child.stdout.on("data", (b) => {
        if (String(b).includes("VERA_REVIEW_STARTED")) started = true
      })
      child.stderr.on("data", (b) => {
        workerError = (workerError + String(b)).slice(-2000)
      })
      let exited = false
      child.on("exit", () => {
        exited = true
      })
      const end = Date.now() + 120000
      while (!started && !exited && Date.now() < end) await sleep(50)
      if (!started)
        throw Error(
          `Crash worker failed to start: ${workerError.replaceAll(scratch.config.password, "[redacted]")}`,
        )
      if (mode === "SIGTERM" || mode === "SIGKILL") {
        await sleep(1500)
        child.kill(mode)
      }
      while (!exited && Date.now() < end) await sleep(50)
      if (!exited) {
        child.kill("SIGKILL")
        throw Error("Crash harness timed out")
      }
      const before = Number(
        (
          await pool.query(
            "SELECT count(*) FROM vera_reviews WHERE run_id=$1",
            [runId],
          )
        ).rows[0].count,
      )
      assert(
        `${mode}: commit boundary`,
        before === (mode === "after-commit" ? 1 : 0),
      )
      const w = worker(pool, [
        createVeraHandler({
          pool,
          dataRoot,
          commands: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
        }),
      ])
      try {
        assert(
          `${mode}: restart completes`,
          (await settle(pool, runId)) === "completed",
        )
      } finally {
        await w.stop()
      }
      assert(
        `${mode}: exactly one report`,
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM vera_reviews WHERE run_id=$1",
              [runId],
            )
          ).rows[0].count,
        ) === 1,
      )
      evidence[mode] = (
        await pool.query(
          "SELECT status,attempts FROM worker_tasks WHERE run_id=$1",
          [runId],
        )
      ).rows
    }
    const retained = (
      await pool.query(
        "SELECT id,ticket_id,checksum,document FROM vera_reviews ORDER BY id",
      )
    ).rows
    const sourceHash = sha256(canonicalJson(retained))
    await pool.end()
    const backup = await createBackup({
      db: scratch.config,
      journal,
      dataRoot,
      backupsRoot: path.join(root, "backups"),
      projectRoot: process.cwd(),
      deskverseVersion: "DV-006A verification",
      checkProcesses: false,
    })
    assert("format-3 compatibility", backup.manifest.formatVersion === 3)
    assert(
      "backup includes Vera reviews and findings",
      backup.manifest.database.tables.vera_reviews === retained.length &&
        backup.manifest.database.tables.vera_findings > 0,
    )
    const restored = path.join(root, "restored")
    await restoreBackup({
      dir: backup.dir,
      target: target.config,
      dataRoot: restored,
      journal,
    })
    pool = createPool(target.config, { max: 5 })
    const restoredRows = (
      await pool.query(
        "SELECT id,ticket_id,checksum,document FROM vera_reviews ORDER BY id",
      )
    ).rows
    assert(
      "restore preserves exact QA documents",
      sha256(canonicalJson(restoredRows)) === sourceHash,
    )
    for (const row of restoredRows)
      assert(
        `restored ${row.id.slice(0, 8)} checksum`,
        (await getReview(pool, row.ticket_id, row.id))?.integrity ===
          "verified",
      )
    for (const row of restoredRows) {
      const review = await getReview(pool, row.ticket_id, row.id)
      if (!review) throw Error("Missing restored review")
      const lineage = await loadInputs(
        pool,
        row.ticket_id,
        review.document.pin.deliverableId,
      )
      assert(
        `restored ${row.id.slice(0, 8)} source lineage`,
        canonicalJson(lineage.pin) === canonicalJson(review.document.pin),
      )
    }
    assert(
      "restored Scout/Quill/Pixel chain exists",
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM pixel_deliverables d JOIN quill_scripts q ON q.id=d.script_id JOIN scout_reports s ON s.id=q.report_id",
          )
        ).rows[0].count,
      ) === options.batches.reduce((a, b) => a + b, 0),
    )
    evidence.backup = {
      format: 3,
      reviews: retained.length,
      findings: backup.manifest.database.tables.vera_findings,
      chainVideos: options.batches.reduce((a, b) => a + b, 0),
    }
    return { checks, evidence }
  } finally {
    await pool.end().catch(() => {})
    await sites.close()
    await scratch.drop()
    await target.drop()
    await fs.rm(root, { recursive: true, force: true })
  }
}
