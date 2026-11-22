import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  primaryKey,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

import type { PublishingPreferences } from "@/lib/tickets/types"

/**
 * Deskverse database schema.
 *
 * Every change goes through a new versioned migration (`yarn db:generate`,
 * review the SQL, `yarn db:migrate`), never by pushing schema changes.
 *
 * DV-004A: app_metadata. DV-004B: Affiliate Tickets. DV-004C: the campaign
 * orchestrator (runs, frozen inputs, tasks, attempts, results, events).
 * DV-005A: Scout research (reports, sources, evidence, claims) and worker
 * check-ins. DV-005B: Quill scripts (scripts, scenes, scene claims).
 *
 * The ticket tables hold the OWNER'S input only. Future workers (Scout,
 * Quill, Pixel…) will write their results to separate deliverable tables
 * (DV-004C onwards) and never update these rows.
 */

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}

/** Small internal key/value facts about this database, e.g. when it was set up. */
export const appMetadata = pgTable("app_metadata", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  ...timestamps,
})

// ---------------------------------------------------------------------------
// Affiliate Tickets (DV-004B)
// ---------------------------------------------------------------------------

/** char_length() counts code points, like the application validators. */
const maxLength = (column: string, max: number) =>
  sql.raw(`char_length("${column}") <= ${max}`)

export const affiliateTickets = pgTable(
  "affiliate_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Shown as AFT-0001. Allocated by PostgreSQL; may have gaps after rollbacks. */
    number: integer("number").notNull().unique().generatedAlwaysAsIdentity(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    priority: text("priority").notNull().default("normal"),
    platform: text("platform").notNull().default("tiktok"),
    publishingPreferences: jsonb("publishing_preferences")
      .$type<PublishingPreferences>()
      .notNull()
      .default({ schedule: "", notes: "" }),
    status: text("status").notNull().default("draft"),
    /** Optimistic concurrency: bumped by every change to the ticket or its contents. */
    version: integer("version").notNull().default(1),
    /** Client-generated ID that makes a repeated create return the same ticket. */
    createRequestId: text("create_request_id").unique(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check(
      "affiliate_tickets_title_check",
      sql`char_length(btrim(${t.title})) BETWEEN 3 AND 120`,
    ),
    check(
      "affiliate_tickets_description_check",
      maxLength("description", 5000),
    ),
    check(
      "affiliate_tickets_instructions_check",
      maxLength("instructions", 5000),
    ),
    check(
      "affiliate_tickets_priority_check",
      sql`${t.priority} IN ('low', 'normal', 'high')`,
    ),
    check(
      "affiliate_tickets_platform_check",
      sql`${t.platform} IN ('tiktok', 'instagram_reels', 'youtube_shorts', 'other')`,
    ),
    check(
      "affiliate_tickets_status_check",
      sql`${t.status} IN ('draft', 'ready', 'archived')`,
    ),
    check(
      "affiliate_tickets_preferences_check",
      sql`jsonb_typeof(${t.publishingPreferences}) = 'object'`,
    ),
    check("affiliate_tickets_version_check", sql`${t.version} >= 1`),
    check(
      "affiliate_tickets_archived_check",
      sql`(${t.status} = 'archived') = (${t.archivedAt} IS NOT NULL)`,
    ),
    check(
      "affiliate_tickets_ready_check",
      sql`(${t.status} = 'ready') = (${t.readyAt} IS NOT NULL)`,
    ),
    index("affiliate_tickets_status_updated_idx").on(t.status, t.updatedAt),
    index("affiliate_tickets_updated_idx").on(t.updatedAt),
  ],
)

export const ticketProducts = pgTable(
  "ticket_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => affiliateTickets.id, { onDelete: "restrict" }),
    /** 0-based order within the ticket (maintained under the ticket's row lock). */
    position: integer("position").notNull(),
    name: text("name").notNull().default(""),
    affiliateUrl: text("affiliate_url").notNull().default(""),
    description: text("description").notNull().default(""),
    specifications: text("specifications").notNull().default(""),
    notes: text("notes").notNull().default(""),
    /** Where the owner got the product information and media from. */
    source: text("source").notNull().default(""),
    mediaRights: text("media_rights").notNull().default("unspecified"),
    mediaRightsNote: text("media_rights_note").notNull().default(""),
    createRequestId: text("create_request_id").unique(),
    ...timestamps,
  },
  (t) => [
    // Lets child rows prove they belong to the same ticket (composite FKs).
    unique("ticket_products_id_ticket_unique").on(t.id, t.ticketId),
    check("ticket_products_position_check", sql`${t.position} >= 0`),
    check("ticket_products_name_check", maxLength("name", 120)),
    check(
      "ticket_products_affiliate_url_check",
      maxLength("affiliate_url", 2048),
    ),
    check("ticket_products_description_check", maxLength("description", 5000)),
    check(
      "ticket_products_specifications_check",
      maxLength("specifications", 5000),
    ),
    check("ticket_products_notes_check", maxLength("notes", 5000)),
    check("ticket_products_source_check", maxLength("source", 500)),
    check(
      "ticket_products_media_rights_check",
      sql`${t.mediaRights} IN ('unspecified', 'owned', 'licensed', 'permission', 'affiliate_program')`,
    ),
    check(
      "ticket_products_media_rights_note_check",
      maxLength("media_rights_note", 500),
    ),
    index("ticket_products_ticket_position_idx").on(t.ticketId, t.position),
  ],
)

