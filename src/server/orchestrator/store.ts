import type pg from "pg"

import {
  canonicalJson,
  sha256,
  type Queryable,
} from "@/server/orchestrator/canonical"

import {
  ACTIVE_RUN_STATUSES,
  afterFailure,
  backoffMs,
  canRunTransition,
  DEFAULT_RETRY_POLICY,
  MAX_ATTEMPTS_LIMIT,
  settledRunStatus,
  type FailureKind,
  type RetryPolicy,
  type RunStatus,
  type TaskStatus,
} from "@/lib/orchestrator/model"
import type {
  ResourceClass,
  RunDetail,
  RunMode,
  RunSummary,
} from "@/lib/orchestrator/types"
import {
  MISSING_PRODUCTION_CAPABILITIES,
  PRODUCTION_WORKFLOW,
  QUILL_WORKFLOW,
  RESEARCH_WORKFLOW,
  stageLabel,
  VERIFICATION_WORKFLOW,
  WORKFLOWS,
  workflowById,
  type CommitContext,
  type ResultKind,
  type WorkflowDefinition,
} from "@/server/orchestrator/workflows"
import { sameDestination } from "@/server/scout/net/url"
import { verifyScoutReport } from "@/server/scout/store"

/**
 * Durable orchestration state in PostgreSQL (DV-004C).
 *
 * Locking: every mutation of a run or its tasks first locks the run row
 * (`SELECT … FOR UPDATE`), then touches tasks, so the lock order is always
 * run → task and concurrent workers/controls can't deadlock. Claims are
 * additionally serialised by one transaction-scoped advisory lock, so
 * capacity counts per resource class are exact across processes.
 *
 * Leases and fencing: a claim increments the task's `fence` and records
 * (lease_owner, fence, lease_expires_at). Heartbeats and every finalisation
 * are compare-and-swap updates on exactly that triple, so a worker whose
 * lease expired, or whose task was cancelled or re-claimed, can't commit.
 * Execution is at-least-once; committed results are effectively once
 * (task_results is keyed by task).
 */

export class OrchestratorError extends Error {
  constructor(
    readonly code:
      | "not-found"
      | "not-ready"
      | "stale-version"
      | "active-run"
      | "invalid-transition"
      | "unavailable"
      | "invalid"
      | "stale-research"
      | "limit",
    message: string,
  ) {
    super(message)
    this.name = "OrchestratorError"
  }
}

type Client = pg.PoolClient

export async function transaction<T>(
  pool: pg.Pool,
  work: (c: Client) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await work(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

const ACTIVE_RUNS = ACTIVE_RUN_STATUSES as readonly string[]
const UNSUCCESSFUL = ["failed", "needs_input", "blocked", "cancelled"]

export { canonicalJson }

async function event(
  c: Client,
  runId: string,
  type: string,
  details: Record<string, unknown> = {},
  taskId: string | null = null,
  requestId: string | null = null,
) {
  await c.query(
    "INSERT INTO run_events (run_id, task_id, type, details, request_id) VALUES ($1, $2, $3, $4, $5)",
    [runId, taskId, type, details, requestId],
  )
}

async function lockRun(c: Client, runId: string) {
  const { rows } = await c.query<{
    id: string
    ticket_id: string
    status: RunStatus
    started_at: Date | null
  }>(
    "SELECT id, ticket_id, status, started_at FROM campaign_runs WHERE id = $1 FOR UPDATE",
    [runId],
  )
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface VerificationOptions {
  /** Per-step duration (ms), 0–60 000. */
  durationMs?: number
  /** Deterministic faults by product position (0-based) and stage. */
  faults?: {
    product: number
    stage: string
    kind: "transient" | "permanent" | "needs_input"
    times?: number
  }[]
}

export interface PlanInput {
  ticketId: string
  ticketVersion: number
  requestId: string
  mode: RunMode
  /**
   * The task graph to use (DV-005A). Defaults: verification →
   * "verification-v1"; production → "campaign-v1" (the full campaign).
   */
  workflow?: string
  /** The full campaign needs every stage's production handler. */
  productionAvailable: boolean
  /** Verification runs are only allowed in an isolated test environment. */
  verificationAllowed: boolean
  /** Other production workflows that can run here (e.g. "scout-research-v1"). */
  availableWorkflows?: readonly string[]
  /** Quill (DV-005B): the Scout report to write each product's script from. */
  scripts?: readonly { productId: string; reportId: string }[]
  /**
   * Workflow-specific planning (DV-005C, Pixel): runs inside the planning
   * transaction with the products' current frozen inputs; returns the task
   * params per selected product (others get no task) or throws an
   * OrchestratorError to refuse the whole run.
   */
  prepare?: (
    c: pg.PoolClient,
    snapshots: Awaited<ReturnType<typeof currentProductSnapshots>>["snapshots"],
  ) => Promise<Map<string, Record<string, unknown>>>
  /** Called for each created task, in the same transaction (e.g. to pin a render manifest). */
  onTask?: (
    c: pg.PoolClient,
    task: {
      taskId: string
      runId: string
      snapshotId: string
      productId: string
      params: Record<string, unknown>
    },
  ) => Promise<void>
  verification?: VerificationOptions
  retry?: Partial<RetryPolicy>
}

/**
 * Creates a run atomically: run, frozen product snapshots, tasks and
 * dependencies, in one transaction under the ticket's row lock (the same
 * lock DV-004B's edits take), so the snapshot matches `ticketVersion`
 * exactly. A repeated requestId returns the original run.
 */
const NAMES: Record<string, string> = {
  "pixel.render": "Pixel",
  "vera.review": "Vera",
}

const missingNames = MISSING_PRODUCTION_CAPABILITIES.map(
  (c) => `${NAMES[c.stage] ?? c.stage} (${c.milestone.split(" ")[0]})`,
)

export const CAMPAIGN_UNAVAILABLE = `Full campaign automation isn't available yet: ${
  missingNames.length === 1
    ? `${missingNames[0]} isn't built`
    : `${missingNames.slice(0, -1).join(", ")}, and ${missingNames.at(-1)} aren't built`
}. Nothing was started. Research-only (Scout), scriptwriting-only (Quill) and video-only (Pixel) runs are available separately.`

export const RESEARCH_UNAVAILABLE =
  "Scout research isn't switched on: source retrieval is off. Set DESKVERSE_SCOUT_RETRIEVAL=on in .env.local, restart the app and the worker, then try again. Nothing was started."

/** Picks and validates the run's workflow (explicit, never implied by the handlers present). */
function selectWorkflow(input: PlanInput): WorkflowDefinition {
  const id =
    input.workflow ??
    (input.mode === "verification"
      ? VERIFICATION_WORKFLOW.id
      : PRODUCTION_WORKFLOW.id)
  const workflow = workflowById(id)
  if (!workflow || workflow.mode !== input.mode)
    throw new OrchestratorError(
      "invalid",
      `There's no ${input.mode} workflow called “${id.slice(0, 40)}”.`,
    )
  if (workflow.mode === "verification" && !input.verificationAllowed)
    throw new OrchestratorError(
      "unavailable",
      "Verification runs only run in the isolated test environment (yarn orchestrator:verify, yarn test:e2e:db).",
    )
  if (workflow.id === PRODUCTION_WORKFLOW.id && !input.productionAvailable)
    throw new OrchestratorError("unavailable", CAMPAIGN_UNAVAILABLE)
  if (
    workflow.mode === "production" &&
    workflow.id !== PRODUCTION_WORKFLOW.id &&
    !(input.availableWorkflows ?? []).includes(workflow.id)
  )
    throw new OrchestratorError(
      "unavailable",
      workflow.id === RESEARCH_WORKFLOW.id
        ? RESEARCH_UNAVAILABLE
        : `${workflow.title} isn't available here. Nothing was started.`,
    )
  return workflow
}

