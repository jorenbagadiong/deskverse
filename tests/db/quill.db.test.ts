import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  FIXTURE_PRODUCTS,
  startFixtureSites,
  type FixtureSites,
} from "../../scripts/scout/fixture-sites"
import { validateNewTicket } from "@/lib/tickets/validation"
import { createBackup, restoreBackup } from "@/server/backup/backup"
import { journal } from "@/server/db/journal"
import { migrationsFolder, runMigrations } from "@/server/db/migrations"
import { createDatabase, createPool } from "@/server/db/pool"
import {
  CAMPAIGN_UNAVAILABLE,
  cancelRun,
  claimTask,
  completeTask,
  planRun,
  recoverExpiredLeases,
  retryTask,
  type Claim,
} from "@/server/orchestrator/store"
import {
  createRegistry,
  QUILL_WORKFLOW,
  RESEARCH_WORKFLOW,
  type HandlerOutcome,
  type TaskHandler,
} from "@/server/orchestrator/workflows"
import { Worker } from "@/server/orchestrator/worker"
import { createQuillHandler } from "@/server/quill/handler"
import { readQuillConfig } from "@/server/quill/ollama"
import { composeScript } from "@/server/quill/compose"
import { selectFacts } from "@/server/quill/select"
import {
  getScript,
  listRunScripts,
  persistScript,
  quillOverview,
} from "@/server/quill/store"
import { verifyScoutReport } from "@/server/scout/store"
import { readScoutConfig } from "@/server/scout/config"
import { createScoutHandler } from "@/server/scout/handler"
import { testNetwork } from "@/server/scout/net/test-network"
import type { FetchLike } from "@/server/scout/ollama"
import {
  addProduct,
  changeStatus,
  createTicket,
  updateProduct,
} from "@/server/tickets/repository"

import { createScratchDatabase, type ScratchDatabase } from "./helpers"

/**
 * DV-005B on real PostgreSQL (scratch databases only): Quill runs plan
 * from explicitly chosen, verified, current Scout reports; scripts are
 * written atomically under the lease and fence, only from eligible claims
 * (the database refuses others), immutable, versioned and checksummed.
 */

let scratch: ScratchDatabase
let pool: pg.Pool
let sites: FixtureSites
const scratches: ScratchDatabase[] = []
let temp = ""

beforeAll(async () => {
  scratch = await createScratchDatabase("quill")
  pool = createPool(scratch.config, { max: 10 })
  await runMigrations(pool, journal, migrationsFolder())
  sites = await startFixtureSites()
})
afterAll(async () => {
  await pool?.end()
  await sites?.close()
  await scratch?.drop()
  for (const s of scratches) await s.drop()
  if (temp) await rm(temp, { recursive: true, force: true })
})

const scout = () =>
  createScoutHandler({
    config: readScoutConfig({
      DESKVERSE_SCOUT_RETRIEVAL: "on",
      DESKVERSE_SCOUT_HOST_INTERVAL_MS: "0",
    }),
    network: testNetwork({ port: sites.port }),
  })
const quill = (extra: Partial<Parameters<typeof createQuillHandler>[0]> = {}) =>
  createQuillHandler({ pool, config: readQuillConfig({}), ...extra })

function worker(handlers: TaskHandler[], leaseMs = 3_000) {
  return new Worker({
    pool,
    registry: createRegistry({ verification: false, production: handlers }),
    leaseMs,
    pollMs: 50,
    log: () => {},
  }).start()
}

async function settle(runId: string, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const s = (
      await pool.query("SELECT status FROM campaign_runs WHERE id = $1", [
        runId,
      ])
    ).rows[0].status
    if (
      ["completed", "completed_with_errors", "failed", "cancelled"].includes(s)
    )
      return s as string
    if (Date.now() > end) throw new Error(`run still ${s}`)
    await sleep(50)
  }
}

type Product = {
  name: string
  affiliateUrl: string
  specifications?: string
  description?: string
  references: readonly { kind: string; url: string; label: string }[]
}

