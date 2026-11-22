CREATE TABLE "pixel_deliverables" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "render_job_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "ticket_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "script_id" uuid NOT NULL,
  "script_version" integer NOT NULL,
  "script_checksum" text NOT NULL,
  "deliverable_version" integer NOT NULL,
  "pixel_job_id" text NOT NULL,
  "sha256" text NOT NULL,
  "byte_size" bigint NOT NULL,
  "width" integer NOT NULL,
  "height" integer NOT NULL,
  "duration_ms" integer NOT NULL,
  "fps" integer NOT NULL,
  "video_codec" text NOT NULL,
  "pixel_format" text NOT NULL,
  "audio" boolean NOT NULL,
  "encoder" text NOT NULL,
  "disclosure_verified" boolean NOT NULL,
  "checks" jsonb NOT NULL,
  "status" text NOT NULL,
  "fence" bigint NOT NULL,
  "verified_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pixel_deliverables_task_id_unique" UNIQUE ("task_id"),
  CONSTRAINT "pixel_deliverables_pixel_job_id_unique" UNIQUE ("pixel_job_id"),
  CONSTRAINT "pixel_deliverables_product_version_unique" UNIQUE ("product_id", "deliverable_version"),
  CONSTRAINT "pixel_deliverables_version_check" CHECK ("pixel_deliverables"."deliverable_version" >= 1),
  CONSTRAINT "pixel_deliverables_sha_check" CHECK (
    "pixel_deliverables"."sha256" ~ '^[0-9a-f]{64}$'
    AND "pixel_deliverables"."script_checksum" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "pixel_deliverables_job_check" CHECK (
    "pixel_deliverables"."pixel_job_id" ~ '^job_[0-9a-f]{32}$'
  ),
  CONSTRAINT "pixel_deliverables_format_check" CHECK (
    "pixel_deliverables"."width" = 1080
    AND "pixel_deliverables"."height" = 1920
    AND "pixel_deliverables"."fps" = 30
    AND "pixel_deliverables"."video_codec" = 'h264'
    AND "pixel_deliverables"."pixel_format" = 'yuv420p'
    AND NOT "pixel_deliverables"."audio"
    AND "pixel_deliverables"."duration_ms" BETWEEN 14900 AND 30100
    AND "pixel_deliverables"."byte_size" > 0
  ),
  CONSTRAINT "pixel_deliverables_disclosure_check" CHECK ("pixel_deliverables"."disclosure_verified"),
  CONSTRAINT "pixel_deliverables_status_check" CHECK (
    "pixel_deliverables"."status" = 'technically_verified_awaiting_qa'
  ),
  CONSTRAINT "pixel_deliverables_checks_check" CHECK (
    pg_column_size("pixel_deliverables"."checks") <= 8192
    AND char_length("pixel_deliverables"."encoder") <= 40
  )
);

