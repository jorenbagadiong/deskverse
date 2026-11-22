CREATE TABLE "campaign_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ticket_id" uuid NOT NULL,
  "ticket_version" integer NOT NULL,
  "request_id" text NOT NULL,
  "mode" text NOT NULL,
  "workflow" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "pause_requested_at" timestamp with time zone,
  "cancel_requested_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "campaign_runs_request_id_unique" UNIQUE ("request_id"),
  CONSTRAINT "campaign_runs_id_ticket_unique" UNIQUE ("id", "ticket_id"),
  CONSTRAINT "campaign_runs_mode_check" CHECK (
    "campaign_runs"."mode" IN ('production', 'verification')
  ),
  CONSTRAINT "campaign_runs_status_check" CHECK (
    "status" IN (
      'queued',
      'running',
      'pausing',
      'paused',
      'cancelling',
      'cancelled',
      'completed',
      'completed_with_errors',
      'failed'
    )
  ),
  CONSTRAINT "campaign_runs_version_check" CHECK ("campaign_runs"."ticket_version" >= 1),
  CONSTRAINT "campaign_runs_error_check" CHECK (
    "campaign_runs"."error" IS NULL
    OR char_length("campaign_runs"."error") <= 500
  ),
  CONSTRAINT "campaign_runs_finished_check" CHECK (
    ("finished_at" IS NULL) = (
      "status" IN (
        'queued',
        'running',
        'pausing',
        'paused',
        'cancelling'
      )
    )
  ),
  CONSTRAINT "campaign_runs_workflow_check" CHECK ("campaign_runs"."workflow" ~ '^[a-z0-9.-]{1,40}$')
);

--> statement-breakpoint
CREATE TABLE "run_events" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (
    sequence name "run_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START
    WITH
      1 CACHE 1
  ),
  "run_id" uuid NOT NULL,
  "task_id" uuid,
  "type" text NOT NULL,
  "request_id" text,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "run_events_request_unique" UNIQUE ("run_id", "request_id"),
  CONSTRAINT "run_events_type_check" CHECK (
    "run_events"."type" IN (
      'run_created',
      'run_started',
      'run_pause_requested',
      'run_paused',
      'run_resumed',
      'run_cancel_requested',
      'run_cancelled',
      'run_finished',
      'task_claimed',
      'task_completed',
      'task_retry_scheduled',
      'task_failed',
      'task_needs_input',
      'task_blocked',
      'task_unblocked',
      'task_cancelled',
      'task_lease_expired',
      'task_released',
      'task_retry_requested',
      'task_stale_result_refused'
    )
  ),
  CONSTRAINT "run_events_details_check" CHECK (pg_column_size("run_events"."details") <= 4096)
);

--> statement-breakpoint
CREATE TABLE "run_product_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "ticket_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "position" integer NOT NULL,
  "schema_version" integer NOT NULL,
  "data" jsonb NOT NULL,
  "checksum" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "run_product_snapshots_run_product_unique" UNIQUE ("run_id", "product_id"),
  CONSTRAINT "run_product_snapshots_id_run_unique" UNIQUE ("id", "run_id"),
  CONSTRAINT "run_product_snapshots_checksum_check" CHECK (
    "run_product_snapshots"."checksum" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "run_product_snapshots_size_check" CHECK (
    pg_column_size("run_product_snapshots"."data") <= 262144
  ),
  CONSTRAINT "run_product_snapshots_version_check" CHECK ("run_product_snapshots"."schema_version" >= 1)
);

--> statement-breakpoint
CREATE TABLE "task_attempts" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (
    sequence name "task_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START
    WITH
      1 CACHE 1
  ),
  "task_id" uuid NOT NULL,
  "attempt_number" integer NOT NULL,
  "worker_id" text NOT NULL,
  "fence" bigint NOT NULL,
  "outcome" text DEFAULT 'running' NOT NULL,
  "failure_message" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "duration_ms" integer,
  CONSTRAINT "task_attempts_task_number_unique" UNIQUE ("task_id", "attempt_number"),
  CONSTRAINT "task_attempts_task_fence_unique" UNIQUE ("task_id", "fence"),
  CONSTRAINT "task_attempts_outcome_check" CHECK (
    "task_attempts"."outcome" IN (
      'running',
      'succeeded',
      'transient_failure',
      'permanent_failure',
      'needs_input',
      'cancelled',
      'lease_expired',
      'released',
      'stale'
    )
  ),
  CONSTRAINT "task_attempts_worker_check" CHECK (char_length("task_attempts"."worker_id") <= 200),
  CONSTRAINT "task_attempts_message_check" CHECK (
    "task_attempts"."failure_message" IS NULL
    OR char_length("task_attempts"."failure_message") <= 500
  )
);

