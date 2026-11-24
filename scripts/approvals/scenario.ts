import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  CHECKLIST,
  type Checklist,
  type DecisionInput,
} from "@/lib/approvals/policy"
import {
  approvalEligibility,
  approvalHistory,
  recordBulkDecisions,
  recordDecision,
} from "@/server/approvals/store"
import { createBackup, restoreBackup } from "@/server/backup/backup"
import { journal } from "@/server/db/journal"
import { migrationsFolder, runMigrations } from "@/server/db/migrations"
import { createDatabase, createPool } from "@/server/db/pool"
import { cancelRun } from "@/server/orchestrator/store"
import { createVeraHandler } from "@/server/vera/handler"
import { ticketRenderStorage } from "@/server/pixel/store"
import { createScratchDatabase } from "../../tests/db/helpers"
import { startFixtureSites } from "../scout/fixture-sites"
import {
  planVera,
  renderVeraFixtureVideos,
  seedVideos,
  settle,
  ticketVersion,
  worker,
} from "../vera/fixtures"
import { changeStatus, updateProduct } from "@/server/tickets/repository"

export async function verifyApprovals(log: (message: string) => void) {
  const source = await createScratchDatabase("approvals")
  const target = await createScratchDatabase("approvals_restore")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-approvals-"))
  const dataRoot = path.join(root, "data")
  await fs.mkdir(dataRoot)
  let pool = createPool(source.config, { max: 8 })
  const sites = await startFixtureSites()
  const checklist = Object.fromEntries(
    Object.keys(CHECKLIST).map((key) => [key, true]),
  ) as Checklist
  try {
    await runMigrations(pool, journal, migrationsFolder())
    const seed = await seedVideos({
      pool,
      dataRoot,
      fixturePort: sites.port,
      count: 10,
      unspecified: true,
    })
    const deliverables = seed.products.map((product) =>
      seed.deliverables.find((d) => d.product_id === product.productId)!,
    )
    const ids: string[] = deliverables.map((d) => d.id)
    const videos = deliverables.map((d) => ({
      productId: d.product_id as string,
      deliverableId: d.id as string,
    }))
    const run = await planVera(pool, dataRoot, seed.ticketId, videos)
    const damaged = (await ticketRenderStorage(dataRoot).resolveCompletedOutput(
      deliverables[8].pixel_job_id,
    ))!
    const bytes = await fs.readFile(damaged.path)
    await fs.chmod(damaged.path, 0o600)
    await fs.writeFile(damaged.path, Buffer.alloc(bytes.length))
    const qa = worker(pool, [
      createVeraHandler({
        pool,
        dataRoot,
        commands: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
      }),
    ])
    try {
      assert.equal(await settle(pool, run.runId), "completed")
    } finally {
      await qa.stop()
      await fs.writeFile(damaged.path, bytes)
      await fs.chmod(damaged.path, 0o400)
    }
    assert.equal(
      Number(
        (await pool.query("SELECT count(*) FROM approval_decisions")).rows[0]
          .count,
      ),
      0,
    )
    const detail = await Promise.all(
      ids.map((id) => approvalEligibility(pool, id, dataRoot)),
    )
    assert.deepEqual(
      detail.map(({ review }) => review?.document.verdict),
      [
        "pass",
        "pass",
        "pass",
        "pass",
        "pass",
        "pass",
        "pass",
        "pass",
        "failed",
        "needs_owner_input",
      ],
    )
    log(
      "PASS 10 genuine MP4s and 10 persisted Vera assessments, with no implicit decisions",
    )
    const request = (
      index: number,
      kind: DecisionInput["kind"],
    ): DecisionInput => ({
      requestId: randomUUID(),
      expectedDecisionId: null,
      reviewId: detail[index].review!.id,
      kind,
      notes: "",
      reason: kind === "approved" ? "" : "Fixture review reason",
      checklist: kind === "approved" ? checklist : null,
      revision:
        kind === "revision_requested"
          ? {
              categories: ["Caption"],
              correction: "Revise the opening caption.",
              sceneIds: [],
            }
          : null,
    })
    const approve = request(0, "approved")
    const recorded = await recordDecision(pool, ids[0], approve, dataRoot)
    assert.deepEqual(
      await recordDecision(pool, ids[0], approve, dataRoot),
      recorded,
    )
    await assert.rejects(
      recordDecision(pool, ids[0], { ...approve, notes: "Changed" }, dataRoot),
      { status: 409 },
    )

    const race = await Promise.allSettled([
      recordDecision(pool, ids[1], request(1, "approved"), dataRoot),
      recordDecision(pool, ids[1], request(1, "rejected"), dataRoot),
    ])
    assert.equal(
      race.filter((result) => result.status === "fulfilled").length,
      1,
    )
    assert.equal(
      race.find((result) => result.status === "rejected")?.reason.status,
      409,
    )
    const [head] = await approvalHistory(pool, ids[1])
    if (head.kind === "rejected")
      await recordDecision(
        pool,
        ids[1],
        { ...request(1, "approved"), expectedDecisionId: head.id },
        dataRoot,
      )
    const batch = [2, 3, 4, 5, 8, 9].map((index) => ({
      deliverableId: ids[index],
      input: request(index, "approved"),
    }))
    const bulk = await recordBulkDecisions(pool, batch, dataRoot)
    assert.deepEqual(
      bulk.map((result) => result.ok),
      [true, true, true, true, false, false],
    )
    assert.deepEqual(await recordBulkDecisions(pool, batch, dataRoot), bulk)
    log("PASS partial batch success and identical retry receipts")
    for (const index of [6, 7])
      await recordDecision(
        pool,
        ids[index],
        request(index, "revision_requested"),
        dataRoot,
      )
    await assert.rejects(
      recordDecision(pool, ids[8], request(8, "approved"), dataRoot),
      { status: 409 },
    )
    await assert.rejects(
      recordDecision(pool, ids[9], request(9, "approved"), dataRoot),
      { status: 409 },
    )
    await recordDecision(pool, ids[8], request(8, "rejected"), dataRoot)
    assert.equal(
      (
        await Promise.all(
          ids.map((id) => approvalEligibility(pool, id, dataRoot)),
        )
      ).filter((item) => item.eligibility.eligible).length,
      6,
    )
    log(
      "PASS six independent approvals, two revisions, one rejection and one owner-input candidate",
    )
    log(
      "PASS idempotent replay, payload conflicts and concurrent approval/rejection",
    )

    const corruption = await pool.connect()
    try {
      await corruption.query("BEGIN")
      await corruption.query(
        "ALTER TABLE quill_scenes DISABLE TRIGGER quill_scenes_immutable",
      )
      await corruption.query(
        "UPDATE quill_scenes SET caption='Altered caption' WHERE script_id=$1",
        [deliverables[0].script_id],
      )
      const invalidated = await approvalEligibility(
        corruption,
        ids[0],
        dataRoot,
      )
      assert.ok(invalidated.eligibility.reasons.includes("lineage"))
      assert.equal(invalidated.eligibility.eligible, false)
    } finally {
      await corruption.query("ROLLBACK")
      corruption.release()
    }
    assert.equal(
      (await approvalEligibility(pool, ids[0], dataRoot)).eligibility.eligible,
      true,
    )
    log(
      "PASS a broken Quill lineage blocks approval; rollback restored the original fixture",
    )

    const firstFile = (await ticketRenderStorage(
      dataRoot,
    ).resolveCompletedOutput(deliverables[0].pixel_job_id))!
    await fs.rename(firstFile.path, `${firstFile.path}.test`)
    assert.ok(
      (
        await approvalEligibility(pool, ids[0], dataRoot)
      ).eligibility.reasons.includes("media_integrity"),
    )
    await fs.copyFile(`${firstFile.path}.test`, firstFile.path)
    await fs.chmod(firstFile.path, 0o600)
    await fs.writeFile(firstFile.path, Buffer.alloc(firstFile.sizeBytes))
    assert.equal(
      (await approvalEligibility(pool, ids[0], dataRoot)).eligibility.eligible,
      false,
    )
    await fs.rename(`${firstFile.path}.test`, firstFile.path)
    assert.equal(
      (await approvalEligibility(pool, ids[0], dataRoot)).eligibility.eligible,
      true,
    )
    await assert.rejects(
      pool.query("UPDATE approval_decisions SET notes='changed' WHERE id=$1", [
        recorded.decision.id,
      ]),
    )
    await assert.rejects(
      pool.query("DELETE FROM approval_decisions WHERE id=$1", [
        recorded.decision.id,
      ]),
    )
    await assert.rejects(pool.query("TRUNCATE approval_decisions"))
    for (const field of ["ticket_id", "product_id", "review_id"]) {
      await assert.rejects(
        pool.query(
          `INSERT INTO approval_decisions
         SELECT (jsonb_populate_record(null::approval_decisions, to_jsonb(d) ||
           jsonb_build_object('id',gen_random_uuid(),'previous_id',d.id,'request_id',gen_random_uuid(),$2::text,gen_random_uuid()))).*
         FROM approval_decisions d WHERE d.id=$1`,
          [recorded.decision.id, field],
        ),
        { constraint: "approval_decisions_review_pin_fk" },
      )
    }
    assert.equal((await approvalHistory(pool, ids[0])).length, 1)
    log(
      "PASS cross-ticket/product/review inserts are rejected without changing persisted history",
    )

    log(
      "PASS missing and same-size modified media invalidate approval; the audit record is immutable",
    )

    const withdrawal = await recordDecision(
      pool,
      ids[0],
      {
        ...request(0, "withdrawn"),
        expectedDecisionId: recorded.decision.id,
      },
      dataRoot,
    )
    assert.equal(withdrawal.eligibility.eligible, false)
    assert.deepEqual(
      await recordDecision(pool, ids[0], approve, dataRoot),
      recorded,
    )
    assert.equal(
      (await approvalEligibility(pool, ids[0], dataRoot)).eligibility.eligible,
      false,
    )

    assert.equal((await approvalHistory(pool, ids[0])).length, 2)
    await recordDecision(
      pool,
      ids[0],
      {
        ...request(0, "approved"),
        expectedDecisionId: withdrawal.decision.id,
      },
      dataRoot,
    )
    const before = (
      await pool.query("SELECT * FROM approval_decisions ORDER BY id")
    ).rows
    await pool.end()
    const backup = await createBackup({
      db: source.config,
      journal,
      dataRoot,
      backupsRoot: path.join(root, "backups"),
      projectRoot: process.cwd(),
      deskverseVersion: "DV-006B verification",
      checkProcesses: false,
    })
    assert.equal(backup.manifest.formatVersion, 3)
    assert.equal(
      backup.manifest.database.tables.approval_decisions,
      before.length,
    )
    const restoredRoot = path.join(root, "restored")
    await restoreBackup({
      dir: backup.dir,
      target: target.config,
      dataRoot: restoredRoot,
      journal,
    })
    pool = createPool(target.config, { max: 8 })
    assert.deepEqual(
      (await pool.query("SELECT * FROM approval_decisions ORDER BY id")).rows,
      before,
    )
    const restored = await Promise.all(
      ids.map((id) => approvalEligibility(pool, id, restoredRoot)),
    )
    assert.equal(restored.filter((item) => item.eligibility.eligible).length, 6)
    assert.ok(
      restored.every(
        (item) => item.script && item.review?.integrity === "verified",
      ),
    )
    log(
      "PASS withdrawal and reapproval preserve history; format-3 backup restores exact decisions, lineage and six eligible approvals",
    )

    const cancelled = await planVera(pool, restoredRoot, seed.ticketId, [
      videos[0],
    ])
    await cancelRun(pool, seed.ticketId, cancelled.runId, randomUUID())
    assert.equal(await settle(pool, cancelled.runId), "cancelled")
    assert.deepEqual(
      (await pool.query("SELECT * FROM approval_decisions ORDER BY id")).rows,
      before,
    )
    const newerReview = await planVera(pool, restoredRoot, seed.ticketId, [
      videos[0],
    ])
    const pinnedFile = (await ticketRenderStorage(
      restoredRoot,
    ).resolveCompletedOutput(deliverables[0].pixel_job_id))!
    const pinnedBytes = await fs.readFile(pinnedFile.path)
    await fs.chmod(pinnedFile.path, 0o600)
    await fs.writeFile(pinnedFile.path, Buffer.alloc(pinnedBytes.length))
    const nextQa = worker(pool, [
      createVeraHandler({
        pool,
        dataRoot: restoredRoot,
        commands: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
      }),
    ])
    try {
      assert.equal(await settle(pool, newerReview.runId), "completed")
    } finally {
      await nextQa.stop()
      await fs.writeFile(pinnedFile.path, pinnedBytes)
      await fs.chmod(pinnedFile.path, 0o400)
    }
    const reassessed = await approvalEligibility(pool, ids[0], restoredRoot)
    assert.equal(reassessed.review?.document.verdict, "failed")
    assert.equal(reassessed.eligibility.eligible, false)
    assert.equal(reassessed.decision?.kind, "approved")
    await assert.rejects(
      recordDecision(
        pool,
        ids[0],
        {
          ...request(0, "approved"),
          expectedDecisionId: reassessed.decision!.id,
        },
        restoredRoot,
      ),
      { status: 409 },
    )

    const product = seed.products[1]
    await renderVeraFixtureVideos(
      { pool, dataRoot: restoredRoot },
      seed.ticketId,
      [
        {
          productId: product.productId,
          scriptId: product.scriptId!,
          assetIds: product.assetIds,
          rightsAcknowledged: true,
        },
      ],
    )
    const successor = (
      await pool.query(
        "SELECT id FROM pixel_deliverables WHERE product_id=$1 ORDER BY deliverable_version DESC LIMIT 1",
        [product.productId],
      )
    ).rows[0].id
    assert.notEqual(successor, ids[1])
    assert.ok(
      (
        await approvalEligibility(pool, ids[1], restoredRoot)
      ).eligibility.reasons.includes("superseded"),
    )
    assert.equal(
      (await approvalEligibility(pool, successor, restoredRoot)).decision,
      null,
    )
    log(
      "PASS newer failing review and newer Pixel version invalidate without inheriting or rewriting an approval",
    )

    const db = createDatabase(pool)
    const originalProduct = restored[0].candidate.snapshot.product
    const draft = await changeStatus(
      db,
      seed.ticketId,
      await ticketVersion(pool, seed.ticketId),
      "draft",
    )
    await updateProduct(db, seed.ticketId, seed.products[0].productId, {
      description: originalProduct.description + " Updated.",
    })
    assert.ok(
      (
        await approvalEligibility(pool, ids[0], restoredRoot)
      ).eligibility.reasons.includes("inputs_changed"),
    )
    const archived = await changeStatus(
      db,
      seed.ticketId,
      await ticketVersion(pool, seed.ticketId),
      "archived",
    )
    assert.ok(archived.version > draft.version)
    assert.ok(
      (
        await approvalEligibility(pool, ids[0], restoredRoot)
      ).eligibility.reasons.includes("archived"),
    )
    assert.deepEqual(
      (await pool.query("SELECT * FROM approval_decisions ORDER BY id")).rows,
      before,
    )
    log(
      "PASS product edits and archive make approvals ineligible while preserving their audit records",
    )
  } finally {
    await pool.end().catch(() => {})
    await sites.close()
    await source.drop()
    await target.drop()
    await fs.rm(root, { recursive: true, force: true })
  }
}