export const ticketReferences = pgTable(
  "ticket_references",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id").notNull(),
    productId: uuid("product_id").notNull(),
    position: integer("position").notNull(),
    kind: text("kind").notNull(),
    url: text("url").notNull(),
    label: text("label").notNull().default(""),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    foreignKey({
      name: "ticket_references_product_fk",
      columns: [t.productId, t.ticketId],
      foreignColumns: [ticketProducts.id, ticketProducts.ticketId],
    }).onDelete("cascade"),
    unique("ticket_references_product_url_unique").on(t.productId, t.url),
    check(
      "ticket_references_kind_check",
      sql`${t.kind} IN ('listing', 'manufacturer', 'review', 'demo_video', 'other')`,
    ),
    check(
      "ticket_references_url_check",
      sql`char_length(${t.url}) <= 2048 AND ${t.url} ~ '^https?://'`,
    ),
    check("ticket_references_label_check", maxLength("label", 200)),
    index("ticket_references_product_idx").on(t.productId, t.position),
  ],
)

export const ticketAssets = pgTable(
  "ticket_assets",
  {
    /** Also the file name: tickets/<ticket_id>/assets/<id>.<extension>. */
    id: uuid("id").primaryKey(),
    ticketId: uuid("ticket_id").notNull(),
    productId: uuid("product_id").notNull(),
    position: integer("position").notNull(),
    kind: text("kind").notNull(),
    mimeType: text("mime_type").notNull(),
    extension: text("extension").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    durationMs: integer("duration_ms"),
    /** Display only; never used to build a path. */
    originalName: text("original_name").notNull().default(""),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    foreignKey({
      name: "ticket_assets_product_fk",
      columns: [t.productId, t.ticketId],
      foreignColumns: [ticketProducts.id, ticketProducts.ticketId],
    }).onDelete("cascade"),
    check(
      "ticket_assets_kind_check",
      sql`(${t.kind} = 'image' AND ${t.mimeType} IN ('image/jpeg', 'image/png', 'image/webp') AND ${t.durationMs} IS NULL)
        OR (${t.kind} = 'video' AND ${t.mimeType} = 'video/mp4' AND ${t.durationMs} IS NOT NULL)`,
    ),
    check(
      "ticket_assets_extension_check",
      sql`(${t.mimeType}, ${t.extension}) IN (('image/jpeg', 'jpg'), ('image/png', 'png'), ('image/webp', 'webp'), ('video/mp4', 'mp4'))`,
    ),
    check("ticket_assets_size_check", sql`${t.byteSize} > 0`),
    check("ticket_assets_sha256_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "ticket_assets_dimensions_check",
      sql`${t.width} > 0 AND ${t.height} > 0`,
    ),
    check(
      "ticket_assets_duration_check",
      sql`${t.durationMs} IS NULL OR ${t.durationMs} > 0`,
    ),
    check("ticket_assets_name_check", maxLength("original_name", 255)),
    index("ticket_assets_product_idx").on(t.productId, t.position),
    index("ticket_assets_ticket_idx").on(t.ticketId),
  ],
)

/**
 * What actually happened to a ticket, written in the same transaction as
 * the change. Details hold field names, statuses and counts only: never
 * URLs, file paths or other private text.
 */
export const ticketEvents = pgTable(
  "ticket_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => affiliateTickets.id, { onDelete: "restrict" }),
    /** No foreign keys: history outlives removed products and assets. */
    productId: uuid("product_id"),
    assetId: uuid("asset_id"),
    type: text("type").notNull(),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    check(
      "ticket_events_type_check",
      sql`${t.type} IN ('ticket_created', 'ticket_edited', 'product_added', 'product_updated', 'product_moved', 'product_removed', 'asset_uploaded', 'asset_removed', 'marked_ready', 'returned_to_draft', 'archived', 'restored')`,
    ),
    check(
      "ticket_events_details_check",
      sql`jsonb_typeof(${t.details}) = 'object'`,
    ),
    index("ticket_events_ticket_idx").on(t.ticketId, t.createdAt, t.id),
  ],
)

// ---------------------------------------------------------------------------
// Campaign orchestrator (DV-004C)
// ---------------------------------------------------------------------------

const RUN_STATUS_SQL = `'queued', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'completed', 'completed_with_errors', 'failed'`
const ACTIVE_RUN_SQL = `'queued', 'running', 'pausing', 'paused', 'cancelling'`
const TASK_STATUS_SQL = `'waiting_dependencies', 'queued', 'running', 'retry_wait', 'completed', 'failed', 'needs_input', 'blocked', 'cancelled'`