async function readyTicket(products: Product[], images = 0) {
  const db = createDatabase(pool)
  const input = validateNewTicket({
    title: `Scripts ${randomUUID().slice(0, 6)}`,
    requestId: randomUUID(),
  })
  if (!input.ok) throw new Error("bad ticket")
  const ticket = (await createTicket(db, input.value)).ticket
  const ids: string[] = []
  for (const p of products)
    ids.push(
      (
        await addProduct(db, ticket.id, randomUUID(), {
          name: p.name,
          affiliateUrl: p.affiliateUrl,
          specifications: p.specifications ?? "",
          description: p.description ?? "",
          references: p.references.map((r) => ({
            kind: r.kind as "listing",
            url: r.url,
            label: r.label,
          })),
        })
      ).productId,
    )
  void images
  const version = (
    await pool.query("SELECT version FROM affiliate_tickets WHERE id = $1", [
      ticket.id,
    ])
  ).rows[0].version
  const ready = await changeStatus(db, ticket.id, version, "ready")
  return { ticketId: ticket.id, version: ready.version, productIds: ids, db }
}

const currentVersion = async (ticketId: string) =>
  (
    await pool.query("SELECT version FROM affiliate_tickets WHERE id = $1", [
      ticketId,
    ])
  ).rows[0].version as number

/** Runs Scout on the ticket; returns each product's report id. */
async function research(ticketId: string) {
  const { runId } = await planRun(pool, {
    ticketId,
    ticketVersion: await currentVersion(ticketId),
    requestId: randomUUID(),
    mode: "production",
    workflow: RESEARCH_WORKFLOW.id,
    productionAvailable: false,
    verificationAllowed: false,
    availableWorkflows: [RESEARCH_WORKFLOW.id],
  })
  const w = worker([scout()])
  await settle(runId)
  await w.stop()
  const rows = (
    await pool.query(
      "SELECT id, product_id FROM scout_reports WHERE run_id = $1",
      [runId],
    )
  ).rows
  return new Map(rows.map((r) => [r.product_id as string, r.id as string]))
}

const planQuill = async (
  ticketId: string,
  scripts: { productId: string; reportId: string }[],
  extra: Record<string, unknown> = {},
) =>
  planRun(pool, {
    ticketId,
    ticketVersion: await currentVersion(ticketId),
    requestId: randomUUID(),
    mode: "production",
    workflow: QUILL_WORKFLOW.id,
    productionAvailable: false,
    verificationAllowed: false,
    availableWorkflows: [RESEARCH_WORKFLOW.id, QUILL_WORKFLOW.id],
    scripts,
    ...extra,
  })

async function refusal(p: Promise<unknown>) {
  try {
    await p
  } catch (e) {
    return e as { code: string; message: string }
  }
  throw new Error("expected a refusal")
}

async function runHandler(
  handler: TaskHandler,
  claim: Claim,
  signal = new AbortController().signal,
): Promise<HandlerOutcome> {
  return handler.run({
    taskId: claim.taskId,
    runId: claim.runId,
    ticketId: claim.ticketId,
    stage: claim.stage,
    attempt: claim.attempt,
    maxAttempts: claim.maxAttempts,
    idempotencyKey: claim.idempotencyKey,
    snapshot: claim.snapshot,
    params: claim.params,
    signal,
  })
}

const NARROW_BUDS = {
  ...FIXTURE_PRODUCTS.buds,
  name: "Nova Buds X3",
  references: [
    { kind: "listing", url: "https://shop.example/p/nova-x3", label: "" },
  ],
}

