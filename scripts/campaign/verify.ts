import "../load-env"

import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { createScratchDatabase } from "../../tests/db/helpers"
import { seedTicket } from "../pixel/fixtures"
import { FIXTURE_PRODUCTS, startFixtureSites } from "../scout/fixture-sites"
import { settle, ticketVersion } from "../vera/fixtures"
import { CHECKLIST, type Checklist } from "@/lib/approvals/policy"
import type { CampaignSelection } from "@/lib/orchestrator/types"
import { approvalEligibility, recordDecision } from "@/server/approvals/store"
import { checksumSelection } from "@/server/campaign/launch"
import { journal } from "@/server/db/journal"
import { migrationsFolder, runMigrations } from "@/server/db/migrations"
import { createDatabase, createPool } from "@/server/db/pool"
import {
  campaignWorkerAvailable,
  cancelRun,
  pauseRun,
  retryTask,
  getRun,
  planRun,
  type PlanInput,
} from "@/server/orchestrator/store"
import { createRegistry } from "@/server/orchestrator/workflows"
import { Worker } from "@/server/orchestrator/worker"
import { ticketRenderStorage } from "@/server/pixel/store"
import { updateProduct } from "@/server/tickets/repository"
import { fileDigest } from "@/server/vera/video"
import { getReview } from "@/server/vera/store"
import { loadInputs } from "@/server/vera/inputs"
import {
  verifyCampaignBackup,
  verifyCampaignPause,
  verifyCampaignPreflight,
} from "./checks"
import { verifyCrashes } from "./crashes"
import { fixtureCampaignHandlers } from "./handlers"

const narrowBuds = {
  ...FIXTURE_PRODUCTS.buds,
  references: FIXTURE_PRODUCTS.buds.references.filter(
    (reference) => reference.kind === "listing",
  ),
}