/** One execution request for one Affiliate Ticket. */
export const campaignRuns = pgTable(
  "campaign_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => affiliateTickets.id, { onDelete: "restrict" }),
    /** The ticket version the inputs were frozen from. */
    ticketVersion: integer("ticket_version").notNull(),
    /** Idempotency key of the request that created the run. */
    requestId: text("request_id").notNull().unique(),
    /** "verification": deterministic test handlers only, never real output. */
    mode: text("mode").notNull(),
    /** Which task graph the run uses, e.g. "verification-v1". */
    workflow: text("workflow").notNull(),
    status: text("status").notNull().default("queued"),
    pauseRequestedAt: timestamp("pause_requested_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Task counts by state, refreshed with every transition. */
    summary: jsonb("summary")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    /** A fixed, safe explanation when the run ends badly. */
    error: text("error"),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (t) => [
    unique("campaign_runs_id_ticket_unique").on(t.id, t.ticketId),
    check(
      "campaign_runs_mode_check",
      sql`${t.mode} IN ('production', 'verification')`,
    ),
    check(
      "campaign_runs_status_check",
      sql.raw(`"status" IN (${RUN_STATUS_SQL})`),
    ),
    check("campaign_runs_version_check", sql`${t.ticketVersion} >= 1`),
    check(
      "campaign_runs_error_check",
      sql`${t.error} IS NULL OR char_length(${t.error}) <= 500`,
    ),
    check(
      "campaign_runs_finished_check",
      sql.raw(`("finished_at" IS NULL) = ("status" IN (${ACTIVE_RUN_SQL}))`),
    ),
    check(
      "campaign_runs_workflow_check",
      sql`${t.workflow} ~ '^[a-z0-9.-]{1,40}$'`,
    ),
    // At most one unfinished run per ticket.
    uniqueIndex("campaign_runs_one_active_idx")
      .on(t.ticketId)
      .where(sql.raw(`"status" IN (${ACTIVE_RUN_SQL})`)),
    index("campaign_runs_ticket_created_idx").on(t.ticketId, t.createdAt),
    index("campaign_runs_status_idx").on(t.status),
  ],
)

/**
 * The frozen input for one product of one run. Immutable: a trigger in the
 * migration refuses UPDATE and DELETE, and owner edits never touch it.
 */
export const runProductSnapshots = pgTable(
  "run_product_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    ticketId: uuid("ticket_id").notNull(),
    /** The source product (no foreign key: the snapshot outlives it). */
    productId: uuid("product_id").notNull(),
    position: integer("position").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    /** SHA-256 of the canonical JSON of `data`. */
    checksum: text("checksum").notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    foreignKey({
      name: "run_product_snapshots_run_fk",
      columns: [t.runId, t.ticketId],
      foreignColumns: [campaignRuns.id, campaignRuns.ticketId],
    }).onDelete("restrict"),
    unique("run_product_snapshots_run_product_unique").on(t.runId, t.productId),
    unique("run_product_snapshots_id_run_unique").on(t.id, t.runId),
    check(
      "run_product_snapshots_checksum_check",
      sql`${t.checksum} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "run_product_snapshots_size_check",
      sql`pg_column_size(${t.data}) <= 262144`,
    ),
    check("run_product_snapshots_version_check", sql`${t.schemaVersion} >= 1`),
    index("run_product_snapshots_product_idx").on(t.productId),
  ],
)

/** One durable unit of work for one worker stage, usually for one product. */
export const workerTasks = pgTable(
  "worker_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    ticketId: uuid("ticket_id").notNull(),
    snapshotId: uuid("snapshot_id"),
    /** Handler stage, e.g. "verify.collect" (future: "scout.research"). */
    stage: text("stage").notNull(),
    status: text("status").notNull(),
    resourceClass: text("resource_class").notNull(),
    priority: integer("priority").notNull().default(0),
    /** "retry": safe to repeat after a crash; "inspect": ask the owner first. */
    recoveryPolicy: text("recovery_policy").notNull(),
    /** Stable key for the logical task: handlers use it to make side effects idempotent. */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    /** Deterministic verification behaviour (test handlers only). */
    params: jsonb("params")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Counted attempts (graceful releases are not counted). */
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    /** When the task may next be claimed (retry backoff). */
    eligibleAt: timestamp("eligible_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** Fencing token: increases with every claim; finalization must match it. */
    fence: bigint("fence", { mode: "number" }).notNull().default(0),
    failureKind: text("failure_kind"),
    failureMessage: text("failure_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (t) => [
    foreignKey({
      name: "worker_tasks_run_fk",
      columns: [t.runId, t.ticketId],
      foreignColumns: [campaignRuns.id, campaignRuns.ticketId],
    }).onDelete("restrict"),
    foreignKey({
      name: "worker_tasks_snapshot_fk",
      columns: [t.snapshotId, t.runId],
      foreignColumns: [runProductSnapshots.id, runProductSnapshots.runId],
    }).onDelete("restrict"),
    unique("worker_tasks_id_run_unique").on(t.id, t.runId),
    check(
      "worker_tasks_status_check",
      sql.raw(`"status" IN (${TASK_STATUS_SQL})`),
    ),
    check(
      "worker_tasks_resource_check",
      sql`${t.resourceClass} IN ('general', 'cpu', 'render')`,
    ),
    check(
      "worker_tasks_recovery_check",
      sql`${t.recoveryPolicy} IN ('retry', 'inspect')`,
    ),
    check(
      "worker_tasks_stage_check",
      sql`${t.stage} ~ '^[a-z][a-z0-9-]*[.][a-z][a-z0-9-]*$'`,
    ),
    check(
      "worker_tasks_attempts_check",
      sql`${t.attempts} >= 0 AND ${t.maxAttempts} BETWEEN 1 AND 10`,
    ),
    check(
      "worker_tasks_lease_check",
      sql`(${t.status} = 'running') = (${t.leaseOwner} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      "worker_tasks_failure_check",
      sql`${t.failureKind} IS NULL OR ${t.failureKind} IN ('transient', 'permanent', 'needs_input', 'lease_expired', 'exhausted', 'cancelled', 'blocked')`,
    ),
    check(
      "worker_tasks_message_check",
      sql`${t.failureMessage} IS NULL OR char_length(${t.failureMessage}) <= 500`,
    ),
    check(
      "worker_tasks_params_check",
      sql`pg_column_size(${t.params}) <= 4096`,
    ),
    index("worker_tasks_claim_idx").on(t.status, t.resourceClass, t.eligibleAt),
    index("worker_tasks_lease_idx").on(t.leaseExpiresAt),
    index("worker_tasks_run_idx").on(t.runId, t.status),
    index("worker_tasks_snapshot_idx").on(t.snapshotId),
  ],
)

/** "task depends on prerequisite", within one run. Cycles are refused by a trigger. */
export const taskDependencies = pgTable(
  "task_dependencies",
  {
    runId: uuid("run_id").notNull(),
    taskId: uuid("task_id").notNull(),
    dependsOnTaskId: uuid("depends_on_task_id").notNull(),
  },
  (t) => [
    primaryKey({
      name: "task_dependencies_pk",
      columns: [t.taskId, t.dependsOnTaskId],
    }),
    foreignKey({
      name: "task_dependencies_task_fk",
      columns: [t.taskId, t.runId],
      foreignColumns: [workerTasks.id, workerTasks.runId],
    }).onDelete("restrict"),
    foreignKey({
      name: "task_dependencies_prerequisite_fk",
      columns: [t.dependsOnTaskId, t.runId],
      foreignColumns: [workerTasks.id, workerTasks.runId],
    }).onDelete("restrict"),
    check(
      "task_dependencies_self_check",
      sql`${t.taskId} <> ${t.dependsOnTaskId}`,
    ),
    index("task_dependencies_prerequisite_idx").on(t.dependsOnTaskId),
  ],
)

/** Every execution attempt, including interrupted ones. */
export const taskAttempts = pgTable(
  "task_attempts",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => workerTasks.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    workerId: text("worker_id").notNull(),
    fence: bigint("fence", { mode: "number" }).notNull(),
    outcome: text("outcome").notNull().default("running"),
    failureMessage: text("failure_message"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    unique("task_attempts_task_number_unique").on(t.taskId, t.attemptNumber),
    unique("task_attempts_task_fence_unique").on(t.taskId, t.fence),
    check(
      "task_attempts_outcome_check",
      sql`${t.outcome} IN ('running', 'succeeded', 'transient_failure', 'permanent_failure', 'needs_input', 'cancelled', 'lease_expired', 'released', 'stale')`,
    ),
    check("task_attempts_worker_check", sql`char_length(${t.workerId}) <= 200`),
    check(
      "task_attempts_message_check",
      sql`${t.failureMessage} IS NULL OR char_length(${t.failureMessage}) <= 500`,
    ),
    index("task_attempts_task_idx").on(t.taskId),
  ],
)

/** At most one committed result per task (the primary key is the task). */
export const taskResults = pgTable(
  "task_results",
  {
    taskId: uuid("task_id")
      .primaryKey()
      .references(() => workerTasks.id, { onDelete: "restrict" }),
    runId: uuid("run_id").notNull(),
    /**
     * "verification": a deterministic test result, never real content.
     * "scout_research" (DV-005A): a compact reference to a scout_reports row.
     */
    kind: text("kind").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    fence: bigint("fence", { mode: "number" }).notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    check(
      "task_results_kind_check",
      sql`${t.kind} IN ('verification', 'scout_research', 'quill_script')`,
    ),
    check(
      "task_results_size_check",
      sql`pg_column_size(${t.payload}) <= 16384`,
    ),
    index("task_results_run_idx").on(t.runId),
  ],
)

/** What happened to a run, written in the same transaction as the change. */
export const runEvents = pgTable(
  "run_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    runId: uuid("run_id")
      .notNull()
      .references(() => campaignRuns.id, { onDelete: "restrict" }),
    taskId: uuid("task_id"),
    type: text("type").notNull(),
    /** Idempotency key of the control request that caused it, if any. */
    requestId: text("request_id"),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    unique("run_events_request_unique").on(t.runId, t.requestId),
    check(
      "run_events_type_check",
      sql`${t.type} IN ('run_created', 'run_started', 'run_pause_requested', 'run_paused', 'run_resumed', 'run_cancel_requested', 'run_cancelled', 'run_finished', 'task_claimed', 'task_completed', 'task_retry_scheduled', 'task_failed', 'task_needs_input', 'task_blocked', 'task_unblocked', 'task_cancelled', 'task_lease_expired', 'task_released', 'task_retry_requested', 'task_stale_result_refused')`,
    ),
    check(
      "run_events_details_check",
      sql`pg_column_size(${t.details}) <= 4096`,
    ),
    index("run_events_run_idx").on(t.runId, t.id),
  ],
)