describe("planning a scriptwriting run", () => {
  let t: Awaited<ReturnType<typeof readyTicket>>
  let reports: Map<string, string>
  beforeAll(async () => {
    t = await readyTicket([
      FIXTURE_PRODUCTS.kettle,
      FIXTURE_PRODUCTS.buds,
      FIXTURE_PRODUCTS.fan,
    ])
    reports = await research(t.ticketId)
  })

  it("plans one task per chosen product, pinned to the exact report", async () => {
    const kettle = t.productIds[0]
    const { runId } = await planQuill(t.ticketId, [
      { productId: kettle, reportId: reports.get(kettle)! },
    ])
    const tasks = (
      await pool.query(
        "SELECT t.stage, t.params, s.checksum, s.product_id FROM worker_tasks t JOIN run_product_snapshots s ON s.id = t.snapshot_id WHERE t.run_id = $1",
        [runId],
      )
    ).rows
    expect(tasks).toHaveLength(1)
    const report = (
      await pool.query(
        "SELECT id, report_version, checksum, snapshot_checksum FROM scout_reports WHERE id = $1",
        [reports.get(kettle)],
      )
    ).rows[0]
    expect(tasks[0]).toMatchObject({
      stage: "quill.script",
      product_id: kettle,
      checksum: report.snapshot_checksum,
      params: {
        reportId: report.id,
        reportVersion: report.report_version,
        reportChecksum: report.checksum,
      },
    })
    await cancelRun(pool, t.ticketId, runId, randomUUID())
  })

  it("refuses wrong reports, mixed products, missing choices and the full campaign", async () => {
    const [kettle, buds] = t.productIds
    expect(
      await refusal(
        planQuill(t.ticketId, [
          { productId: kettle, reportId: reports.get(buds)! },
        ]),
      ),
    ).toMatchObject({ code: "not-found" })
    expect(
      await refusal(
        planQuill(t.ticketId, [{ productId: kettle, reportId: randomUUID() }]),
      ),
    ).toMatchObject({ code: "not-found" })
    expect(await refusal(planQuill(t.ticketId, []))).toMatchObject({
      code: "invalid",
    })
    const other = await readyTicket([FIXTURE_PRODUCTS.kettle])
    expect(
      await refusal(
        planQuill(other.ticketId, [
          { productId: other.productIds[0], reportId: reports.get(kettle)! },
        ]),
      ),
    ).toMatchObject({ code: "not-found" })
    const campaign = await refusal(
      planQuill(t.ticketId, [], { workflow: "campaign-v1" }),
    )
    expect(campaign).toMatchObject({
      code: "unavailable",
      message: CAMPAIGN_UNAVAILABLE,
    })
    expect(campaign.message).toMatch(/Pixel \(DV-005C\), and Vera \(DV-006A\)/)
    expect(campaign.message).not.toMatch(/Quill \(DV-005B\)/)
  })

  it("is idempotent per request", async () => {
    const kettle = t.productIds[0]
    const requestId = randomUUID()
    const a = await planQuill(
      t.ticketId,
      [{ productId: kettle, reportId: reports.get(kettle)! }],
      { requestId },
    )
    const b = await planQuill(
      t.ticketId,
      [{ productId: kettle, reportId: reports.get(kettle)! }],
      { requestId },
    )
    expect(b).toEqual({ runId: a.runId, created: false })
    await cancelRun(pool, t.ticketId, a.runId, randomUUID())
  })

  it("refuses research made from older product data", async () => {
    const buds = t.productIds[1]
    await updateProduct(t.db, t.ticketId, buds, {
      description: "Changed after research.",
    })
    const v = await currentVersion(t.ticketId)
    await changeStatus(t.db, t.ticketId, v, "ready")
    const stale = await refusal(
      planQuill(t.ticketId, [
        { productId: buds, reportId: reports.get(buds)! },
      ]),
    )
    expect(stale).toMatchObject({ code: "stale-research" })
    expect(stale.message).toMatch(/changed since Scout researched it/)
    const overview = await quillOverview(pool, t.ticketId)
    const choice = overview.products.find((p) => p.productId === buds)!
      .reports[0]
    expect(choice).toMatchObject({
      current: false,
      problem: "The product changed since this research; run Scout again.",
    })
    // The unchanged product's report is still current.
    expect(overview.products[0].reports[0]).toMatchObject({
      current: true,
      integrity: "verified",
      problem: null,
    })
  })

  it("refuses a report whose checksum no longer verifies", async () => {
    const kettle = t.productIds[0]
    const report = reports.get(kettle)!
    // Simulate corruption behind the application's back (owner role only).
    await pool.query(
      "ALTER TABLE scout_claims DISABLE TRIGGER scout_claims_immutable",
    )
    await pool.query(
      "UPDATE scout_claims SET reason = reason || ' (edited)' WHERE report_id = $1 AND key = 'C1'",
      [report],
    )
    await pool.query(
      "ALTER TABLE scout_claims ENABLE TRIGGER scout_claims_immutable",
    )
    const corrupt = await refusal(
      planQuill(t.ticketId, [{ productId: kettle, reportId: report }]),
    )
    expect(corrupt).toMatchObject({ code: "invalid" })
    expect(corrupt.message).toMatch(/fails its checksum/)
  })
})

