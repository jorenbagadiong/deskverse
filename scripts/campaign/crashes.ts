import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { promises as fs } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import type pg from "pg"

import { databaseUrl, type ScratchDatabase } from "../../tests/db/helpers"
import { seedTicket } from "../pixel/fixtures"
import { FIXTURE_PRODUCTS } from "../scout/fixture-sites"
import { settle, ticketVersion } from "../vera/fixtures"
import {
  completeTask,
  getRun,
  planRun,
  type Claim,
} from "@/server/orchestrator/store"
import { loadInputs } from "@/server/vera/inputs"
import { ticketRenderStorage } from "@/server/pixel/store"

const stages = ["scout.research", "quill.script", "pixel.render", "vera.review"]

export async function verifyCrashes(
  scratch: ScratchDatabase,
  pool: pg.Pool,
  dataRoot: string,
  fixturePort: number,
) {
  let currentRunId = ""
  async function runWorker(
    stage: string,
    point: string,
    prepare?: () => Promise<string>,
  ) {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./scripts/server-only-hook.mjs",
        "scripts/campaign/crash-worker.ts",
        stage,
        point,
        String(fixturePort),
      ],
      {
        stdio: ["ignore", "inherit", "inherit"],
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DATABASE_TEST_URL: databaseUrl(scratch.config),
          DESKVERSE_DATA_DIR: dataRoot,
        },
      },
    )
    const exited = once(child, "exit")
    const timeout = setTimeout(() => child.kill("SIGTERM"), 120_000)
    const escalation = setTimeout(() => child.kill("SIGKILL"), 125_000)
    try {
      if (prepare) {
        const deadline = Date.now() + 10_000
        for (;;) {
          const { rowCount } = await pool.query(
            "SELECT 1 FROM orchestrator_workers WHERE pid=$1 AND 'campaign.handoffs' = ANY(stages)",
            [child.pid],
          )
          if (rowCount) break
          assert(
            Date.now() < deadline && child.exitCode === null,
            "Worker did not check in.",
          )
          await sleep(30)
        }
        currentRunId = await prepare()
      }
      if (point === "during-qa") {
        // Wait for the child to start a real frame decode. Only this spawned
        // worker is terminated. Its FFmpeg sample is on temporary media.
        const deadline = Date.now() + 45_000
        let decoding = false
        while (!decoding && Date.now() < deadline) {
          const children = await fs
            .readFile(`/proc/${child.pid}/task/${child.pid}/children`, "utf8")
            .catch(() => "")
          for (const pid of children
            .trim()
            .split(/\s+/)
            .filter((part) => /^\d+$/.test(part))) {
            if (
              (
                await fs.readFile(`/proc/${pid}/comm`, "utf8").catch(() => "")
              ).trim() === "ffmpeg"
            )
              decoding = true
          }
          if (!decoding) await sleep(20)
        }
        assert(decoding, "Real Vera FFmpeg frame decode did not start.")
        assert(child.kill("SIGKILL"))
      }
      const [code, signal] = await exited
      assert.equal(code, null, `${stage} ${point} did not die by signal`)
      assert.equal(
        signal,
        "SIGKILL",
        `${stage} ${point} did not reach its crash point`,
      )
    } finally {
      clearTimeout(timeout)
      clearTimeout(escalation)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL")
        await exited.catch(() => {})
      }
    }
    const { rows } = await pool.query(
      `SELECT t.*, x.payload FROM worker_tasks t
       LEFT JOIN task_results x ON x.task_id = t.id WHERE t.run_id=$1 AND t.stage=$2`,
      [currentRunId, stage],
    )
    assert.equal(rows.length, 1)
    const [task] = rows
    if (point === "after-commit") {
      assert.equal(task.status, "completed")
      assert(
        task.payload,
        "Committed worker result was missing after the crash.",
      )
      const next = stages[stages.indexOf(stage) + 1]
      if (next) {
        const {
          rows: [dependent],
        } = await pool.query(
          "SELECT params, status, attempts, snapshot_id FROM worker_tasks WHERE run_id=$1 AND stage=$2",
          [currentRunId, next],
        )
        assert.equal(dependent.status, "queued")
        assert.equal(dependent.attempts, 0)
        assert.equal(dependent.snapshot_id, task.snapshot_id)
        if (next === "quill.script")
          assert.deepEqual(dependent.params, {
            reportId: task.payload.reportId,
            reportVersion: task.payload.reportVersion,
            reportChecksum: task.payload.checksum,
          })
        if (next === "pixel.render") {
          const {
            rows: [manifest],
          } = await pool.query(
            "SELECT script_id, script_checksum, manifest_checksum FROM pixel_render_jobs WHERE run_id=$1 AND snapshot_id=$2",
            [currentRunId, task.snapshot_id],
          )
          assert.equal(manifest.script_id, task.payload.scriptId)
          assert.equal(manifest.script_checksum, task.payload.checksum)
          assert.equal(
            manifest.manifest_checksum,
            dependent.params.manifestChecksum,
          )
        }
        if (next === "vera.review") {
          assert.equal(
            dependent.params.veraPin.deliverableId,
            task.payload.deliverableId,
          )
          assert.equal(dependent.params.veraPin.sha256, task.payload.sha256)
        }
      }
    } else {
      assert.equal(task.status, "running")
      assert.equal(task.payload, null)
      const next = stages[stages.indexOf(stage) + 1]
      if (next) {
        const {
          rows: [dependent],
        } = await pool.query(
          "SELECT params, status, attempts FROM worker_tasks WHERE run_id=$1 AND stage=$2",
          [currentRunId, next],
        )
        assert.equal(dependent.status, "waiting_dependencies")
        assert.deepEqual(dependent.params, {})
        assert.equal(dependent.attempts, 0)
      }
    }
    console.log(
      `PASS SIGKILL ${stage} ${point}: result and dependent pin boundary verified`,
    )
    return task
  }

  async function prepare() {
    const { ticketId, products } = await seedTicket({
      pool,
      dataRoot,
      fixturePort,
      runStandalone: false,
      products: [
        {
          base: FIXTURE_PRODUCTS.kettle,
          name: FIXTURE_PRODUCTS.kettle.name,
          images: 3,
        },
      ],
    })
    const launch = async () =>
      (
        await planRun(pool, {
          ticketId,
          ticketVersion: await ticketVersion(pool, ticketId),
          requestId: randomUUID(),
          mode: "production",
          workflow: "campaign-v1",
          productionAvailable: true,
          verificationAllowed: true,
          campaign: {
            dataRoot,
            testing: true,
            selections: products.map(({ productId, assetIds }) => ({
              productId,
              assetIds,
              rightsAcknowledged: true,
            })),
          },
        })
      ).runId
    return { ticketId, launch }
  }

  const first = await prepare()
  const abandoned = await runWorker(
    "scout.research",
    "before-scout-commit",
    first.launch,
  )
  await runWorker("scout.research", "after-commit")
  const stale: Claim = {
    taskId: abandoned.id,
    runId: abandoned.run_id,
    ticketId: abandoned.ticket_id,
    stage: abandoned.stage,
    fence: Number(abandoned.fence),
    workerId: abandoned.lease_owner,
    attempt: abandoned.attempts,
    maxAttempts: abandoned.max_attempts,
    idempotencyKey: abandoned.idempotency_key,
    params: abandoned.params,
    resourceClass: abandoned.resource_class,
    leaseMs: 2500,
    snapshot: null,
  }
  assert.equal(await completeTask(pool, stale, {}), "stale")
  await runWorker("quill.script", "before-quill-commit")
  await runWorker("quill.script", "after-commit")
  await runWorker("pixel.render", "during-render")
  await runWorker("pixel.render", "after-commit")
  await runWorker("vera.review", "during-qa")
  await runWorker("vera.review", "after-commit")
  assert.equal(await settle(pool, currentRunId), "completed")
  const detail = await getRun(pool, first.ticketId, currentRunId)
  assert(
    detail?.products[0].tasks.every(
      (task) => task.status === "completed" && task.attempts === 2,
    ),
  )
  const firstArtifacts = await pool.query(
    `SELECT
      (SELECT count(*)::int FROM scout_reports WHERE run_id=$1) AS reports,
      (SELECT count(*)::int FROM quill_scripts WHERE run_id=$1) AS scripts,
      (SELECT count(*)::int FROM pixel_render_jobs WHERE run_id=$1) AS manifests,
      (SELECT count(*)::int FROM pixel_deliverables WHERE run_id=$1) AS videos,
      (SELECT count(*)::int FROM vera_reviews WHERE run_id=$1) AS reviews`,
    [currentRunId],
  )
  assert.deepEqual(firstArtifacts.rows[0], {
    reports: 1,
    scripts: 1,
    manifests: 1,
    videos: 1,
    reviews: 1,
  })

  const second = await prepare()
  await runWorker("scout.research", "after-commit", second.launch)
  await runWorker("quill.script", "after-commit")
  await runWorker("pixel.render", "after-output")
  const {
    rows: [job],
  } = await pool.query(
    "SELECT pixel_job_id FROM pixel_render_jobs WHERE run_id=$1",
    [currentRunId],
  )
  assert(job.pixel_job_id)
  const before = await ticketRenderStorage(dataRoot).resolveCompletedOutput(
    job.pixel_job_id,
  )
  assert(before)
  const committed = await runWorker("pixel.render", "after-commit")
  const { deliverable } = await loadInputs(
    pool,
    second.ticketId,
    committed.payload.deliverableId,
  )
  assert.equal(deliverable.pixel_job_id, job.pixel_job_id)
  assert.equal(committed.attempts, 2)
  await runWorker("vera.review", "after-commit")
  assert.equal(await settle(pool, currentRunId), "completed")
  console.log(
    "PASS crash/restart: all nine boundaries, stale fence refused, no duplicate artifacts, verified output reused",
  )
}