/**
 * Worker processes that checked in recently (DV-005A), so the UI can say
 * whether one is running. Informational only: never used for claiming.
 */
export const orchestratorWorkers = pgTable(
  "orchestrator_workers",
  {
    workerId: text("worker_id").primaryKey(),
    pid: integer("pid").notNull(),
    stages: text("stages").array().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      "orchestrator_workers_id_check",
      sql`char_length(${t.workerId}) <= 200`,
    ),
    check(
      "orchestrator_workers_stages_check",
      sql`cardinality(${t.stages}) <= 20`,
    ),
  ],
)

// ---------------------------------------------------------------------------
// Scout research (DV-005A). Immutable once written (triggers in 0003).
// ---------------------------------------------------------------------------

const SOURCE_OUTCOME_SQL = `'ok', 'invalid_url', 'blocked_address', 'dns_failed', 'robots_disallowed', 'robots_unavailable', 'redirect_refused', 'too_many_redirects', 'login_required', 'paywall', 'captcha', 'forbidden', 'not_found', 'rate_limited', 'server_error', 'http_error', 'timeout', 'network_error', 'unsupported_type', 'too_large', 'javascript_required', 'product_mismatch', 'no_content', 'affiliate_link_skipped', 'not_attempted'`

/**
 * One research brief for one product snapshot, written by exactly one
 * Scout task (in the transaction that completes it). `report_version`
 * counts the briefs for that product across runs: 1, 2, 3…
 */