describe("writing scripts", () => {
  it("writes evidence-linked scripts per product; a product without enough facts needs input", async () => {
    const t = await readyTicket([
      FIXTURE_PRODUCTS.kettle,
      FIXTURE_PRODUCTS.buds,
      NARROW_BUDS,
    ])
    const reports = await research(t.ticketId)
    const { runId } = await planQuill(
      t.ticketId,
      t.productIds.map((p) => ({ productId: p, reportId: reports.get(p)! })),
    )
    const w = worker([quill()])
    expect(await settle(runId)).toBe("completed_with_errors")
    await w.stop()
    const overview = await quillOverview(pool, t.ticketId)
    expect(overview.latestRun!.tasks.map((x) => x.status)).toEqual([
      "completed",
      "completed",
      "needs_input",
    ])
    expect(overview.latestRun!.tasks[2].failureMessage).toMatch(
      /can be used in a script \(Quill needs 2\).*Conflicting: Battery life.*run Scout again/,
    )
    const scripts = await listRunScripts(pool, t.ticketId, runId)
    expect(scripts).toHaveLength(2)
    const kettle = (await getScript(
      pool,
      t.ticketId,
      runId,
      scripts.find((s) => s.productId === t.productIds[0])!.id,
    ))!
    expect(kettle.integrity).toBe("verified")
    expect(kettle.document).toMatchObject({
      format: "quill-script/1",
      report: { id: reports.get(t.productIds[0]) },
      generation: { mode: "template" },
    })
    const benefitClaims = kettle.document.scenes
      .filter((s) => s.kind === "benefit")
      .flatMap((s) => s.claims)
    expect(benefitClaims.length).toBeGreaterThanOrEqual(2)
    const facts = (
      await pool.query(
        "SELECT c.status, c.topic, c.time_sensitive FROM quill_scene_claims q JOIN scout_claims c ON c.report_id = q.report_id AND c.key = q.claim_key WHERE q.script_id = $1",
        [kettle.id],
      )
    ).rows
    expect(
      facts.every(
        (f) =>
          f.status === "supported" && f.topic === null && !f.time_sensitive,
      ),
    ).toBe(true)
    const result = (
      await pool.query(
        "SELECT kind, payload FROM task_results WHERE task_id = $1",
        [kettle.taskId],
      )
    ).rows[0]
    expect(result).toMatchObject({
      kind: "quill_script",
      payload: {
        scriptId: kettle.id,
        scriptVersion: 1,
        checksum: kettle.checksum,
      },
    })
    expect(JSON.stringify(result.payload).length).toBeLessThan(800)
    expect(kettle.document.pixel.renderReady).toBe(false)
    // Owner input and Scout research untouched.
    expect(
      (
        await pool.query(
          "SELECT specifications FROM ticket_products WHERE id = $1",
          [t.productIds[0]],
        )
      ).rows[0].specifications,
    ).toBe(FIXTURE_PRODUCTS.kettle.specifications)
  })

  it("keeps scripts immutable and refuses ineligible claims even from the lease holder", async () => {
    for (const [table, column] of [
      ["quill_scripts", "status"],
      ["quill_scenes", "caption"],
      ["quill_scene_claims", "statement"],
    ]) {
      await expect(
        pool.query(`UPDATE ${table} SET ${column} = ${column}`),
      ).rejects.toThrow(/immutable/)
      await expect(pool.query(`DELETE FROM ${table}`)).rejects.toThrow(
        /immutable/,
      )
    }
    const t = await readyTicket([FIXTURE_PRODUCTS.kettle])
    const reports = await research(t.ticketId)
    await planQuill(t.ticketId, [
      { productId: t.productIds[0], reportId: reports.get(t.productIds[0])! },
    ])
    const claim = (await claimTask(pool, {
      workerId: "w-guard",
      stages: ["quill.script"],
      leaseMs: 60_000,
    }))!
    const outcome = await runHandler(quill(), claim)
    if (outcome.status !== "completed" || !outcome.deliverable)
      throw new Error("expected a deliverable")
    // Compose the real script, then swap a benefit's claim for the unverified
    // warranty claim: the database itself refuses to store it.
    const verified = (await verifyScoutReport(
      pool,
      reports.get(t.productIds[0])!,
    ))!
    const { eligible, excluded } = selectFacts(verified.report)
    const doc = composeScript({
      report: verified.report,
      snapshot: claim.snapshot!,
      ticketId: t.ticketId,
      eligible,
      excluded,
      now: new Date(),
    })
    const warranty = verified.report.claims.find(
      (c) => c.statement === "Warranty: 5 years",
    )!
    const forged = {
      ...doc,
      scenes: doc.scenes.map((s) =>
        s.id === "scene-2"
          ? {
              ...s,
              claims: [
                {
                  ...s.claims[0],
                  claimKey: warranty.key,
                  statement: warranty.statement,
                },
              ],
            }
          : s,
      ),
    }
    const tampered = {
      kind: "quill_script" as const,
      persist: (
        c: pg.PoolClient,
        commit: Parameters<typeof outcome.deliverable.persist>[1],
      ) => persistScript(c, commit, forged),
    }
    await expect(
      completeTask(pool, claim, outcome.result, tampered),
    ).rejects.toThrow(/not a promotable supported claim/)
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM quill_scripts WHERE task_id = $1",
            [claim.taskId],
          )
        ).rows[0].count,
      ),
    ).toBe(0)
    expect(
      await completeTask(pool, claim, outcome.result, outcome.deliverable),
    ).toBe("committed")
  })

  it("fences stale workers, allows one commit, and rolls back a failed write", async () => {
    const t = await readyTicket([FIXTURE_PRODUCTS.kettle])
    const reports = await research(t.ticketId)
    const { runId } = await planQuill(t.ticketId, [
      { productId: t.productIds[0], reportId: reports.get(t.productIds[0])! },
    ])
    const handler = quill()
    const stale = (await claimTask(pool, {
      workerId: "w-stale",
      stages: ["quill.script"],
      leaseMs: 60_000,
    }))!
    const staleOutcome = await runHandler(handler, stale)
    await pool.query(
      "UPDATE worker_tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [stale.taskId],
    )
    expect(
      await recoverExpiredLeases(pool, {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
      }),
    ).toBe(1)
    await pool.query(
      "UPDATE worker_tasks SET eligible_at = now() WHERE id = $1",
      [stale.taskId],
    )
    const fresh = (await claimTask(pool, {
      workerId: "w-fresh",
      stages: ["quill.script"],
      leaseMs: 60_000,
    }))!
    const freshOutcome = await runHandler(handler, fresh)
    if (
      staleOutcome.status !== "completed" ||
      freshOutcome.status !== "completed"
    )
      throw new Error("expected completions")
    expect(
      await completeTask(
        pool,
        stale,
        staleOutcome.result,
        staleOutcome.deliverable,
      ),
    ).toBe("stale")
    // A crash in the middle of writing: nothing stays.
    const failing = {
      kind: freshOutcome.deliverable!.kind,
      persist: async (
        c: pg.PoolClient,
        commit: Parameters<
          NonNullable<typeof freshOutcome.deliverable>["persist"]
        >[1],
      ) => {
        await freshOutcome.deliverable!.persist(c, commit)
        throw new Error("power cut before commit")
      },
    }
    await expect(
      completeTask(pool, fresh, freshOutcome.result, failing),
    ).rejects.toThrow(/power cut/)
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM quill_scenes q JOIN quill_scripts s ON s.id = q.script_id WHERE s.task_id = $1",
            [fresh.taskId],
          )
        ).rows[0].count,
      ),
    ).toBe(0)
    const results = await Promise.all([
      completeTask(pool, fresh, freshOutcome.result, freshOutcome.deliverable),
      completeTask(pool, fresh, freshOutcome.result, freshOutcome.deliverable),
    ])
    expect(results.sort()).toEqual(["committed", "stale"])
    expect(
      (
        await pool.query(
          "SELECT fence::int AS fence FROM quill_scripts WHERE task_id = $1",
          [fresh.taskId],
        )
      ).rows,
    ).toEqual([{ fence: fresh.fence }])
    expect(await settle(runId)).toBe("completed")
    expect(
      await claimTask(pool, {
        workerId: "w",
        stages: ["quill.script"],
        leaseMs: 1_000,
      }),
    ).toBeNull()
  })

  it("versions scripts per product; earlier versions stay verified", async () => {
    const t = await readyTicket([FIXTURE_PRODUCTS.kettle])
    const reports = await research(t.ticketId)
    const pick = [
      { productId: t.productIds[0], reportId: reports.get(t.productIds[0])! },
    ]
    const ids: string[] = []
    for (let i = 0; i < 2; i++) {
      const { runId } = await planQuill(t.ticketId, pick)
      const w = worker([quill()])
      expect(await settle(runId)).toBe("completed")
      await w.stop()
      ids.push((await listRunScripts(pool, t.ticketId, runId))[0].id)
    }
    const all = (await quillOverview(pool, t.ticketId)).scripts
    expect(all.map((s) => s.scriptVersion)).toEqual([2, 1])
    for (const s of all)
      expect(
        (await getScript(pool, t.ticketId, s.runId, s.id))!.integrity,
      ).toBe("verified")
    expect(new Set(all.map((s) => s.reportId))).toEqual(
      new Set([reports.get(t.productIds[0])]),
    )
  })

  it("a manual retry keeps the originally pinned report", async () => {
    const t = await readyTicket([NARROW_BUDS])
    const reports = await research(t.ticketId)
    const { runId } = await planQuill(t.ticketId, [
      { productId: t.productIds[0], reportId: reports.get(t.productIds[0])! },
    ])
    const w = worker([quill()])
    await settle(runId)
    const task = (
      await pool.query(
        "SELECT id, status, params FROM worker_tasks WHERE run_id = $1",
        [runId],
      )
    ).rows[0]
    expect(task.status).toBe("needs_input")
    await retryTask(pool, t.ticketId, runId, task.id, randomUUID())
    await settle(runId)
    await w.stop()
    const after = (
      await pool.query(
        "SELECT status, params, attempts FROM worker_tasks WHERE id = $1",
        [task.id],
      )
    ).rows[0]
    expect(after).toMatchObject({
      status: "needs_input",
      params: task.params,
      attempts: 2,
    })
  })

  it("cancels during generation without writing a script", async () => {
    const t = await readyTicket([FIXTURE_PRODUCTS.kettle])
    const reports = await research(t.ticketId)
    const { runId } = await planQuill(t.ticketId, [
      { productId: t.productIds[0], reportId: reports.get(t.productIds[0])! },
    ])
    const w = worker([
      quill({ test: { delayMs: 10_000, crashBeforeCommit: null } }),
    ])
    for (
      let i = 0;
      i < 200 &&
      !(
        await pool.query(
          "SELECT 1 FROM worker_tasks WHERE run_id = $1 AND status = 'running'",
          [runId],
        )
      ).rowCount;
      i++
    )
      await sleep(25)
    await cancelRun(pool, t.ticketId, runId, randomUUID())
    expect(await settle(runId, 20_000)).toBe("cancelled")
    await w.stop()
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM quill_scripts WHERE run_id = $1",
            [runId],
          )
        ).rows[0].count,
      ),
    ).toBe(0)
  })

  it("loses the lease during local-model inference and commits nothing", async () => {
    const t = await readyTicket([FIXTURE_PRODUCTS.kettle])
    const reports = await research(t.ticketId)
    const { runId } = await planQuill(t.ticketId, [
      { productId: t.productIds[0], reportId: reports.get(t.productIds[0])! },
    ])
    let chatStarted = false
    const hangingModel: FetchLike = async (url, init) => {
      if (url.endsWith("/api/version"))
        return Response.json({ version: "0.12.0" })
      if (url.endsWith("/api/tags"))
        return Response.json({
          models: [{ name: "test-model", digest: "sha256:x" }],
        })
      chatStarted = true
      return new Promise<Response>((_, reject) =>
        init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      )
    }
    const handler = quill({
      config: readQuillConfig({
        DESKVERSE_QUILL_GENERATION: "ollama",
        DESKVERSE_QUILL_OLLAMA_URL: "http://127.0.0.1:11434",
        DESKVERSE_QUILL_OLLAMA_MODEL: "test-model",
      }),
      ollamaFetch: hangingModel,
    })
    const w = worker([handler], 1_500)
    for (let i = 0; i < 200 && !chatStarted; i++) await sleep(25)
    expect(chatStarted).toBe(true)
    // Another party takes the lease away (e.g. after a pause in this process).
    await pool.query(
      "UPDATE worker_tasks SET fence = fence + 1, lease_owner = 'someone-else' WHERE run_id = $1 AND status = 'running'",
      [runId],
    )
    await sleep(1_500)
    await w.stop()
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM quill_scripts WHERE run_id = $1",
            [runId],
          )
        ).rows[0].count,
      ),
    ).toBe(0)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM task_attempts a JOIN worker_tasks t ON t.id = a.task_id WHERE t.run_id = $1 AND a.outcome = 'succeeded'",
          [runId],
        )
      ).rows[0].n,
    ).toBe(0)
  })
})