--> statement-breakpoint
CREATE TABLE "task_dependencies" (
  "run_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "depends_on_task_id" uuid NOT NULL,
  CONSTRAINT "task_dependencies_pk" PRIMARY KEY ("task_id", "depends_on_task_id"),
  CONSTRAINT "task_dependencies_self_check" CHECK (
    "task_dependencies"."task_id" <> "task_dependencies"."depends_on_task_id"
  )
);

--> statement-breakpoint
CREATE TABLE "task_results" (
  "task_id" uuid PRIMARY KEY NOT NULL,
  "run_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "schema_version" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "fence" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "task_results_kind_check" CHECK ("task_results"."kind" IN ('verification')),
  CONSTRAINT "task_results_size_check" CHECK (pg_column_size("task_results"."payload") <= 16384)
);

--> statement-breakpoint
CREATE TABLE "worker_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "ticket_id" uuid NOT NULL,
  "snapshot_id" uuid,
  "stage" text NOT NULL,
  "status" text NOT NULL,
  "resource_class" text NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "recovery_policy" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "params" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer NOT NULL,
  "eligible_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "fence" bigint DEFAULT 0 NOT NULL,
  "failure_kind" text,
  "failure_message" text,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "worker_tasks_idempotency_key_unique" UNIQUE ("idempotency_key"),
  CONSTRAINT "worker_tasks_id_run_unique" UNIQUE ("id", "run_id"),
  CONSTRAINT "worker_tasks_status_check" CHECK (
    "status" IN (
      'waiting_dependencies',
      'queued',
      'running',
      'retry_wait',
      'completed',
      'failed',
      'needs_input',
      'blocked',
      'cancelled'
    )
  ),
  CONSTRAINT "worker_tasks_resource_check" CHECK (
    "worker_tasks"."resource_class" IN ('general', 'cpu', 'render')
  ),
  CONSTRAINT "worker_tasks_recovery_check" CHECK (
    "worker_tasks"."recovery_policy" IN ('retry', 'inspect')
  ),
  CONSTRAINT "worker_tasks_stage_check" CHECK (
    "worker_tasks"."stage" ~ '^[a-z][a-z0-9-]*[.][a-z][a-z0-9-]*$'
  ),
  CONSTRAINT "worker_tasks_attempts_check" CHECK (
    "worker_tasks"."attempts" >= 0
    AND "worker_tasks"."max_attempts" BETWEEN 1 AND 10
  ),
  CONSTRAINT "worker_tasks_lease_check" CHECK (
    ("worker_tasks"."status" = 'running') = (
      "worker_tasks"."lease_owner" IS NOT NULL
      AND "worker_tasks"."lease_expires_at" IS NOT NULL
    )
  ),
  CONSTRAINT "worker_tasks_failure_check" CHECK (
    "worker_tasks"."failure_kind" IS NULL
    OR "worker_tasks"."failure_kind" IN (
      'transient',
      'permanent',
      'needs_input',
      'lease_expired',
      'exhausted',
      'cancelled',
      'blocked'
    )
  ),
  CONSTRAINT "worker_tasks_message_check" CHECK (
    "worker_tasks"."failure_message" IS NULL
    OR char_length("worker_tasks"."failure_message") <= 500
  ),
  CONSTRAINT "worker_tasks_params_check" CHECK (pg_column_size("worker_tasks"."params") <= 4096)
);

--> statement-breakpoint
ALTER TABLE "campaign_runs"
ADD CONSTRAINT "campaign_runs_ticket_id_affiliate_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."affiliate_tickets" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

--> statement-breakpoint
ALTER TABLE "run_events"
ADD CONSTRAINT "run_events_run_id_campaign_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."campaign_runs" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