export const scoutReports = pgTable(
  "scout_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    ticketId: uuid("ticket_id").notNull(),
    taskId: uuid("task_id").notNull().unique(),
    snapshotId: uuid("snapshot_id").notNull(),
    /** The source product (no foreign key: reports outlive edits and removals). */
    productId: uuid("product_id").notNull(),
    reportVersion: integer("report_version").notNull(),
    /** Brief format version (1 = "scout-brief/1"). */
    schemaVersion: integer("schema_version").notNull(),
    status: text("status").notNull(),
    extractionMode: text("extraction_mode").notNull(),
    /** The task fence that wrote it (the lease holder at commit time). */
    fence: bigint("fence", { mode: "number" }).notNull(),
    snapshotChecksum: text("snapshot_checksum").notNull(),
    /** SHA-256 of the canonical report document (brief, sources, evidence, claims, linkage). */
    checksum: text("checksum").notNull(),
    brief: jsonb("brief").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    foreignKey({
      name: "scout_reports_task_fk",
      columns: [t.taskId, t.runId],
      foreignColumns: [workerTasks.id, workerTasks.runId],
    }).onDelete("restrict"),
    foreignKey({
      name: "scout_reports_snapshot_fk",
      columns: [t.snapshotId, t.runId],
      foreignColumns: [runProductSnapshots.id, runProductSnapshots.runId],
    }).onDelete("restrict"),
    foreignKey({
      name: "scout_reports_run_fk",
      columns: [t.runId, t.ticketId],
      foreignColumns: [campaignRuns.id, campaignRuns.ticketId],
    }).onDelete("restrict"),
    unique("scout_reports_product_version_unique").on(
      t.productId,
      t.reportVersion,
    ),
    check("scout_reports_version_check", sql`${t.reportVersion} >= 1`),
    check("scout_reports_schema_check", sql`${t.schemaVersion} = 1`),
    check(
      "scout_reports_status_check",
      sql`${t.status} IN ('complete', 'insufficient_evidence')`,
    ),
    check(
      "scout_reports_extraction_check",
      sql`${t.extractionMode} IN ('deterministic', 'deterministic+ollama')`,
    ),
    check(
      "scout_reports_checksum_check",
      sql`${t.checksum} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "scout_reports_snapshot_checksum_check",
      sql`${t.snapshotChecksum} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "scout_reports_brief_check",
      sql`pg_column_size(${t.brief}) <= 131072`,
    ),
    index("scout_reports_ticket_idx").on(t.ticketId, t.createdAt),
    index("scout_reports_run_idx").on(t.runId),
  ],
)

