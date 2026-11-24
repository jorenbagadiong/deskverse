import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type pg from "pg"

import {
  createScratchDatabase,
  type ScratchDatabase,
} from "../../tests/db/helpers"
import { approvalEligibility } from "@/server/approvals/store"
import { createBackup, restoreBackup } from "@/server/backup/backup"
import { journal } from "@/server/db/journal"
import { createDatabase, createPool } from "@/server/db/pool"
import {
  claimTask,
  getRun,
  pauseRun,
  planRun,
  resumeRun,
  type PlanInput,
} from "@/server/orchestrator/store"
import { assetFilePath } from "@/server/tickets/media"
import { removeProduct } from "@/server/tickets/repository"

export async function verifyCampaignPreflight(pool: pg.Pool, input: PlanInput) {
  const campaign = input.campaign!
  const [selection] = campaign.selections
  const attempt = async (overrides: Partial<PlanInput>, message: RegExp) => {
    const requestId = randomUUID()
    await assert.rejects(
      planRun(pool, { ...input, ...overrides, requestId }),
      message,
    )
    const { rowCount } = await pool.query(
      "SELECT 1 FROM campaign_runs WHERE request_id=$1",
      [requestId],
    )
    assert.equal(rowCount, 0, "Refused campaign left persisted state.")
  }
  const selections = (changes: Record<string, unknown>) => ({
    ...campaign,
    selections: [{ ...selection, ...changes }] as typeof campaign.selections,
  })
  await attempt({ workflow: undefined }, /explicit production campaign/)
  await attempt({ productionAvailable: false }, /compatible campaign worker/)
  await attempt({ ticketVersion: input.ticketVersion - 1 }, /ticket changed/)
  await attempt({ ticketId: randomUUID() }, /own product on this ticket/)
  await attempt(
    { campaign: selections({ productId: randomUUID() }) },
    /own product on this ticket/,
  )
  await attempt(
    { campaign: { ...campaign, selections: [selection, selection] } },
    /select each product once/i,
  )
  await attempt(
    {
      campaign: selections({
        assetIds: [
          selection.assetIds[0],
          selection.assetIds[0],
          selection.assetIds[1],
        ],
      }),
    },
    /distinct images/,
  )
  await attempt(
    { campaign: selections({ rightsAcknowledged: false }) },
    /confirm media use/,
  )

  const id = selection.assetIds[0]
  const {
    rows: [asset],
  } = await pool.query("SELECT extension FROM ticket_assets WHERE id=$1", [id])
  const file = assetFilePath(
    campaign.dataRoot,
    input.ticketId,
    id,
    asset.extension,
  )
  await fs.rename(file, file + ".fixture-original")
  try {
    await attempt({}, /missing, unsafe, or has changed/)
    const bytes = await fs.readFile(file + ".fixture-original")
    bytes[Math.floor(bytes.length / 2)] ^= 1
    await fs.writeFile(file, bytes)
    await attempt({}, /missing, unsafe, or has changed/)
  } finally {
    await fs.rename(file + ".fixture-original", file)
  }
  console.log(
    "PASS preflight: zero runs on stale version, unavailable worker capability, foreign ownership, invalid selections, missing rights, missing or altered images",
  )
}

export async function verifyCampaignPause(
  pool: pg.Pool,
  input: PlanInput,
  runId: string,
) {
  await pauseRun(pool, input.ticketId, runId, randomUUID())
  const deadline = Date.now() + 20_000
  let detail = await getRun(pool, input.ticketId, runId)
  while (detail?.run.status === "pausing" && Date.now() < deadline) {
    await sleep(40)
    detail = await getRun(pool, input.ticketId, runId)
  }
  assert.equal(detail?.run.status, "paused")
  assert.equal(
    await claimTask(pool, {
      workerId: "paused-campaign-proof",
      stages: ["scout.research", "quill.script", "pixel.render", "vera.review"],
      leaseMs: 2500,
      campaignCapable: true,
    }),
    null,
  )
  await assert.rejects(
    removeProduct(
      createDatabase(pool),
      input.ticketId,
      input.campaign!.selections[0].productId,
    ),
    /workflow run that hasn't finished/,
  )
  await assert.rejects(
    planRun(pool, { ...input, requestId: randomUUID() }),
    /unfinished run/,
  )
  await resumeRun(pool, input.ticketId, runId, randomUUID())
  console.log(
    "PASS campaign pause/resume, frozen inputs protected during active run, concurrent launch refused",
  )
}

export async function verifyCampaignBackup(
  source: ScratchDatabase,
  pool: pg.Pool,
  dataRoot: string,
  ticketId: string,
  runId: string,
  deliverableId: string,
) {
  const target = await createScratchDatabase("campaignrestore")
  const restoredPool = createPool(target.config, { max: 2 })
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "deskverse-campaign-backup-"),
  )
  try {
    const { rows: original } = await pool.query(
      "SELECT campaign_selection, campaign_selection_checksum FROM run_product_snapshots WHERE run_id=$1 ORDER BY position",
      [runId],
    )
    const originalRun = await getRun(pool, ticketId, runId)
    await pool.end()
    const backup = await createBackup({
      db: source.config,
      journal,
      dataRoot,
      backupsRoot: path.join(root, "backups"),
      projectRoot: process.cwd(),
      deskverseVersion: "DV-006C campaign verification",
      checkProcesses: false,
    })
    const restoredRoot = path.join(root, "restored")
    const restore = await restoreBackup({
      dir: backup.dir,
      target: target.config,
      dataRoot: restoredRoot,
      journal,
    })
    assert.equal(restore.migration, "0008_automatic_campaign_handoffs")
    const { rows: restored } = await restoredPool.query(
      "SELECT campaign_selection, campaign_selection_checksum FROM run_product_snapshots WHERE run_id=$1 ORDER BY position",
      [runId],
    )
    assert.deepEqual(restored, original)
    assert.deepEqual(await getRun(restoredPool, ticketId, runId), originalRun)
    const current = await approvalEligibility(
      restoredPool,
      deliverableId,
      restoredRoot,
    )
    assert.equal(current.eligibility.eligible, true)
    console.log(
      "PASS format-3 backup/restore: frozen selections, results, verified MP4, lineage and explicit approval survived",
    )
  } finally {
    await restoredPool.end()
    await target.drop()
    await fs.rm(root, { recursive: true, force: true })
  }
}