--> statement-breakpoint
ALTER TABLE "run_product_snapshots"
ADD CONSTRAINT "run_product_snapshots_run_fk" FOREIGN KEY ("run_id", "ticket_id") REFERENCES "public"."campaign_runs" ("id", "ticket_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

--> statement-breakpoint
ALTER TABLE "task_attempts"
ADD CONSTRAINT "task_attempts_task_id_worker_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."worker_tasks" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

--> statement-breakpoint
ALTER TABLE "task_dependencies"
ADD CONSTRAINT "task_dependencies_task_fk" FOREIGN KEY ("task_id", "run_id") REFERENCES "public"."worker_tasks" ("id", "run_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

--> statement-breakpoint
ALTER TABLE "task_dependencies"
ADD CONSTRAINT "task_dependencies_prerequisite_fk" FOREIGN KEY ("depends_on_task_id", "run_id") REFERENCES "public"."worker_tasks" ("id", "run_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

--> statement-breakpoint
ALTER TABLE "task_results"
ADD CONSTRAINT "task_results_task_id_worker_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."worker_tasks" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

--> statement-breakpoint
ALTER TABLE "worker_tasks"
ADD CONSTRAINT "worker_tasks_run_fk" FOREIGN KEY ("run_id", "ticket_id") REFERENCES "public"."campaign_runs" ("id", "ticket_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

--> statement-breakpoint
ALTER TABLE "worker_tasks"
ADD CONSTRAINT "worker_tasks_snapshot_fk" FOREIGN KEY ("snapshot_id", "run_id") REFERENCES "public"."run_product_snapshots" ("id", "run_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_runs_one_active_idx" ON "campaign_runs" USING btree ("ticket_id")
WHERE
  "status" IN (
    'queued',
    'running',
    'pausing',
    'paused',
    'cancelling'
  );

--> statement-breakpoint
CREATE INDEX "campaign_runs_ticket_created_idx" ON "campaign_runs" USING btree ("ticket_id", "created_at");

--> statement-breakpoint
CREATE INDEX "campaign_runs_status_idx" ON "campaign_runs" USING btree ("status");

--> statement-breakpoint
CREATE INDEX "run_events_run_idx" ON "run_events" USING btree ("run_id", "id");

--> statement-breakpoint
CREATE INDEX "run_product_snapshots_product_idx" ON "run_product_snapshots" USING btree ("product_id");

--> statement-breakpoint
CREATE INDEX "task_attempts_task_idx" ON "task_attempts" USING btree ("task_id");

--> statement-breakpoint
CREATE INDEX "task_dependencies_prerequisite_idx" ON "task_dependencies" USING btree ("depends_on_task_id");

--> statement-breakpoint
CREATE INDEX "task_results_run_idx" ON "task_results" USING btree ("run_id");

--> statement-breakpoint
CREATE INDEX "worker_tasks_claim_idx" ON "worker_tasks" USING btree ("status", "resource_class", "eligible_at");

--> statement-breakpoint
CREATE INDEX "worker_tasks_lease_idx" ON "worker_tasks" USING btree ("lease_expires_at");

--> statement-breakpoint
CREATE INDEX "worker_tasks_run_idx" ON "worker_tasks" USING btree ("run_id", "status");

--> statement-breakpoint
CREATE INDEX "worker_tasks_snapshot_idx" ON "worker_tasks" USING btree ("snapshot_id");

--> statement-breakpoint
-- Hand-added (DV-004C): guarantees enforced by PostgreSQL itself.
-- 1. Frozen inputs and committed results can never change or disappear.
CREATE FUNCTION "deskverse_refuse_change" () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

--> statement-breakpoint
CREATE TRIGGER "run_product_snapshots_immutable"
BEFORE UPDATE OR DELETE ON "run_product_snapshots" FOR EACH ROW
EXECUTE FUNCTION "deskverse_refuse_change" ();

--> statement-breakpoint
CREATE TRIGGER "task_results_immutable"
BEFORE UPDATE OR DELETE ON "task_results" FOR EACH ROW
EXECUTE FUNCTION "deskverse_refuse_change" ();

--> statement-breakpoint
CREATE TRIGGER "task_dependencies_immutable"
BEFORE UPDATE OR DELETE ON "task_dependencies" FOR EACH ROW
EXECUTE FUNCTION "deskverse_refuse_change" ();

--> statement-breakpoint
-- 2. A dependency edge may not close a cycle: refused if the prerequisite
--    already (transitively) depends on the dependent task.
CREATE FUNCTION "deskverse_refuse_dependency_cycle" () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE upstream(id) AS (
      SELECT d."depends_on_task_id" FROM "task_dependencies" d WHERE d."task_id" = NEW."depends_on_task_id"
      UNION
      SELECT d."depends_on_task_id" FROM "task_dependencies" d JOIN upstream u ON d."task_id" = u.id
    )
    SELECT 1 FROM upstream WHERE id = NEW."task_id"
  ) THEN
    RAISE EXCEPTION 'task dependency would create a cycle' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE TRIGGER "task_dependencies_acyclic"
BEFORE INSERT ON "task_dependencies" FOR EACH ROW
EXECUTE FUNCTION "deskverse_refuse_dependency_cycle" ();

--> statement-breakpoint
COMMENT ON TABLE "campaign_runs" IS 'Orchestrator runs (DV-004C). Worker output never changes owner-input tables.';

--> statement-breakpoint
COMMENT ON TABLE "run_product_snapshots" IS 'Immutable inputs frozen when a run is created.';

--> statement-breakpoint
COMMENT ON TABLE "task_results" IS 'One committed result per task. DV-004C results are deterministic verification results, not real content.';