/** What happened when Scout tried each reference (no page bodies are stored). */
export const scoutSources = pgTable(
  "scout_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => scoutReports.id, { onDelete: "restrict" }),
    key: text("key").notNull(),
    position: integer("position").notNull(),
    referenceKind: text("reference_kind").notNull(),
    label: text("label").notNull().default(""),
    requestedUrl: text("requested_url").notNull(),
    finalUrl: text("final_url"),
    title: text("title"),
    outcome: text("outcome").notNull(),
    httpStatus: integer("http_status"),
    contentType: text("content_type"),
    byteCount: integer("byte_count").notNull().default(0),
    /** SHA-256 of the bytes received (the page itself isn't kept). */
    contentSha256: text("content_sha256"),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }),
    trust: text("trust").notNull(),
    identified: boolean("identified").notNull(),
    transport: text("transport"),
    detail: text("detail"),
  },
  (t) => [
    unique("scout_sources_id_report_unique").on(t.id, t.reportId),
    unique("scout_sources_report_key_unique").on(t.reportId, t.key),
    check("scout_sources_key_check", sql`${t.key} ~ '^S[0-9]{1,2}$'`),
    check("scout_sources_position_check", sql`${t.position} BETWEEN 0 AND 99`),
    check(
      "scout_sources_kind_check",
      sql`${t.referenceKind} IN ('listing', 'manufacturer', 'review', 'demo_video', 'other')`,
    ),
    check("scout_sources_label_check", maxLength("label", 200)),
    check(
      "scout_sources_url_check",
      sql`char_length(${t.requestedUrl}) <= 2048 AND (${t.finalUrl} IS NULL OR char_length(${t.finalUrl}) <= 2048)`,
    ),
    check(
      "scout_sources_title_check",
      sql`${t.title} IS NULL OR char_length(${t.title}) <= 300`,
    ),
    check(
      "scout_sources_outcome_check",
      sql.raw(`"outcome" IN (${SOURCE_OUTCOME_SQL})`),
    ),
    check(
      "scout_sources_status_check",
      sql`${t.httpStatus} IS NULL OR ${t.httpStatus} BETWEEN 100 AND 599`,
    ),
    check(
      "scout_sources_type_check",
      sql`${t.contentType} IS NULL OR char_length(${t.contentType}) <= 100`,
    ),
    check(
      "scout_sources_bytes_check",
      sql`${t.byteCount} BETWEEN 0 AND 20971520`,
    ),
    check(
      "scout_sources_sha_check",
      sql`${t.contentSha256} IS NULL OR ${t.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "scout_sources_trust_check",
      sql`${t.trust} IN ('manufacturer', 'seller_listing', 'independent_review', 'unknown')`,
    ),
    check(
      "scout_sources_transport_check",
      sql`${t.transport} IS NULL OR ${t.transport} IN ('https', 'http')`,
    ),
    check(
      "scout_sources_detail_check",
      sql`${t.detail} IS NULL OR char_length(${t.detail}) <= 300`,
    ),
    // Only a page that was read can be matched to the product or carry a checksum.
    check(
      "scout_sources_read_check",
      sql`(${t.outcome} = 'ok') = ${t.identified} AND (${t.contentSha256} IS NULL OR ${t.retrievedAt} IS NOT NULL)`,
    ),
  ],
)

/** A short passage (or structured-data fragment) from one source, as cited by claims. */
export const scoutEvidence = pgTable(
  "scout_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    key: text("key").notNull(),
    method: text("method").notNull(),
    location: text("location").notNull(),
    passage: text("passage").notNull(),
    statement: text("statement").notNull(),
    attribute: text("attribute"),
    value: text("value"),
    /** The local model that proposed it (validated against the passage), if any. */
    model: text("model"),
  },
  (t) => [
    foreignKey({
      name: "scout_evidence_source_fk",
      columns: [t.sourceId, t.reportId],
      foreignColumns: [scoutSources.id, scoutSources.reportId],
    }).onDelete("restrict"),
    unique("scout_evidence_id_report_unique").on(t.id, t.reportId),
    unique("scout_evidence_report_key_unique").on(t.reportId, t.key),
    check("scout_evidence_key_check", sql`${t.key} ~ '^E[0-9]{1,3}$'`),
    check(
      "scout_evidence_method_check",
      sql`${t.method} IN ('json-ld', 'html-meta', 'html-table', 'html-list', 'html-text', 'text-plain', 'ollama')`,
    ),
    check("scout_evidence_location_check", maxLength("location", 200)),
    check(
      "scout_evidence_passage_check",
      sql`char_length(${t.passage}) BETWEEN 1 AND 600`,
    ),
    check("scout_evidence_statement_check", maxLength("statement", 300)),
    check(
      "scout_evidence_fields_check",
      sql`(${t.attribute} IS NULL OR char_length(${t.attribute}) <= 80) AND (${t.value} IS NULL OR char_length(${t.value}) <= 200) AND (${t.model} IS NULL OR char_length(${t.model}) <= 120)`,
    ),
    check(
      "scout_evidence_model_check",
      sql`(${t.method} = 'ollama') = (${t.model} IS NOT NULL)`,
    ),
    index("scout_evidence_report_idx").on(t.reportId),
  ],
)

/** One assessed claim (the owner's, or a fact stated by the sources). */
export const scoutClaims = pgTable(
  "scout_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => scoutReports.id, { onDelete: "restrict" }),
    key: text("key").notNull(),
    origin: text("origin").notNull(),
    kind: text("kind").notNull(),
    attribute: text("attribute"),
    value: text("value"),
    statement: text("statement").notNull(),
    status: text("status").notNull(),
    reason: text("reason").notNull(),
    topic: text("topic"),
    timeSensitive: boolean("time_sensitive").notNull(),
  },
  (t) => [
    unique("scout_claims_id_report_unique").on(t.id, t.reportId),
    unique("scout_claims_report_key_unique").on(t.reportId, t.key),
    check("scout_claims_key_check", sql`${t.key} ~ '^C[0-9]{1,3}$'`),
    check("scout_claims_origin_check", sql`${t.origin} IN ('owner', 'source')`),
    check(
      "scout_claims_kind_check",
      sql`${t.kind} IN ('attribute', 'statement', 'identity')`,
    ),
    check(
      "scout_claims_status_check",
      sql`${t.status} IN ('supported', 'conflicting', 'unverified', 'insufficient_evidence')`,
    ),
    check(
      "scout_claims_text_check",
      sql`char_length(${t.statement}) BETWEEN 1 AND 500 AND char_length(${t.reason}) <= 300 AND (${t.attribute} IS NULL OR char_length(${t.attribute}) <= 80) AND (${t.value} IS NULL OR char_length(${t.value}) <= 200)`,
    ),
    check(
      "scout_claims_topic_check",
      sql`${t.topic} IS NULL OR ${t.topic} IN ('price', 'discount', 'commission', 'rating', 'performance', 'health', 'certification', 'warranty', 'delivery', 'stock', 'superiority')`,
    ),
    // A source fact exists only because a source stated it.
    check(
      "scout_claims_source_status_check",
      sql`${t.origin} = 'owner' OR ${t.status} IN ('supported', 'conflicting')`,
    ),
    index("scout_claims_report_idx").on(t.reportId),
  ],
)

/** Which evidence a claim rests on, and how. Same report only (composite keys). */
export const scoutClaimEvidence = pgTable(
  "scout_claim_evidence",
  {
    reportId: uuid("report_id").notNull(),
    claimId: uuid("claim_id").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    relationship: text("relationship").notNull(),
  },
  (t) => [
    primaryKey({
      name: "scout_claim_evidence_pk",
      columns: [t.claimId, t.evidenceId],
    }),
    foreignKey({
      name: "scout_claim_evidence_claim_fk",
      columns: [t.claimId, t.reportId],
      foreignColumns: [scoutClaims.id, scoutClaims.reportId],
    }).onDelete("restrict"),
    foreignKey({
      name: "scout_claim_evidence_evidence_fk",
      columns: [t.evidenceId, t.reportId],
      foreignColumns: [scoutEvidence.id, scoutEvidence.reportId],
    }).onDelete("restrict"),
    check(
      "scout_claim_evidence_relationship_check",
      sql`${t.relationship} IN ('supports', 'contradicts', 'context')`,
    ),
    index("scout_claim_evidence_evidence_idx").on(t.evidenceId),
  ],
)

// ---------------------------------------------------------------------------
// Quill scripts (DV-005B). Immutable once written (triggers in 0004).
// ---------------------------------------------------------------------------

/**
 * One script for one product snapshot, written by exactly one Quill task
 * from exactly one pinned Scout report. `script_version` counts the
 * scripts for that product across runs: 1, 2, 3…
 */
export const quillScripts = pgTable(
  "quill_scripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    ticketId: uuid("ticket_id").notNull(),
    taskId: uuid("task_id").notNull().unique(),
    snapshotId: uuid("snapshot_id").notNull(),
    productId: uuid("product_id").notNull(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => scoutReports.id, { onDelete: "restrict" }),
    reportVersion: integer("report_version").notNull(),
    reportChecksum: text("report_checksum").notNull(),
    snapshotChecksum: text("snapshot_checksum").notNull(),
    scriptVersion: integer("script_version").notNull(),
    /** Script format version (1 = "quill-script/1"). */
    schemaVersion: integer("schema_version").notNull(),
    generationMode: text("generation_mode").notNull(),
    language: text("language").notNull(),
    platform: text("platform").notNull(),
    status: text("status").notNull(),
    pixelTextCompatible: boolean("pixel_text_compatible").notNull(),
    renderReady: boolean("render_ready").notNull(),
    fence: bigint("fence", { mode: "number" }).notNull(),
    /** SHA-256 of the canonical script document (metadata, scenes, claims, linkage). */
    checksum: text("checksum").notNull(),
    /** The script document without its scenes (they're in quill_scenes). */
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    foreignKey({
      name: "quill_scripts_task_fk",
      columns: [t.taskId, t.runId],
      foreignColumns: [workerTasks.id, workerTasks.runId],
    }).onDelete("restrict"),
    foreignKey({
      name: "quill_scripts_snapshot_fk",
      columns: [t.snapshotId, t.runId],
      foreignColumns: [runProductSnapshots.id, runProductSnapshots.runId],
    }).onDelete("restrict"),
    foreignKey({
      name: "quill_scripts_run_fk",
      columns: [t.runId, t.ticketId],
      foreignColumns: [campaignRuns.id, campaignRuns.ticketId],
    }).onDelete("restrict"),
    unique("quill_scripts_id_report_unique").on(t.id, t.reportId),
    unique("quill_scripts_product_version_unique").on(
      t.productId,
      t.scriptVersion,
    ),
    check(
      "quill_scripts_version_check",
      sql`${t.scriptVersion} >= 1 AND ${t.reportVersion} >= 1`,
    ),
    check("quill_scripts_schema_check", sql`${t.schemaVersion} = 1`),
    check(
      "quill_scripts_mode_check",
      sql`${t.generationMode} IN ('template', 'template+ollama')`,
    ),
    check("quill_scripts_language_check", sql`${t.language} = 'en'`),
    check("quill_scripts_platform_check", maxLength("platform", 40)),
    check("quill_scripts_status_check", sql`${t.status} = 'valid'`),
    check(
      "quill_scripts_checksums_check",
      sql`${t.checksum} ~ '^[0-9a-f]{64}$' AND ${t.reportChecksum} ~ '^[0-9a-f]{64}$' AND ${t.snapshotChecksum} ~ '^[0-9a-f]{64}$'`,
    ),
    check("quill_scripts_meta_check", sql`pg_column_size(${t.meta}) <= 131072`),
    index("quill_scripts_ticket_idx").on(t.ticketId, t.createdAt),
    index("quill_scripts_run_idx").on(t.runId),
    index("quill_scripts_report_idx").on(t.reportId),
  ],
)

/** The ordered scenes of a script (Pixel's vocabulary: hook, benefit, call-to-action). */
export const quillScenes = pgTable(
  "quill_scenes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scriptId: uuid("script_id")
      .notNull()
      .references(() => quillScripts.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
    sceneKey: text("scene_key").notNull(),
    kind: text("kind").notNull(),
    durationMs: integer("duration_ms").notNull(),
    narration: text("narration").notNull(),
    caption: text("caption").notNull(),
    subtext: text("subtext"),
    visual: text("visual").notNull(),
    notes: jsonb("notes").$type<string[]>().notNull().default([]),
  },
  (t) => [
    unique("quill_scenes_id_script_unique").on(t.id, t.scriptId),
    unique("quill_scenes_script_position_unique").on(t.scriptId, t.position),
    check("quill_scenes_position_check", sql`${t.position} BETWEEN 0 AND 7`),
    check("quill_scenes_key_check", sql`${t.sceneKey} ~ '^scene-[1-8]$'`),
    check(
      "quill_scenes_kind_check",
      sql`${t.kind} IN ('hook', 'benefit', 'call-to-action')`,
    ),
    check(
      "quill_scenes_duration_check",
      sql`${t.durationMs} BETWEEN 1990 AND 8010`,
    ),
    check(
      "quill_scenes_text_check",
      sql`char_length(${t.narration}) BETWEEN 1 AND 400 AND char_length(${t.caption}) BETWEEN 1 AND 80 AND (${t.subtext} IS NULL OR char_length(${t.subtext}) <= 60) AND char_length(${t.visual}) <= 300`,
    ),
    check("quill_scenes_notes_check", sql`pg_column_size(${t.notes}) <= 2048`),
  ],
)

/** Which Scout claim (and its evidence) a scene states. Same report only. */
export const quillSceneClaims = pgTable(
  "quill_scene_claims",
  {
    scriptId: uuid("script_id").notNull(),
    sceneId: uuid("scene_id").notNull(),
    reportId: uuid("report_id").notNull(),
    claimKey: text("claim_key").notNull(),
    statement: text("statement").notNull(),
    evidenceKeys: text("evidence_keys").array().notNull(),
    /** Evidence keys with their source and retrieval time, as shown. */
    evidence: jsonb("evidence").$type<Record<string, unknown>[]>().notNull(),
  },
  (t) => [
    primaryKey({
      name: "quill_scene_claims_pk",
      columns: [t.sceneId, t.claimKey],
    }),
    foreignKey({
      name: "quill_scene_claims_scene_fk",
      columns: [t.sceneId, t.scriptId],
      foreignColumns: [quillScenes.id, quillScenes.scriptId],
    }).onDelete("restrict"),
    foreignKey({
      name: "quill_scene_claims_script_fk",
      columns: [t.scriptId, t.reportId],
      foreignColumns: [quillScripts.id, quillScripts.reportId],
    }).onDelete("restrict"),
    foreignKey({
      name: "quill_scene_claims_claim_fk",
      columns: [t.reportId, t.claimKey],
      foreignColumns: [scoutClaims.reportId, scoutClaims.key],
    }).onDelete("restrict"),
    check(
      "quill_scene_claims_size_check",
      sql`char_length(${t.statement}) BETWEEN 1 AND 500 AND cardinality(${t.evidenceKeys}) BETWEEN 1 AND 20 AND pg_column_size(${t.evidence}) <= 8192`,
    ),
    index("quill_scene_claims_script_idx").on(t.scriptId),
  ],
)

export const schema = {
  appMetadata,
  affiliateTickets,
  ticketProducts,
  ticketReferences,
  ticketAssets,
  ticketEvents,
  campaignRuns,
  runProductSnapshots,
  workerTasks,
  taskDependencies,
  taskAttempts,
  taskResults,
  runEvents,
  orchestratorWorkers,
  scoutReports,
  scoutSources,
  scoutEvidence,
  scoutClaims,
  scoutClaimEvidence,
  quillScripts,
  quillScenes,
  quillSceneClaims,
}