interface SnapshotProduct extends Record<string, unknown> {
  id: string
  position: number
}

/**
 * The frozen input each product WOULD get if a run started now: the same
 * data and checksum planRun stores. Used by planRun and to tell whether a
 * Scout report still matches the current product (DV-005B).
 */
export async function currentProductSnapshots(c: Queryable, ticketId: string) {
  const ticket = (
    await c.query(
      "SELECT id, number, title, platform, priority, instructions, publishing_preferences FROM affiliate_tickets WHERE id = $1",
      [ticketId],
    )
  ).rows[0]
  const products: SnapshotProduct[] = (
    await c.query(
      "SELECT id, position, name, affiliate_url, description, specifications, notes, source, media_rights, media_rights_note FROM ticket_products WHERE ticket_id = $1 ORDER BY position",
      [ticketId],
    )
  ).rows
  const references: {
    product_id: string
    kind: string
    url: string
    label: string
  }[] = (
    await c.query(
      "SELECT product_id, kind, url, label FROM ticket_references WHERE ticket_id = $1 ORDER BY position",
      [ticketId],
    )
  ).rows
  const assets = (
    await c.query(
      "SELECT id, product_id, kind, mime_type, extension, byte_size, sha256, width, height, duration_ms FROM ticket_assets WHERE ticket_id = $1 ORDER BY position, created_at",
      [ticketId],
    )
  ).rows
  if (!ticket) return { snapshots: [], products, references }
  const campaign = {
    id: ticket.id,
    number: ticket.number,
    title: ticket.title,
    platform: ticket.platform,
    priority: ticket.priority,
    instructions: ticket.instructions,
    publishingPreferences: ticket.publishing_preferences,
  }
  const snapshots = products.map((product) => {
    const data = {
      schemaVersion: 1,
      ticket: campaign,
      product: {
        id: product.id,
        position: product.position,
        name: product.name,
        affiliateUrl: product.affiliate_url,
        description: product.description,
        specifications: product.specifications,
        notes: product.notes,
        source: product.source,
        mediaRights: product.media_rights,
        mediaRightsNote: product.media_rights_note,
        references: references
          .filter((r) => r.product_id === product.id)
          .map(({ kind, url, label }) => ({ kind, url, label })),
        assets: assets
          .filter((a) => a.product_id === product.id)
          .map((a) => ({
            id: a.id,
            kind: a.kind,
            mimeType: a.mime_type,
            extension: a.extension,
            byteSize: Number(a.byte_size),
            sha256: a.sha256,
            width: a.width,
            height: a.height,
            durationMs: a.duration_ms,
          })),
      },
    }
    return { product, data, checksum: sha256(canonicalJson(data)) }
  })
  return { snapshots, products, references }
}

/** What a Quill task pins: the exact Scout report it must write from. */
export interface ReportPin extends Record<string, unknown> {
  reportId: string
  reportVersion: number
  reportChecksum: string
}

/**
 * Validates the owner's report choices for a Quill run (DV-005B): one per
 * product, the report belongs to this ticket and product, its checksum
 * still verifies, and the product hasn't changed since Scout researched it
 * (the frozen snapshot would be identical). Anything else is refused with
 * the reason; nothing is mixed across versions.
 */
async function pinScoutReports(
  c: Client,
  input: PlanInput,
  snapshots: Awaited<ReturnType<typeof currentProductSnapshots>>["snapshots"],
) {
  const selections = input.scripts ?? []
  if (selections.length === 0)
    throw new OrchestratorError(
      "invalid",
      "Choose a Scout research report for at least one product.",
    )
  const pins = new Map<string, ReportPin>()
  for (const s of selections) {
    const target = snapshots.find((x) => x.product.id === s.productId)
    if (!target)
      throw new OrchestratorError(
        "not-found",
        "One of the chosen products isn't part of this ticket.",
      )
    if (pins.has(s.productId))
      throw new OrchestratorError("invalid", "Choose one report per product.")
    const name =
      String(target.product.name ?? "") ||
      `Product #${target.product.position + 1}`
    const verified = await verifyScoutReport(c, s.reportId)
    if (
      !verified ||
      verified.ticketId !== input.ticketId ||
      verified.productId !== s.productId
    )
      throw new OrchestratorError(
        "not-found",
        `That research report isn't one of “${name}”'s reports.`,
      )
    if (!verified.intact)
      throw new OrchestratorError(
        "invalid",
        `“${name}”'s research report fails its checksum check, so Quill won't write from it. Run Scout again.`,
      )
    if (verified.snapshotChecksum !== target.checksum)
      throw new OrchestratorError(
        "stale-research",
        `“${name}” has changed since Scout researched it (version ${verified.reportVersion}). Run Scout again on the current product, then write the script from the new report.`,
      )
    pins.set(s.productId, {
      reportId: verified.reportId,
      reportVersion: verified.reportVersion,
      reportChecksum: verified.checksum,
    })
  }
  return pins
}