describe("backup and restore", () => {
  it(
    "restores scripts with their versions, checksums and research links",
    { timeout: 120_000 },
    async () => {
      temp = await mkdtemp(path.join(os.tmpdir(), "deskverse-backup-quill-"))
      const source = await createScratchDatabase("bkqlsrc")
      const target = await createScratchDatabase("bkqldst")
      scratches.push(source, target)
      const original = pool
      pool = createPool(source.config, { max: 8 })
      try {
        await runMigrations(pool, journal, migrationsFolder())
        const t = await readyTicket([FIXTURE_PRODUCTS.kettle])
        const reports = await research(t.ticketId)
        const { runId } = await planQuill(t.ticketId, [
          {
            productId: t.productIds[0],
            reportId: reports.get(t.productIds[0])!,
          },
        ])
        const w = worker([quill()])
        await settle(runId)
        await w.stop()
        const before = (await getScript(
          pool,
          t.ticketId,
          runId,
          (await listRunScripts(pool, t.ticketId, runId))[0].id,
        ))!
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
        expect(manifest.database.migrations.current).toBe("0004_quill_scripts")
        expect(manifest.database.tables).toMatchObject({
          quill_scripts: 1,
          scout_reports: 1,
        })
        await restoreBackup({
          dir,
          target: target.config,
          dataRoot: path.join(temp, "restored"),
          journal,
        })
        pool = createPool(target.config, { max: 4 })
        const after = (await getScript(pool, t.ticketId, runId, before.id))!
        expect(after.integrity).toBe("verified")
        expect(after.checksum).toBe(before.checksum)
        expect(after.scriptVersion).toBe(before.scriptVersion)
        expect(after.document).toEqual(before.document)
        const link = (
          await pool.query(
            "SELECT r.id, r.checksum FROM quill_scripts q JOIN scout_reports r ON r.id = q.report_id WHERE q.id = $1",
            [before.id],
          )
        ).rows[0]
        expect(link).toEqual({
          id: before.document.report.id,
          checksum: before.document.report.checksum,
        })
        await expect(pool.query("DELETE FROM quill_scripts")).rejects.toThrow(
          /immutable/,
        )
      } finally {
        await pool.end()
        pool = original
      }
    },
  )

  it(
    "restores a DV-005A-era backup (schema 0003) and writes a script from its research",
    { timeout: 120_000 },
    async () => {
      const { cp, readFile, writeFile } = await import("node:fs/promises")
      temp ||= await mkdtemp(path.join(os.tmpdir(), "deskverse-backup-quill-"))
      const source = await createScratchDatabase("bk5asrc")
      const target = await createScratchDatabase("bk5adst")
      scratches.push(source, target)
      const folder = path.join(temp, "migrations-0003")
      await cp(migrationsFolder(), folder, { recursive: true })
      const meta = JSON.parse(
        await readFile(path.join(folder, "meta", "_journal.json"), "utf8"),
      )
      meta.entries = meta.entries.filter((e: { tag: string }) => e.tag < "0004")
      await writeFile(
        path.join(folder, "meta", "_journal.json"),
        JSON.stringify(meta),
      )
      const v5a = { entries: journal.entries.filter((e) => e.tag < "0004") }
      const original = pool
      pool = createPool(source.config, { max: 8 })
      try {
        await runMigrations(pool, v5a, folder)
        const t = await readyTicket([FIXTURE_PRODUCTS.kettle])
        const reports = await research(t.ticketId)
        const reportId = reports.get(t.productIds[0])!
        await pool.end()
        const { dir } = await createBackup({
          db: source.config,
          journal: v5a,
          dataRoot: path.join(temp, "data-5a"),
          backupsRoot: path.join(temp, "backups-5a"),
          projectRoot: process.cwd(),
          deskverseVersion: "test",
          checkProcesses: false,
        })
        const result = await restoreBackup({
          dir,
          target: target.config,
          dataRoot: path.join(temp, "restored-5a"),
          journal,
        })
        expect(result.migration).toBe("0003_scout_research")
        pool = createPool(target.config, { max: 8 })
        expect(await runMigrations(pool, journal, migrationsFolder())).toEqual([
          "0004_quill_scripts",
        ])
        expect((await verifyScoutReport(pool, reportId))?.intact).toBe(true)
        const { runId } = await planQuill(t.ticketId, [
          { productId: t.productIds[0], reportId },
        ])
        const w = worker([quill()])
        expect(await settle(runId)).toBe("completed")
        await w.stop()
        expect(
          (await listRunScripts(pool, t.ticketId, runId))[0],
        ).toMatchObject({ reportId, scriptVersion: 1 })
      } finally {
        await pool.end()
        pool = original
      }
    },
  )
})
