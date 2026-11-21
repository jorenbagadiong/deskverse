import { sql } from "drizzle-orm"
import {
  bigint,
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
    /** "verification" in DV-004C: a deterministic test result, never real content. */
    kind: text("kind").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    fence: bigint("fence", { mode: "number" }).notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    check("task_results_kind_check", sql`${t.kind} IN ('verification')`),
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
}