--> statement-breakpoint
CREATE TABLE "pixel_render_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "ticket_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "snapshot_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "script_id" uuid NOT NULL,
  "script_version" integer NOT NULL,
  "script_checksum" text NOT NULL,
  "report_id" uuid NOT NULL,
  "report_version" integer NOT NULL,
  "report_checksum" text NOT NULL,
  "snapshot_checksum" text NOT NULL,
  "asset_ids" UUID[] NOT NULL,
  "asset_sha256" TEXT[] NOT NULL,
  "rights_acknowledged" boolean NOT NULL,
  "render_config" text NOT NULL,
  "manifest_checksum" text NOT NULL,
  "state" text DEFAULT 'planned' NOT NULL,
  "pixel_job_id" text,
  "attempt_fence" bigint,
  "progress" jsonb,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pixel_render_jobs_task_id_unique" UNIQUE ("task_id"),
  CONSTRAINT "pixel_render_jobs_id_task_unique" UNIQUE ("id", "task_id"),
  CONSTRAINT "pixel_render_jobs_assets_check" CHECK (
    cardinality("pixel_render_jobs"."asset_ids") BETWEEN 3 AND 6
    AND cardinality("pixel_render_jobs"."asset_sha256") = cardinality("pixel_render_jobs"."asset_ids")
  ),
  CONSTRAINT "pixel_render_jobs_checksums_check" CHECK (
    "pixel_render_jobs"."script_checksum" ~ '^[0-9a-f]{64}$'
    AND "pixel_render_jobs"."report_checksum" ~ '^[0-9a-f]{64}$'
    AND "pixel_render_jobs"."snapshot_checksum" ~ '^[0-9a-f]{64}$'
    AND "pixel_render_jobs"."manifest_checksum" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "pixel_render_jobs_config_check" CHECK (
    "pixel_render_jobs"."render_config" = 'pixel-ticket-render/1'
  ),
  CONSTRAINT "pixel_render_jobs_state_check" CHECK (
    "pixel_render_jobs"."state" IN (
      'planned',
      'waiting_for_renderer',
      'rendering',
      'verifying',
      'completed',
      'failed',
      'cancelled'
    )
  ),
  CONSTRAINT "pixel_render_jobs_job_check" CHECK (
    "pixel_render_jobs"."pixel_job_id" IS NULL
    OR "pixel_render_jobs"."pixel_job_id" ~ '^job_[0-9a-f]{32}$'
  ),
  CONSTRAINT "pixel_render_jobs_text_check" CHECK (
    (
      "pixel_render_jobs"."error" IS NULL
      OR char_length("pixel_render_jobs"."error") <= 500
    )
    AND (
      "pixel_render_jobs"."progress" IS NULL
      OR pg_column_size("pixel_render_jobs"."progress") <= 1024
    )
  )
);

--> statement-breakpoint
ALTER TABLE "task_results"
DROP CONSTRAINT "task_results_kind_check";