export async function planRun(
  pool: pg.Pool,
  input: PlanInput,
): Promise<{ runId: string; created: boolean }> {
  const workflow = selectWorkflow(input)
  const maxAttempts = Math.min(
    Math.max(input.retry?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts, 1),
    MAX_ATTEMPTS_LIMIT,
  )

  return transaction(pool, async (c) => {
    const ticket = (
      await c.query<{
        id: string
        status: string
        version: number
        number: number
        title: string
        platform: string
        priority: string
        instructions: string
        publishing_preferences: unknown
      }>(
        "SELECT id, status, version, number, title, platform, priority, instructions, publishing_preferences FROM affiliate_tickets WHERE id = $1 FOR UPDATE",
        [input.ticketId],
      )
    ).rows[0]
    const existing = (
      await c.query<{ id: string; ticket_id: string }>(
        "SELECT id, ticket_id FROM campaign_runs WHERE request_id = $1",
        [input.requestId],
      )
    ).rows[0]
    if (existing) {
      if (existing.ticket_id !== input.ticketId)
        throw new OrchestratorError(
          "invalid-transition",
          "That request was already used for another ticket.",
        )
      return { runId: existing.id, created: false }
    }
    if (!ticket)
      throw new OrchestratorError(
        "not-found",
        "That Affiliate Ticket doesn't exist.",
      )
    if (ticket.version !== input.ticketVersion)
      throw new OrchestratorError(
        "stale-version",
        "The ticket changed since this page loaded. Reload it, then start again.",
      )
    if (ticket.status !== "ready")
      throw new OrchestratorError(
        "not-ready",
        "Only a Ready ticket can be processed. Mark it Ready first.",
      )
    const active = await c.query(
      "SELECT 1 FROM campaign_runs WHERE ticket_id = $1 AND status = ANY($2)",
      [input.ticketId, ACTIVE_RUNS],
    )
    if (active.rowCount)
      throw new OrchestratorError(
        "active-run",
        "This ticket already has an unfinished run. Wait for it, or cancel it first.",
      )

    const { snapshots, products, references } = await currentProductSnapshots(
      c,
      input.ticketId,
    )
    if (products.length === 0)
      throw new OrchestratorError("not-ready", "The ticket has no products.")
    if (workflow.id === RESEARCH_WORKFLOW.id) {
      const researchable = products.filter(
        (p) =>
          String(p.name ?? "").trim() !== "" &&
          references.some(
            (r) =>
              r.product_id === p.id &&
              !sameDestination(r.url, String(p.affiliate_url ?? "")),
          ),
      )
      if (researchable.length === 0)
        throw new OrchestratorError(
          "not-ready",
          "None of the products has a research reference besides its affiliate link. Add a public product page (the manufacturer's is best) to at least one product, mark the ticket Ready, then start research.",
        )
    }

    const run = (
      await c.query<{ id: string }>(
        "INSERT INTO campaign_runs (ticket_id, ticket_version, request_id, mode, workflow, status) VALUES ($1, $2, $3, $4, $5, 'queued') RETURNING id",
        [
          input.ticketId,
          ticket.version,
          input.requestId,
          input.mode,
          workflow.id,
        ],
      )
    ).rows[0]

    // Quill (DV-005B): only the selected products, each pinned to a verified,
    // still-current Scout report.
    const pins: Map<string, Record<string, unknown>> | null =
      workflow.id === QUILL_WORKFLOW.id
        ? await pinScoutReports(c, input, snapshots)
        : input.prepare
          ? await input.prepare(c, snapshots)
          : null
    if (pins && pins.size === 0)
      throw new OrchestratorError("invalid", "Choose at least one product.")
    let taskCount = 0
    for (const { product, data, checksum } of snapshots) {
      const pin = pins?.get(product.id)
      if (pins && !pin) continue
      const snapshot = (
        await c.query<{ id: string }>(
          "INSERT INTO run_product_snapshots (run_id, ticket_id, product_id, position, schema_version, data, checksum) VALUES ($1, $2, $3, $4, 1, $5, $6) RETURNING id",
          [
            run.id,
            input.ticketId,
            product.id,
            product.position,
            data,
            checksum,
          ],
        )
      ).rows[0]

      const ids = new Map<string, string>()
      for (const stage of workflow.stages) {
        const fault = input.verification?.faults?.find(
          (f) => f.product === product.position && f.stage === stage.stage,
        )
        const params: Record<string, unknown> =
          workflow.mode === "verification"
            ? { durationMs: input.verification?.durationMs ?? 200 }
            : pin
              ? { ...pin }
              : {}
        if (fault && workflow.mode === "verification")
          params.fail = { kind: fault.kind, times: fault.times ?? 1 }
        const task = (
          await c.query<{ id: string }>(
            `INSERT INTO worker_tasks (run_id, ticket_id, snapshot_id, stage, status, resource_class, recovery_policy, idempotency_key, params, max_attempts)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
            [
              run.id,
              input.ticketId,
              snapshot.id,
              stage.stage,
              stage.dependsOn.length === 0 ? "queued" : "waiting_dependencies",
              stage.resourceClass,
              stage.recovery,
              `${run.id}:${product.id}:${stage.stage}`,
              params,
              maxAttempts,
            ],
          )
        ).rows[0]
        ids.set(stage.stage, task.id)
        taskCount++
        await input.onTask?.(c, {
          taskId: task.id,
          runId: run.id,
          snapshotId: snapshot.id,
          productId: product.id,
          params,
        })
        for (const dep of stage.dependsOn)
          await c.query(
            "INSERT INTO task_dependencies (run_id, task_id, depends_on_task_id) VALUES ($1, $2, $3)",
            [run.id, task.id, ids.get(dep)],
          )
      }
    }
    await refreshRun(c, run.id)
    await event(
      c,
      run.id,
      "run_created",
      {
        mode: input.mode,
        workflow: workflow.id,
        products: pins ? pins.size : products.length,
        tasks: taskCount,
        ticketVersion: ticket.version,
      },
      null,
      input.requestId,
    )
    return { runId: run.id, created: true }
  })
}

// ---------------------------------------------------------------------------
// Run bookkeeping
// ---------------------------------------------------------------------------

async function taskCounts(c: Client, runId: string) {
  const { rows } = await c.query<{ status: TaskStatus; n: number }>(
    "SELECT status, count(*)::int AS n FROM worker_tasks WHERE run_id = $1 GROUP BY status",
    [runId],
  )
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<
    Record<TaskStatus, number>
  >
}

/** Refreshes counts and settles the run's state once nothing is running. Run row must be locked. */
async function refreshRun(c: Client, runId: string) {
  const run = (
    await c.query<{ status: RunStatus }>(
      "SELECT status FROM campaign_runs WHERE id = $1",
      [runId],
    )
  ).rows[0]
  const counts = await taskCounts(c, runId)
  const settled = settledRunStatus(run.status, counts)
  if (
    settled &&
    settled !== run.status &&
    canRunTransition(run.status, settled)
  ) {
    const finished = !ACTIVE_RUNS.includes(settled)
    const unsuccessful = UNSUCCESSFUL.reduce(
      (n, s) => n + (counts[s as TaskStatus] ?? 0),
      0,
    )
    const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0)
    const error =
      settled === "completed_with_errors" || settled === "failed"
        ? `${unsuccessful} of ${total} tasks didn't complete.`
        : null
    await c.query(
      "UPDATE campaign_runs SET status = $2, summary = $3, error = $4, finished_at = CASE WHEN $5 THEN now() ELSE NULL END, updated_at = now() WHERE id = $1",
      [runId, settled, counts, error, finished],
    )
    await event(
      c,
      runId,
      settled === "paused"
        ? "run_paused"
        : settled === "cancelled"
          ? "run_cancelled"
          : "run_finished",
      { status: settled, counts },
    )
  } else {
    await c.query(
      "UPDATE campaign_runs SET summary = $2, updated_at = now() WHERE id = $1",
      [runId, counts],
    )
  }
}

/** Promotes waiting tasks whose prerequisites have all completed. */
async function promoteDependents(c: Client, taskId: string) {
  await c.query(
    `UPDATE worker_tasks t SET status = 'queued', eligible_at = now(), updated_at = now()
      WHERE t.status = 'waiting_dependencies'
        AND t.id IN (SELECT task_id FROM task_dependencies WHERE depends_on_task_id = $1)
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies d JOIN worker_tasks p ON p.id = d.depends_on_task_id
           WHERE d.task_id = t.id AND p.status <> 'completed')`,
    [taskId],
  )
}

/** Blocks every waiting descendant of a task that ended without success. */
async function blockDescendants(c: Client, runId: string, taskId: string) {
  const { rows } = await c.query<{ id: string }>(
    `WITH RECURSIVE downstream(id) AS (
       SELECT task_id FROM task_dependencies WHERE depends_on_task_id = $1
       UNION SELECT d.task_id FROM task_dependencies d JOIN downstream x ON d.depends_on_task_id = x.id)
     UPDATE worker_tasks t SET status = 'blocked', failure_kind = 'blocked',
            failure_message = 'An earlier step for this product didn''t succeed.', updated_at = now()
      WHERE t.id IN (SELECT id FROM downstream) AND t.status = 'waiting_dependencies'
      RETURNING t.id`,
    [taskId],
  )
  for (const row of rows) await event(c, runId, "task_blocked", {}, row.id)
}

/** Unblocks blocked tasks whose prerequisites are no longer unsuccessful (after a manual retry). */
async function unblock(c: Client, runId: string) {
  for (;;) {
    const { rows } = await c.query<{ id: string }>(
      `UPDATE worker_tasks t SET status = 'waiting_dependencies', failure_kind = NULL, failure_message = NULL, updated_at = now()
        WHERE t.run_id = $1 AND t.status = 'blocked'
          AND NOT EXISTS (
            SELECT 1 FROM task_dependencies d JOIN worker_tasks p ON p.id = d.depends_on_task_id
             WHERE d.task_id = t.id AND p.status = ANY($2))
        RETURNING t.id`,
      [runId, UNSUCCESSFUL],
    )
    if (rows.length === 0) return
    for (const row of rows) await event(c, runId, "task_unblocked", {}, row.id)
  }
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/** Global capacity per resource class (across all worker processes). */
export interface ResourceLimits {
  general: number
  cpu: number
  /** Always 1: one render-class task at a time. */
  render: 1
  /** Running tasks per product at once (fairness). */
  perProduct: number
}

export const DEFAULT_LIMITS: ResourceLimits = {
  general: 3,
  cpu: 2,
  render: 1,
  perProduct: 1,
}

const CLAIM_LOCK = "8104732217011004" // advisory lock key: claims are serialised

export interface Claim {
  taskId: string
  runId: string
  ticketId: string
  stage: string
  resourceClass: ResourceClass
  attempt: number
  maxAttempts: number
  fence: number
  workerId: string
  leaseMs: number
  idempotencyKey: string
  params: Record<string, unknown>
  snapshot: { checksum: string; data: Record<string, unknown> } | null
}

/**
 * Atomically claims the oldest eligible task this worker can run, or null.
 * In one transaction it checks: the run is claimable (queued/running), the
 * task is queued (or its retry delay has passed), every prerequisite
 * completed, the class has capacity, the product isn't already busy, and
 * no other transaction holds the row (SKIP LOCKED).
 */
export async function claimTask(
  pool: pg.Pool,
  opts: {
    workerId: string
    stages: readonly string[]
    leaseMs: number
    limits?: ResourceLimits
  },
): Promise<Claim | null> {
  const limits = opts.limits ?? DEFAULT_LIMITS
  if (opts.stages.length === 0) return null
  return transaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock($1::bigint)", [CLAIM_LOCK])
    const running = Object.fromEntries(
      (
        await c.query<{ resource_class: ResourceClass; n: number }>(
          "SELECT resource_class, count(*)::int AS n FROM worker_tasks WHERE status = 'running' GROUP BY resource_class",
        )
      ).rows.map((r) => [r.resource_class, r.n]),
    ) as Partial<Record<ResourceClass, number>>
    const open = (["general", "cpu", "render"] as const).filter(
      (cls) =>
        (running[cls] ?? 0) <
        Math.min(limits[cls], cls === "render" ? 1 : limits[cls]),
    )
    if (open.length === 0) return null
    const candidate = (
      await c.query<{ id: string; run_id: string }>(
        `SELECT t.id, t.run_id FROM worker_tasks t JOIN campaign_runs r ON r.id = t.run_id
          WHERE t.status IN ('queued', 'retry_wait') AND t.eligible_at <= now()
            AND t.resource_class = ANY($1) AND t.stage = ANY($2)
            AND r.status IN ('queued', 'running')
            AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN worker_tasks p ON p.id = d.depends_on_task_id
                             WHERE d.task_id = t.id AND p.status <> 'completed')
            AND (t.snapshot_id IS NULL OR (SELECT count(*) FROM worker_tasks x WHERE x.snapshot_id = t.snapshot_id AND x.status = 'running') < $3)
          ORDER BY t.priority DESC, t.eligible_at, t.created_at
          LIMIT 1`,
        [open, opts.stages, limits.perProduct],
      )
    ).rows[0]
    if (!candidate) return null
    const run = await lockRun(c, candidate.run_id)
    if (!run || !["queued", "running"].includes(run.status)) return null
    const claimed = (
      await c.query(
        `UPDATE worker_tasks SET status = 'running', attempts = attempts + 1, fence = fence + 1,
                lease_owner = $2, lease_expires_at = clock_timestamp() + ($3::int * interval '1 millisecond'),
                started_at = coalesce(started_at, now()), failure_kind = NULL, failure_message = NULL, updated_at = now()
          WHERE id = $1 AND status IN ('queued', 'retry_wait') AND eligible_at <= now()
          RETURNING id, run_id, ticket_id, stage, resource_class, attempts, max_attempts, fence, idempotency_key, params, snapshot_id`,
        [candidate.id, opts.workerId, opts.leaseMs],
      )
    ).rows[0]
    if (!claimed) return null
    const number = (
      await c.query<{ n: number }>(
        "SELECT coalesce(max(attempt_number), 0) + 1 AS n FROM task_attempts WHERE task_id = $1",
        [claimed.id],
      )
    ).rows[0].n
    await c.query(
      "INSERT INTO task_attempts (task_id, attempt_number, worker_id, fence, started_at) VALUES ($1, $2, $3, $4, clock_timestamp())",
      [claimed.id, number, opts.workerId, claimed.fence],
    )
    if (run.status === "queued") {
      await c.query(
        "UPDATE campaign_runs SET status = 'running', started_at = coalesce(started_at, now()), updated_at = now() WHERE id = $1",
        [run.id],
      )
      await event(c, run.id, "run_started")
    }
    await event(
      c,
      run.id,
      "task_claimed",
      { attempt: claimed.attempts, fence: Number(claimed.fence) },
      claimed.id,
    )
    await refreshRun(c, run.id)
    const snapshot = claimed.snapshot_id
      ? (
          await c.query<{ checksum: string; data: Record<string, unknown> }>(
            "SELECT checksum, data FROM run_product_snapshots WHERE id = $1",
            [claimed.snapshot_id],
          )
        ).rows[0]
      : null
    return {
      taskId: claimed.id,
      runId: claimed.run_id,
      ticketId: claimed.ticket_id,
      stage: claimed.stage,
      resourceClass: claimed.resource_class,
      attempt: claimed.attempts,
      maxAttempts: claimed.max_attempts,
      fence: Number(claimed.fence),
      workerId: opts.workerId,
      leaseMs: opts.leaseMs,
      idempotencyKey: claimed.idempotency_key,
      params: claimed.params,
      snapshot,
    }
  })
}

/** Extends the lease. Null if the lease is lost (expired, re-claimed or cancelled). */
export async function renewLease(
  pool: pg.Pool,
  claim: Claim,
): Promise<{ runStatus: RunStatus } | null> {
  const { rows } = await pool.query<{ run_status: RunStatus }>(
    `UPDATE worker_tasks t SET lease_expires_at = clock_timestamp() + ($4::int * interval '1 millisecond'), updated_at = now()
      WHERE t.id = $1 AND t.fence = $2 AND t.lease_owner = $3 AND t.status = 'running' AND t.lease_expires_at > clock_timestamp()
      RETURNING (SELECT status FROM campaign_runs r WHERE r.id = t.run_id) AS run_status`,
    [claim.taskId, claim.fence, claim.workerId, claim.leaseMs],
  )
  return rows[0] ? { runStatus: rows[0].run_status } : null
}

// ---------------------------------------------------------------------------
// Finalising (all compare-and-swap on the claim's lease and fence)
// ---------------------------------------------------------------------------

export type CommitOutcome = "committed" | "stale" | "cancelled"

const OWN_LEASE =
  "id = $1 AND fence = $2 AND lease_owner = $3 AND status = 'running'"

async function finishAttempt(
  c: Client,
  claim: Claim,
  outcome: string,
  message: string | null = null,
) {
  await c.query(
    `UPDATE task_attempts SET outcome = $3, failure_message = $4, finished_at = clock_timestamp(),
            duration_ms = (extract(epoch FROM clock_timestamp() - started_at) * 1000)::int
      WHERE task_id = $1 AND fence = $2 AND outcome = 'running'`,
    [claim.taskId, claim.fence, outcome, message],
  )
}

/** Shared prologue: lock the run, check the lease, handle cancellation. */
async function withOwnLease(
  c: Client,
  claim: Claim,
  work: (run: { status: RunStatus }) => Promise<void>,
): Promise<CommitOutcome> {
  const run = await lockRun(c, claim.runId)
  const owned = await c.query(
    `SELECT 1 FROM worker_tasks WHERE ${OWN_LEASE} AND lease_expires_at > clock_timestamp() FOR UPDATE`,
    [claim.taskId, claim.fence, claim.workerId],
  )
  if (!owned.rowCount || !run) {
    await event(
      c,
      claim.runId,
      "task_stale_result_refused",
      { fence: claim.fence },
      claim.taskId,
    )
    return "stale"
  }
  if (run.status === "cancelling" || run.status === "cancelled") {
    await markCancelled(c, claim)
    return "cancelled"
  }
  await work(run)
  await refreshRun(c, claim.runId)
  return "committed"
}

async function markCancelled(c: Client, claim: Claim) {
  await c.query(
    `UPDATE worker_tasks SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, failure_kind = 'cancelled',
            failure_message = 'Cancelled by the owner.', finished_at = now(), updated_at = now() WHERE ${OWN_LEASE}`,
    [claim.taskId, claim.fence, claim.workerId],
  )
  await finishAttempt(c, claim, "cancelled")
  await event(c, claim.runId, "task_cancelled", {}, claim.taskId)
  await refreshRun(c, claim.runId)
}

/**
 * Commits a result. A result for the same task can never be committed
 * twice. A real deliverable (DV-005A) is written by `deliverable.persist`
 * inside this same transaction, after the lease/fence check and while the
 * task is still "running", so a stale worker can't publish anything and a
 * crash at any point leaves either everything or nothing.
 */
export async function completeTask(
  pool: pg.Pool,
  claim: Claim,
  result: Record<string, unknown>,
  deliverable?: {
    kind: ResultKind
    persist(c: Client, commit: CommitContext): Promise<Record<string, unknown>>
  },
): Promise<CommitOutcome> {
  return transaction(pool, (c) =>
    withOwnLease(c, claim, async () => {
      const payload = deliverable
        ? await deliverable.persist(c, {
            taskId: claim.taskId,
            runId: claim.runId,
            ticketId: claim.ticketId,
            fence: claim.fence,
          })
        : result
      await c.query(
        `UPDATE worker_tasks SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
                finished_at = now(), updated_at = now() WHERE ${OWN_LEASE}`,
        [claim.taskId, claim.fence, claim.workerId],
      )
      await c.query(
        "INSERT INTO task_results (task_id, run_id, kind, schema_version, payload, fence) VALUES ($1, $2, $5, 1, $3, $4)",
        [
          claim.taskId,
          claim.runId,
          payload,
          claim.fence,
          deliverable?.kind ?? "verification",
        ],
      )
      await finishAttempt(c, claim, "succeeded")
      await event(
        c,
        claim.runId,
        "task_completed",
        { attempt: claim.attempt },
        claim.taskId,
      )
      await promoteDependents(c, claim.taskId)
    }),
  )
}

/** Records a failed attempt; the next state follows the retry policy. */
/** A source's Retry-After is honoured up to this long (longer waits aren't scheduled). */
export const MAX_RETRY_AFTER_MS = 15 * 60_000

/** Small, JSON-safe event details (≤ 3 KB), or nothing. */
function boundedDetails(details: Record<string, unknown> | undefined) {
  if (!details) return {}
  try {
    return JSON.stringify(details).length <= 3_000 ? details : {}
  } catch {
    return {}
  }
}

export async function failTask(
  pool: pg.Pool,
  claim: Claim,
  failure: {
    kind: Exclude<FailureKind, "lease_expired">
    message: string
    retryAfterMs?: number | null
    details?: Record<string, unknown>
  },
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<CommitOutcome> {
  const message = failure.message.slice(0, 500)
  return transaction(pool, (c) =>
    withOwnLease(c, claim, async () => {
      const task = (
        await c.query<{ attempts: number; max_attempts: number }>(
          "SELECT attempts, max_attempts FROM worker_tasks WHERE id = $1",
          [claim.taskId],
        )
      ).rows[0]
      const next = afterFailure(failure.kind, task.attempts, {
        maxAttempts: task.max_attempts,
      })
      const exhausted = next === "failed" && failure.kind === "transient"
      await c.query(
        `UPDATE worker_tasks SET status = $4, lease_owner = NULL, lease_expires_at = NULL, failure_kind = $5, failure_message = $6,
                eligible_at = now() + ($7::int * interval '1 millisecond'),
                finished_at = CASE WHEN $4 IN ('failed', 'needs_input') THEN now() ELSE NULL END, updated_at = now()
          WHERE ${OWN_LEASE}`,
        [
          claim.taskId,
          claim.fence,
          claim.workerId,
          next,
          exhausted ? "exhausted" : failure.kind,
          exhausted
            ? `Gave up after ${task.attempts} attempts. Last error: ${message}`.slice(
                0,
                500,
              )
            : message,
          next === "retry_wait"
            ? Math.max(
                backoffMs(task.attempts, policy),
                Math.min(
                  Math.max(failure.retryAfterMs ?? 0, 0),
                  MAX_RETRY_AFTER_MS,
                ),
              )
            : 0,
        ],
      )
      await finishAttempt(
        c,
        claim,
        failure.kind === "transient"
          ? "transient_failure"
          : failure.kind === "permanent"
            ? "permanent_failure"
            : "needs_input",
        message,
      )
      await event(
        c,
        claim.runId,
        next === "retry_wait"
          ? "task_retry_scheduled"
          : next === "failed"
            ? "task_failed"
            : "task_needs_input",
        {
          ...boundedDetails(failure.details),
          attempt: task.attempts,
          exhausted,
        },
        claim.taskId,
      )
      if (next !== "retry_wait")
        await blockDescendants(c, claim.runId, claim.taskId)
    }),
  )
}

/** The handler stopped because the run is being cancelled. */
export async function acknowledgeCancel(
  pool: pg.Pool,
  claim: Claim,
): Promise<CommitOutcome> {
  return transaction(pool, async (c) => {
    await lockRun(c, claim.runId)
    const owned = await c.query(
      `SELECT 1 FROM worker_tasks WHERE ${OWN_LEASE} FOR UPDATE`,
      [claim.taskId, claim.fence, claim.workerId],
    )
    if (!owned.rowCount) return "stale"
    await markCancelled(c, claim)
    return "cancelled"
  })
}

/**
 * Graceful shutdown: hands an unfinished task back without counting the
 * attempt (it didn't fail). Paused or cancelling runs are respected.
 */
export async function releaseTask(
  pool: pg.Pool,
  claim: Claim,
): Promise<CommitOutcome> {
  return transaction(pool, async (c) => {
    const run = await lockRun(c, claim.runId)
    const owned = await c.query(
      `SELECT 1 FROM worker_tasks WHERE ${OWN_LEASE} FOR UPDATE`,
      [claim.taskId, claim.fence, claim.workerId],
    )
    if (!owned.rowCount || !run) return "stale"
    if (run.status === "cancelling" || run.status === "cancelled") {
      await markCancelled(c, claim)
      return "cancelled"
    }
    await c.query(
      `UPDATE worker_tasks SET status = 'queued', attempts = greatest(attempts - 1, 0), lease_owner = NULL, lease_expires_at = NULL,
              eligible_at = now(), updated_at = now() WHERE ${OWN_LEASE}`,
      [claim.taskId, claim.fence, claim.workerId],
    )
    await finishAttempt(
      c,
      claim,
      "released",
      "The worker stopped before finishing; the task was handed back.",
    )
    await event(c, claim.runId, "task_released", {}, claim.taskId)
    await refreshRun(c, claim.runId)
    return "committed"
  })
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/**
 * Recovers tasks whose lease expired (the worker crashed, hung or lost the
 * database). Never marks an interrupted task successful:
 * - cancelling run → cancelled;
 * - recovery "retry" → retry_wait with backoff, or failed when exhausted;
 * - recovery "inspect" → needs_input (side effects may have happened).
 * The old worker's fence no longer matches, so it can't commit later.
 */
export async function recoverExpiredLeases(
  pool: pg.Pool,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<number> {
  const expired = (
    await pool.query<{ id: string; run_id: string }>(
      "SELECT id, run_id FROM worker_tasks WHERE status = 'running' AND lease_expires_at <= clock_timestamp() ORDER BY lease_expires_at LIMIT 100",
    )
  ).rows
  let recovered = 0
  for (const row of expired) {
    const done = await transaction(pool, async (c) => {
      const run = await lockRun(c, row.run_id)
      const task = (
        await c.query<{
          attempts: number
          max_attempts: number
          recovery_policy: "retry" | "inspect"
          fence: number
        }>(
          "SELECT attempts, max_attempts, recovery_policy, fence FROM worker_tasks WHERE id = $1 AND status = 'running' AND lease_expires_at <= clock_timestamp() FOR UPDATE",
          [row.id],
        )
      ).rows[0]
      if (!task || !run) return false
      const cancelling =
        run.status === "cancelling" || run.status === "cancelled"
      const next = cancelling
        ? "cancelled"
        : afterFailure(
            "lease_expired",
            task.attempts,
            { maxAttempts: task.max_attempts },
            task.recovery_policy,
          )
      const message = cancelling
        ? "Cancelled by the owner (the worker had stopped responding)."
        : next === "needs_input"
          ? "The worker stopped mid-task and this step isn't safe to repeat automatically. Check it, then retry."
          : next === "failed"
            ? `Gave up after ${task.attempts} attempts: the worker kept stopping mid-task.`
            : "The worker stopped responding; the task will be retried."
      await c.query(
        `UPDATE worker_tasks SET status = $2, lease_owner = NULL, lease_expires_at = NULL, failure_kind = $3, failure_message = $4,
                eligible_at = now() + ($5::int * interval '1 millisecond'),
                finished_at = CASE WHEN $2 IN ('failed', 'needs_input', 'cancelled') THEN now() ELSE NULL END, updated_at = now()
          WHERE id = $1`,
        [
          row.id,
          next,
          cancelling
            ? "cancelled"
            : next === "failed"
              ? "exhausted"
              : "lease_expired",
          message,
          next === "retry_wait" ? backoffMs(task.attempts, policy) : 0,
        ],
      )
      await c.query(
        "UPDATE task_attempts SET outcome = 'lease_expired', failure_message = 'Lease expired before the attempt finished.', finished_at = clock_timestamp(), duration_ms = (extract(epoch FROM clock_timestamp() - started_at) * 1000)::int WHERE task_id = $1 AND fence = $2 AND outcome = 'running'",
        [row.id, task.fence],
      )
      await event(c, row.run_id, "task_lease_expired", { next }, row.id)
      if (next !== "retry_wait") await blockDescendants(c, row.run_id, row.id)
      await refreshRun(c, row.run_id)
      return true
    })
    if (done) recovered++
  }
  return recovered
}

// ---------------------------------------------------------------------------
// Controls (idempotent by requestId; ownership checked by ticket)
// ---------------------------------------------------------------------------

async function controlPrologue(
  c: Client,
  ticketId: string,
  runId: string,
  requestId: string,
) {
  const run = await lockRun(c, runId)
  if (!run || run.ticket_id !== ticketId)
    throw new OrchestratorError(
      "not-found",
      "That run isn't part of this ticket.",
    )
  const repeat = await c.query(
    "SELECT 1 FROM run_events WHERE run_id = $1 AND request_id = $2",
    [runId, requestId],
  )
  return { run, repeated: Boolean(repeat.rowCount) }
}

const running = async (c: Client, runId: string) =>
  Number(
    (
      await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM worker_tasks WHERE run_id = $1 AND status = 'running'",
        [runId],
      )
    ).rows[0].n,
  )

export async function pauseRun(
  pool: pg.Pool,
  ticketId: string,
  runId: string,
  requestId: string,
) {
  return transaction(pool, async (c) => {
    const { run, repeated } = await controlPrologue(
      c,
      ticketId,
      runId,
      requestId,
    )
    if (repeated) return
    if (run.status !== "queued" && run.status !== "running")
      throw new OrchestratorError(
        "invalid-transition",
        `A ${run.status.replace(/_/g, " ")} run can't be paused.`,
      )
    const next = (await running(c, runId)) > 0 ? "pausing" : "paused"
    await c.query(
      "UPDATE campaign_runs SET status = $2, pause_requested_at = now(), updated_at = now() WHERE id = $1",
      [runId, next],
    )
    await event(
      c,
      runId,
      "run_pause_requested",
      { status: next },
      null,
      requestId,
    )
    if (next === "paused") await event(c, runId, "run_paused")
  })
}

export async function resumeRun(
  pool: pg.Pool,
  ticketId: string,
  runId: string,
  requestId: string,
) {
  return transaction(pool, async (c) => {
    const { run, repeated } = await controlPrologue(
      c,
      ticketId,
      runId,
      requestId,
    )
    if (repeated) return
    if (run.status !== "paused" && run.status !== "pausing")
      throw new OrchestratorError(
        "invalid-transition",
        `A ${run.status.replace(/_/g, " ")} run can't be resumed.`,
      )
    const next = run.started_at ? "running" : "queued"
    await c.query(
      "UPDATE campaign_runs SET status = $2, pause_requested_at = NULL, updated_at = now() WHERE id = $1",
      [runId, next],
    )
    await event(c, runId, "run_resumed", { status: next }, null, requestId)
    await refreshRun(c, runId)
  })
}

/**
 * Cancels a run: every task that isn't running is cancelled now; running
 * tasks are cancelled when their worker notices (next heartbeat) or their
 * lease expires. The run is "cancelling" until then.
 */
export async function cancelRun(
  pool: pg.Pool,
  ticketId: string,
  runId: string,
  requestId: string,
) {
  return transaction(pool, async (c) => {
    const { run, repeated } = await controlPrologue(
      c,
      ticketId,
      runId,
      requestId,
    )
    if (repeated) return
    if (!["queued", "running", "pausing", "paused"].includes(run.status))
      throw new OrchestratorError(
        "invalid-transition",
        `A ${run.status.replace(/_/g, " ")} run can't be cancelled.`,
      )
    const { rows } = await c.query<{ id: string }>(
      `UPDATE worker_tasks SET status = 'cancelled', failure_kind = 'cancelled', failure_message = 'Cancelled by the owner.',
              finished_at = now(), updated_at = now()
        WHERE run_id = $1 AND status IN ('waiting_dependencies', 'queued', 'retry_wait', 'blocked') RETURNING id`,
      [runId],
    )
    const next = (await running(c, runId)) > 0 ? "cancelling" : "cancelled"
    await c.query(
      "UPDATE campaign_runs SET status = $2, cancel_requested_at = now(), finished_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE NULL END, updated_at = now() WHERE id = $1",
      [runId, next],
    )
    await event(
      c,
      runId,
      "run_cancel_requested",
      { status: next, tasksCancelled: rows.length },
      null,
      requestId,
    )
    if (next === "cancelled") await event(c, runId, "run_cancelled")
    await refreshRun(c, runId)
  })
}

/** Manually retries a failed or needs-input task (and unblocks what depended on it). */
export async function retryTask(
  pool: pg.Pool,
  ticketId: string,
  runId: string,
  taskId: string,
  requestId: string,
) {
  return transaction(pool, async (c) => {
    const { run, repeated } = await controlPrologue(
      c,
      ticketId,
      runId,
      requestId,
    )
    if (repeated) return
    const task = (
      await c.query<{ status: TaskStatus; attempts: number }>(
        "SELECT status, attempts FROM worker_tasks WHERE id = $1 AND run_id = $2 FOR UPDATE",
        [taskId, runId],
      )
    ).rows[0]
    if (!task)
      throw new OrchestratorError(
        "not-found",
        "That task isn't part of this run.",
      )
    if (task.status !== "failed" && task.status !== "needs_input")
      throw new OrchestratorError(
        "invalid-transition",
        "Only a failed task, or one that needs input, can be retried.",
      )
    if (["cancelling", "cancelled"].includes(run.status))
      throw new OrchestratorError(
        "invalid-transition",
        "A cancelled run can't be retried. Start a new run instead.",
      )
    if (task.attempts >= MAX_ATTEMPTS_LIMIT)
      throw new OrchestratorError(
        "limit",
        `This task has used all ${MAX_ATTEMPTS_LIMIT} attempts.`,
      )
    if (["completed", "completed_with_errors", "failed"].includes(run.status)) {
      const other = await c.query(
        "SELECT 1 FROM campaign_runs WHERE ticket_id = $1 AND id <> $2 AND status = ANY($3)",
        [ticketId, runId, ACTIVE_RUNS],
      )
      if (other.rowCount)
        throw new OrchestratorError(
          "active-run",
          "Another run of this ticket is unfinished. Finish or cancel it first.",
        )
      await c.query(
        "UPDATE campaign_runs SET status = 'running', finished_at = NULL, error = NULL, updated_at = now() WHERE id = $1",
        [runId],
      )
    }
    await c.query(
      `UPDATE worker_tasks SET status = 'queued', max_attempts = least($3::int, attempts + $4::int), eligible_at = now(),
              failure_kind = NULL, failure_message = NULL, finished_at = NULL, updated_at = now() WHERE id = $1 AND run_id = $2`,
      [taskId, runId, MAX_ATTEMPTS_LIMIT, DEFAULT_RETRY_POLICY.maxAttempts],
    )
    await event(c, runId, "task_retry_requested", {}, taskId, requestId)
    await unblock(c, runId)
    await refreshRun(c, runId)
  })
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const STAGE_ORDER = [
  ...new Set(WORKFLOWS.flatMap((w) => w.stages).map((s) => s.stage)),
]
const stageOrder = (stage: string) => {
  const i = STAGE_ORDER.indexOf(stage)
  return i === -1 ? STAGE_ORDER.length : i
}

function summaryOf(r: Record<string, unknown>): RunSummary {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null)
  return {
    id: r.id as string,
    ticketId: r.ticket_id as string,
    ticketVersion: r.ticket_version as number,
    mode: r.mode as RunMode,
    workflow: r.workflow as string,
    status: r.status as RunStatus,
    counts: r.summary as RunSummary["counts"],
    error: (r.error as string | null) ?? null,
    createdAt: iso(r.created_at)!,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  }
}

export async function listRuns(
  pool: pg.Pool,
  ticketId: string,
  limit = 20,
): Promise<RunSummary[]> {
  const { rows } = await pool.query(
    "SELECT * FROM campaign_runs WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT $2",
    [ticketId, limit],
  )
  return rows.map(summaryOf)
}

export async function getRun(
  pool: pg.Pool,
  ticketId: string,
  runId: string,
): Promise<RunDetail | null> {
  const run = (
    await pool.query(
      "SELECT * FROM campaign_runs WHERE id = $1 AND ticket_id = $2",
      [runId, ticketId],
    )
  ).rows[0]
  if (!run) return null
  const snapshots = (
    await pool.query(
      "SELECT id, product_id, position, checksum, data->'product'->>'name' AS name FROM run_product_snapshots WHERE run_id = $1 ORDER BY position",
      [runId],
    )
  ).rows
  const tasks = (
    await pool.query(
      `SELECT t.*, EXISTS (SELECT 1 FROM task_results x WHERE x.task_id = t.id) AS has_result
         FROM worker_tasks t WHERE t.run_id = $1 ORDER BY t.created_at`,
      [runId],
    )
  ).rows
  const events = (
    await pool.query(
      "SELECT id, type, task_id, details, created_at FROM run_events WHERE run_id = $1 ORDER BY id DESC LIMIT 100",
      [runId],
    )
  ).rows
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null)
  return {
    run: summaryOf(run),
    products: snapshots.map((s) => ({
      snapshotId: s.id,
      productId: s.product_id,
      position: s.position,
      name: s.name || `Product #${s.position + 1}`,
      checksum: s.checksum,
      tasks: tasks
        .filter((t) => t.snapshot_id === s.id)
        // Tasks of one plan share created_at: order by workflow stage.
        .sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage))
        .map((t) => ({
          id: t.id,
          stage: t.stage,
          label: stageLabel(t.stage),
          status: t.status,
          resourceClass: t.resource_class,
          attempts: t.attempts,
          maxAttempts: t.max_attempts,
          failureKind: t.failure_kind,
          failureMessage: t.failure_message,
          eligibleAt: iso(t.eligible_at)!,
          startedAt: iso(t.started_at),
          finishedAt: iso(t.finished_at),
          hasResult: t.has_result,
        })),
    })),
    events: events.map((e) => ({
      id: Number(e.id),
      type: e.type,
      taskId: e.task_id,
      details: e.details,
      createdAt: iso(e.created_at)!,
    })),
  }
}

/** Whether a product or asset is part of an unfinished run's frozen inputs. */
export const ACTIVE_RUN_SQL = `'${ACTIVE_RUN_STATUSES.join("', '")}'`

// ---------------------------------------------------------------------------
// Worker check-ins (DV-005A): lets the UI say whether a worker is running
// ---------------------------------------------------------------------------

/** Records that a worker process is alive and which stages it can run. */
export async function checkInWorker(
  pool: pg.Pool,
  worker: { workerId: string; pid: number; stages: readonly string[] },
) {
  await pool.query(
    `INSERT INTO orchestrator_workers (worker_id, pid, stages, started_at, last_seen_at)
       VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = now(), stages = EXCLUDED.stages`,
    [worker.workerId, worker.pid, worker.stages.slice(0, 20)],
  )
  await pool.query(
    "DELETE FROM orchestrator_workers WHERE last_seen_at < now() - interval '1 day'",
  )
}

export async function checkOutWorker(pool: pg.Pool, workerId: string) {
  await pool.query("DELETE FROM orchestrator_workers WHERE worker_id = $1", [
    workerId,
  ])
}

/** Seconds since a worker that can run `stage` last checked in (null: never). */
export async function workerLastSeen(pool: pg.Pool, stage: string) {
  const { rows } = await pool.query<{ ago: number | null }>(
    "SELECT extract(epoch FROM now() - max(last_seen_at))::int AS ago FROM orchestrator_workers WHERE $1 = ANY(stages)",
    [stage],
  )
  return rows[0]?.ago ?? null
}