async function verify() {
  assert.equal(
    process.platform,
    "linux",
    "Campaign verification requires Linux or WSL.",
  )
  const scratch = await createScratchDatabase("campaign")
  let pool = createPool(scratch.config, { max: 12 })
  const dataRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "deskverse-campaign-"),
  )
  const sites = await startFixtureSites()
  const blocked = new Set<string>()
  const corrupt = new Map<string, string>()
  const batchArguments = process.argv.slice(2)
  assert(
    batchArguments.every((arg) => ["1", "3", "10", "crashes"].includes(arg)),
    "Use optional development batches 1, 3, 10 or crashes.",
  )
  const batches = batchArguments.length
    ? batchArguments.filter((arg) => arg !== "crashes").map(Number)
    : [1, 3, 10]
  const workers: Worker[] = []
  const auditFile = path.join(dataRoot, "render-lock-audit.jsonl")
  async function startWorkers() {
    for (const _ of [1, 2]) {
      workers.push(
        new Worker({
          pool,
          slots: 2,
          pollMs: 50,
          campaignCapable: true,
          registry: createRegistry({
            verification: false,
            production: fixtureCampaignHandlers(pool, dataRoot, sites.port, {
              blocked,
              corrupt,
              auditFile,
              log: console.log,
            }),
          }),
          log: console.log,
        }).start(),
      )
    }
    for (let attempt = 0; !(await campaignWorkerAvailable(pool)); attempt++) {
      assert(attempt < 100, "Campaign worker missing.")
      await sleep(50)
    }
  }

  try {
    await runMigrations(pool, journal, migrationsFolder())
    if (batches.length) await startWorkers()

    for (const count of batches) {
      const ticket = await seedTicket({
        pool,
        dataRoot,
        fixturePort: sites.port,
        runStandalone: false,
        title: `Automatic campaign verification (${count})`,
        products: Array.from({ length: count }, (_, i) => {
          const base =
            count === 10 && i === 8 ? narrowBuds : FIXTURE_PRODUCTS.kettle
          return {
            base,
            name: base.name,
            images: 3,
            mediaRights:
              count === 10 && [6, 7].includes(i) ? "unspecified" : "owned",
          }
        }),
      })
      if (count === 10) blocked.add(ticket.products[9].productId)
      const selections: CampaignSelection[] = ticket.products.map(
        ({ productId, assetIds }) => ({
          productId,
          assetIds: [assetIds[1], assetIds[0], assetIds[2]],
          rightsAcknowledged: true,
        }),
      )
      const request: PlanInput = {
        ticketId: ticket.ticketId,
        ticketVersion: await ticketVersion(pool, ticket.ticketId),
        requestId: randomUUID(),
        workflow: "campaign-v1",
        mode: "production",
        productionAvailable: true,
        verificationAllowed: true,
        campaign: { selections, testing: true, dataRoot },
      }
      if (count === 1 && batchArguments.length === 0)
        await verifyCampaignPreflight(pool, request)
      const { runId } = await planRun(pool, request)
      if (count === 1 && batchArguments.length === 0)
        await verifyCampaignPause(pool, request, runId)
      assert.deepEqual(await planRun(pool, request), { runId, created: false })
      await assert.rejects(
        planRun(pool, {
          ...request,
          campaign: {
            ...request.campaign!,
            selections: selections.map((s, i) =>
              i === 0 ? { ...s, assetIds: [...s.assetIds].reverse() } : s,
            ),
          },
        }),
        /different ticket or campaign selection/,
      )
      const result = await settle(pool, runId)
      assert.equal(result, count === 10 ? "completed_with_errors" : "completed")
      const detail = await getRun(pool, ticket.ticketId, runId)
      assert.equal(detail?.products.length, count)
      const approvals = []
      let negative = 0
      for (const [i, product] of detail!.products.entries()) {
        const selection = selections[i]
        assert.equal(product.tasks.length, 4)
        assert.equal(product.productId, selection.productId)
        const snapshot = (
          await pool.query(
            "SELECT campaign_selection, campaign_selection_checksum FROM run_product_snapshots WHERE id=$1",
            [product.snapshotId],
          )
        ).rows[0]
        assert.deepEqual(snapshot.campaign_selection, selection)
        assert.equal(
          snapshot.campaign_selection_checksum,
          checksumSelection(product.checksum, selection),
        )
        const [scout, quill, pixel, vera] = product.tasks
        if (count === 10 && i === 9) {
          assert.equal(scout.status, "failed")
          assert.equal(
            scout.failureMessage,
            "Injected campaign fixture failure.",
          )
          assert(
            [quill, pixel, vera].every((task) => task.status === "blocked"),
          )
          continue
        }
        if (count === 10 && i === 8) {
          assert.equal(scout.status, "completed")
          assert.equal(quill.status, "needs_input")
          assert.match(quill.failureMessage ?? "", /Quill needs 2/)
          assert([pixel, vera].every((task) => task.status === "blocked"))
          continue
        }
        assert(product.tasks.every((task) => task.status === "completed"))
        const id = pixel.result!.artifactId
        const { pin, deliverable, script, renderJob } = await loadInputs(
          pool,
          ticket.ticketId,
          id,
        )
        assert.equal(pin.manifest.report.id, scout.result?.artifactId)
        assert.equal(script.id, quill.result?.artifactId)
        assert.equal(script.taskId, quill.id)
        assert.equal(script.runId, runId)
        assert.equal(pin.productId, product.productId)
        assert.equal(pin.sourceSnapshotId, product.snapshotId)
        assert.equal(pin.manifest.snapshotChecksum, product.checksum)
        assert.deepEqual(
          pin.manifest.assets.map((asset) => asset.id),
          selection.assetIds,
        )
        assert.equal(pin.rightsAcknowledged, true)
        assert.equal(deliverable.run_id, runId)
        assert.equal(renderJob.run_id, runId)
        const file = await ticketRenderStorage(dataRoot).resolveCompletedOutput(
          deliverable.pixel_job_id,
        )
        assert(file)
        assert.equal(await fileDigest(file.path), pin.sha256)
        const review = await getReview(
          pool,
          ticket.ticketId,
          vera.result!.artifactId,
        )
        assert.equal(review?.integrity, "verified")
        assert.deepEqual(review?.document.pin, pin)
        const approval = await approvalEligibility(pool, id, dataRoot)
        assert.equal(approval.decision, null)
        assert.equal(approval.eligibility.eligible, false)
        if (count === 10 && [6, 7].includes(i)) {
          assert.equal(review?.document.verdict, "needs_owner_input")
          assert.equal(approval.eligibility.canApprove, false)
          assert(
            review.document.findings.some(
              (finding) =>
                finding.category === "media_rights" &&
                finding.outcome !== "passed",
            ),
          )
          await assert.rejects(
            recordDecision(
              pool,
              id,
              {
                kind: "approved",
                reviewId: review.id,
                requestId: randomUUID(),
                expectedDecisionId: null,
                notes: "",
                reason: "",
                checklist: Object.fromEntries(
                  Object.keys(CHECKLIST).map((key) => [key, true]),
                ) as Checklist,
                revision: null,
              },
              dataRoot,
            ),
          )
          negative++
        } else {
          assert.equal(review?.document.verdict, "pass")
          assert.equal(approval.eligibility.canApprove, true)
          approvals.push({ id, reviewId: review.id })
        }
      }
      assert.equal(approvals.length, count === 10 ? 6 : count)
      assert.equal(negative, count === 10 ? 2 : 0)
      console.log(
        `PASS campaign ${count}: ${approvals.length} passing QA candidates and ${negative} QA rights blockers, exact pins and media checked, zero automatic decisions`,
      )
      if (count === 1) {
        const [{ id, reviewId }] = approvals
        const checklist = Object.fromEntries(
          Object.keys(CHECKLIST).map((key) => [key, true]),
        ) as Checklist
        await recordDecision(
          pool,
          id,
          {
            kind: "approved",
            reviewId,
            requestId: randomUUID(),
            expectedDecisionId: null,
            notes: "",
            reason: "",
            checklist,
            revision: null,
          },
          dataRoot,
        )
        assert.equal(
          (await approvalEligibility(pool, id, dataRoot)).eligibility.eligible,
          true,
        )
        console.log(
          "PASS explicit owner approval on a completed campaign deliverable",
        )
        if (batchArguments.length === 0) {
          await Promise.all(workers.splice(0).map((worker) => worker.stop()))
          try {
            await verifyCampaignBackup(
              scratch,
              pool,
              dataRoot,
              ticket.ticketId,
              runId,
              id,
            )
          } finally {
            if (pool.ended) pool = createPool(scratch.config, { max: 12 })
          }
          await startWorkers()
          const cancelled = await planRun(pool, {
            ...request,
            requestId: randomUUID(),
          })
          await pauseRun(pool, ticket.ticketId, cancelled.runId, randomUUID())
          const readFrozen = async () =>
            (
              await pool.query(
                "SELECT data, checksum, campaign_selection, campaign_selection_checksum FROM run_product_snapshots WHERE run_id=$1",
                [cancelled.runId],
              )
            ).rows
          const frozen = await readFrozen()
          assert.equal(frozen.length, 1)
          assert.equal(
            (await approvalEligibility(pool, id, dataRoot)).eligibility
              .eligible,
            true,
          )
          await updateProduct(
            createDatabase(pool),
            ticket.ticketId,
            ticket.products[0].productId,
            {
              description: "Owner correction after campaign planning",
            },
          )
          assert.deepEqual(await readFrozen(), frozen)
          await cancelRun(pool, ticket.ticketId, cancelled.runId, randomUUID())
          assert.equal(await settle(pool, cancelled.runId), "cancelled")
          console.log(
            "PASS edit after planning preserves frozen inputs, and cancellation stops the new run",
          )
          const historical = await approvalEligibility(pool, id, dataRoot)
          assert.equal(historical.decision?.kind, "approved")
          assert.equal(historical.eligibility.eligible, false)
          assert.equal(historical.eligibility.historical, true)
          console.log(
            "PASS approval stays auditable after changed campaign inputs invalidate eligibility",
          )
        }
      }
      if (count === 10 && batchArguments.length === 0) {
        const product = detail!.products[9]
        blocked.delete(product.productId)
        await retryTask(
          pool,
          ticket.ticketId,
          runId,
          product.tasks[0].id,
          randomUUID(),
        )
        assert.equal(await settle(pool, runId), "completed_with_errors")
        const done = await getRun(pool, ticket.ticketId, runId)
        assert(
          done?.products[9].tasks.every((task) => task.status === "completed"),
        )
        assert.deepEqual(done?.products[0].tasks, detail!.products[0].tasks)
        console.log(
          "PASS manual upstream retry: only the failed product advances",
        )
      }
    }
    if (!batchArguments.length) {
      const ticket = await seedTicket({
        pool,
        dataRoot,
        fixturePort: sites.port,
        runStandalone: false,
        products: Array.from({ length: 3 }, () => ({
          base: FIXTURE_PRODUCTS.kettle,
          name: FIXTURE_PRODUCTS.kettle.name,
          images: 3,
        })),
      })
      const stages = ["scout.research", "quill.script", "pixel.render"]
      for (const [i, product] of ticket.products.entries())
        corrupt.set(product.productId, stages[i])
      const { runId } = await planRun(pool, {
        ticketId: ticket.ticketId,
        ticketVersion: await ticketVersion(pool, ticket.ticketId),
        requestId: randomUUID(),
        workflow: "campaign-v1",
        mode: "production",
        productionAvailable: true,
        verificationAllowed: true,
        campaign: {
          dataRoot,
          testing: true,
          selections: ticket.products.map(({ productId, assetIds }) => ({
            productId,
            assetIds,
            rightsAcknowledged: true,
          })),
        },
      })
      assert.equal(await settle(pool, runId), "completed_with_errors")
      const detail = await getRun(pool, ticket.ticketId, runId)
      for (const [i, product] of detail!.products.entries()) {
        assert.equal(product.tasks[i].status, "completed")
        const dependent = product.tasks[i + 1]
        assert.equal(dependent.status, "needs_input")
        assert.match(dependent.failureMessage ?? "", /does not verify/)
        assert.equal(dependent.attempts, 0)
        assert(
          product.tasks.slice(i + 2).every((task) => task.status === "blocked"),
        )
        await assert.rejects(
          retryTask(pool, ticket.ticketId, runId, dependent.id, randomUUID()),
          /corrected inputs/,
        )
      }
      console.log(
        "PASS all three handoffs refuse corrupt upstream result pins without claiming any dependent",
      )
    }
    await Promise.all(workers.splice(0).map((worker) => worker.stop()))
    if (batches.length) {
      let held: string | null = null
      let acquired = 0
      for (const line of (await fs.readFile(auditFile, "utf8"))
        .trim()
        .split("\n")) {
        const { event, token } = JSON.parse(line)
        if (event === "acquired") {
          assert.equal(
            held,
            null,
            "Two campaign renders held the installation gate.",
          )
          held = token
          acquired++
        } else if (event === "released") {
          assert.equal(held, token)
          held = null
        }
      }
      assert.equal(held, null)
      assert(acquired > 0)
      console.log(
        `PASS render gate serialized ${acquired} actual Pixel renders`,
      )
    }
    if (!batchArguments.length || batchArguments.includes("crashes"))
      await verifyCrashes(scratch, pool, dataRoot, sites.port)
  } finally {
    await Promise.all(workers.map((worker) => worker.stop()))
    await pool.end()
    await sites.close()
    await scratch.drop()
    await fs.rm(dataRoot, { recursive: true, force: true })
  }
}

verify().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