--> statement-breakpoint
ALTER TABLE "pixel_deliverables"
ADD CONSTRAINT "pixel_deliverables_render_job_fk" FOREIGN KEY ("render_job_id", "task_id") REFERENCES "public"."pixel_render_jobs" ("id", "task_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

--> statement-breakpoint
ALTER TABLE "pixel_deliverables"
ADD CONSTRAINT "pixel_deliverables_run_fk" FOREIGN KEY ("run_id", "ticket_id") REFERENCES "public"."campaign_runs" ("id", "ticket_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

--> statement-breakpoint
ALTER TABLE "pixel_render_jobs"
ADD CONSTRAINT "pixel_render_jobs_script_id_quill_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."quill_scripts" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

--> statement-breakpoint
ALTER TABLE "pixel_render_jobs"
ADD CONSTRAINT "pixel_render_jobs_task_fk" FOREIGN KEY ("task_id", "run_id") REFERENCES "public"."worker_tasks" ("id", "run_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

--> statement-breakpoint
ALTER TABLE "pixel_render_jobs"
ADD CONSTRAINT "pixel_render_jobs_snapshot_fk" FOREIGN KEY ("snapshot_id", "run_id") REFERENCES "public"."run_product_snapshots" ("id", "run_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

--> statement-breakpoint
ALTER TABLE "pixel_render_jobs"
ADD CONSTRAINT "pixel_render_jobs_run_fk" FOREIGN KEY ("run_id", "ticket_id") REFERENCES "public"."campaign_runs" ("id", "ticket_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

--> statement-breakpoint
CREATE INDEX "pixel_deliverables_ticket_idx" ON "pixel_deliverables" USING btree ("ticket_id", "created_at");

--> statement-breakpoint
CREATE INDEX "pixel_render_jobs_ticket_idx" ON "pixel_render_jobs" USING btree ("ticket_id", "created_at");

--> statement-breakpoint
CREATE INDEX "pixel_render_jobs_run_idx" ON "pixel_render_jobs" USING btree ("run_id");

--> statement-breakpoint
ALTER TABLE "task_results"
ADD CONSTRAINT "task_results_kind_check" CHECK (
  "task_results"."kind" IN (
    'verification',
    'scout_research',
    'quill_script',
    'pixel_video'
  )
);

--> statement-breakpoint
-- Hand-added (DV-005C): guarantees enforced by PostgreSQL itself.
-- 1. Finished videos can never change or disappear.
CREATE TRIGGER "pixel_deliverables_immutable"
BEFORE UPDATE OR DELETE ON "pixel_deliverables" FOR EACH ROW
EXECUTE FUNCTION "deskverse_refuse_change" ();

--> statement-breakpoint
-- 2. A render job's pinned manifest is fixed when the run is planned; only
--    its state columns may change, and render jobs are never deleted.
CREATE FUNCTION "deskverse_pixel_manifest_guard" () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pixel render jobs are never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW."id", NEW."run_id", NEW."ticket_id", NEW."task_id", NEW."snapshot_id", NEW."product_id", NEW."script_id",
      NEW."script_version", NEW."script_checksum", NEW."report_id", NEW."report_version", NEW."report_checksum",
      NEW."snapshot_checksum", NEW."asset_ids", NEW."asset_sha256", NEW."rights_acknowledged", NEW."render_config",
      NEW."manifest_checksum", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."run_id", OLD."ticket_id", OLD."task_id", OLD."snapshot_id", OLD."product_id", OLD."script_id",
      OLD."script_version", OLD."script_checksum", OLD."report_id", OLD."report_version", OLD."report_checksum",
      OLD."snapshot_checksum", OLD."asset_ids", OLD."asset_sha256", OLD."rights_acknowledged", OLD."render_config",
      OLD."manifest_checksum", OLD."created_at") THEN
    RAISE EXCEPTION 'pixel render manifest is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE TRIGGER "pixel_render_jobs_manifest"
BEFORE UPDATE OR DELETE ON "pixel_render_jobs" FOR EACH ROW
EXECUTE FUNCTION "deskverse_pixel_manifest_guard" ();

--> statement-breakpoint
-- 3. A deliverable is written only by the CURRENT lease holder of a running
--    pixel.render task, for that task's own render job and pinned script.
CREATE FUNCTION "deskverse_pixel_deliverable_guard" () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "worker_tasks" t JOIN "pixel_render_jobs" j ON j."task_id" = t."id"
     WHERE t."id" = NEW."task_id" AND t."run_id" = NEW."run_id" AND t."ticket_id" = NEW."ticket_id"
       AND t."stage" = 'pixel.render' AND t."status" = 'running' AND t."fence" = NEW."fence"
       AND j."id" = NEW."render_job_id" AND j."product_id" = NEW."product_id"
       AND j."script_id" = NEW."script_id" AND j."script_version" = NEW."script_version"
       AND j."script_checksum" = NEW."script_checksum"
  ) THEN
    RAISE EXCEPTION 'pixel deliverable refused: not the current lease holder of this render task' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE TRIGGER "pixel_deliverables_guard"
BEFORE INSERT ON "pixel_deliverables" FOR EACH ROW
EXECUTE FUNCTION "deskverse_pixel_deliverable_guard" ();

--> statement-breakpoint
-- 4. Render jobs belong to pixel.render tasks only.
CREATE FUNCTION "deskverse_pixel_render_job_guard" () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "worker_tasks" t WHERE t."id" = NEW."task_id" AND t."run_id" = NEW."run_id" AND t."stage" = 'pixel.render'
       AND t."snapshot_id" = NEW."snapshot_id"
  ) THEN
    RAISE EXCEPTION 'pixel render job refused: not a pixel.render task' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE TRIGGER "pixel_render_jobs_guard"
BEFORE INSERT ON "pixel_render_jobs" FOR EACH ROW
EXECUTE FUNCTION "deskverse_pixel_render_job_guard" ();

--> statement-breakpoint
COMMENT ON TABLE "pixel_render_jobs" IS 'Pixel ticket renders (DV-005C): an immutable pinned manifest plus mutable render state.';

--> statement-breakpoint
COMMENT ON TABLE "pixel_deliverables" IS 'Immutable, technically verified ticket videos awaiting Vera QA (DV-005C). The MP4 lives in <data>/ticket-renders.';
