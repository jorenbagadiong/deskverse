CREATE TABLE "quill_scene_claims" (
	"script_id" uuid NOT NULL,
	"scene_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"claim_key" text NOT NULL,
	"statement" text NOT NULL,
	"evidence_keys" text[] NOT NULL,
	"evidence" jsonb NOT NULL,
	CONSTRAINT "quill_scene_claims_pk" PRIMARY KEY("scene_id","claim_key"),
	CONSTRAINT "quill_scene_claims_size_check" CHECK (char_length("quill_scene_claims"."statement") BETWEEN 1 AND 500 AND cardinality("quill_scene_claims"."evidence_keys") BETWEEN 1 AND 20 AND pg_column_size("quill_scene_claims"."evidence") <= 8192)
);
--> statement-breakpoint
CREATE TABLE "quill_scenes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"script_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"scene_key" text NOT NULL,
	"kind" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"narration" text NOT NULL,
	"caption" text NOT NULL,
	"subtext" text,
	"visual" text NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "quill_scenes_id_script_unique" UNIQUE("id","script_id"),
	CONSTRAINT "quill_scenes_script_position_unique" UNIQUE("script_id","position"),
	CONSTRAINT "quill_scenes_position_check" CHECK ("quill_scenes"."position" BETWEEN 0 AND 7),
	CONSTRAINT "quill_scenes_key_check" CHECK ("quill_scenes"."scene_key" ~ '^scene-[1-8]$'),
	CONSTRAINT "quill_scenes_kind_check" CHECK ("quill_scenes"."kind" IN ('hook', 'benefit', 'call-to-action')),
	CONSTRAINT "quill_scenes_duration_check" CHECK ("quill_scenes"."duration_ms" BETWEEN 1990 AND 8010),
	CONSTRAINT "quill_scenes_text_check" CHECK (char_length("quill_scenes"."narration") BETWEEN 1 AND 400 AND char_length("quill_scenes"."caption") BETWEEN 1 AND 80 AND ("quill_scenes"."subtext" IS NULL OR char_length("quill_scenes"."subtext") <= 60) AND char_length("quill_scenes"."visual") <= 300),
	CONSTRAINT "quill_scenes_notes_check" CHECK (pg_column_size("quill_scenes"."notes") <= 2048)
);
--> statement-breakpoint
CREATE TABLE "quill_scripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"report_version" integer NOT NULL,
	"report_checksum" text NOT NULL,
	"snapshot_checksum" text NOT NULL,
	"script_version" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"generation_mode" text NOT NULL,
	"language" text NOT NULL,
	"platform" text NOT NULL,
	"status" text NOT NULL,
	"pixel_text_compatible" boolean NOT NULL,
	"render_ready" boolean NOT NULL,
	"fence" bigint NOT NULL,
	"checksum" text NOT NULL,
	"meta" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quill_scripts_task_id_unique" UNIQUE("task_id"),
	CONSTRAINT "quill_scripts_id_report_unique" UNIQUE("id","report_id"),
	CONSTRAINT "quill_scripts_product_version_unique" UNIQUE("product_id","script_version"),
	CONSTRAINT "quill_scripts_version_check" CHECK ("quill_scripts"."script_version" >= 1 AND "quill_scripts"."report_version" >= 1),
	CONSTRAINT "quill_scripts_schema_check" CHECK ("quill_scripts"."schema_version" = 1),
	CONSTRAINT "quill_scripts_mode_check" CHECK ("quill_scripts"."generation_mode" IN ('template', 'template+ollama')),
	CONSTRAINT "quill_scripts_language_check" CHECK ("quill_scripts"."language" = 'en'),
	CONSTRAINT "quill_scripts_platform_check" CHECK (char_length("platform") <= 40),
	CONSTRAINT "quill_scripts_status_check" CHECK ("quill_scripts"."status" = 'valid'),
	CONSTRAINT "quill_scripts_checksums_check" CHECK ("quill_scripts"."checksum" ~ '^[0-9a-f]{64}$' AND "quill_scripts"."report_checksum" ~ '^[0-9a-f]{64}$' AND "quill_scripts"."snapshot_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "quill_scripts_meta_check" CHECK (pg_column_size("quill_scripts"."meta") <= 131072)
);
--> statement-breakpoint
ALTER TABLE "task_results" DROP CONSTRAINT "task_results_kind_check";--> statement-breakpoint
ALTER TABLE "quill_scene_claims" ADD CONSTRAINT "quill_scene_claims_scene_fk" FOREIGN KEY ("scene_id","script_id") REFERENCES "public"."quill_scenes"("id","script_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quill_scene_claims" ADD CONSTRAINT "quill_scene_claims_script_fk" FOREIGN KEY ("script_id","report_id") REFERENCES "public"."quill_scripts"("id","report_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quill_scene_claims" ADD CONSTRAINT "quill_scene_claims_claim_fk" FOREIGN KEY ("report_id","claim_key") REFERENCES "public"."scout_claims"("report_id","key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quill_scenes" ADD CONSTRAINT "quill_scenes_script_id_quill_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."quill_scripts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quill_scripts" ADD CONSTRAINT "quill_scripts_report_id_scout_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."scout_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quill_scripts" ADD CONSTRAINT "quill_scripts_task_fk" FOREIGN KEY ("task_id","run_id") REFERENCES "public"."worker_tasks"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quill_scripts" ADD CONSTRAINT "quill_scripts_snapshot_fk" FOREIGN KEY ("snapshot_id","run_id") REFERENCES "public"."run_product_snapshots"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quill_scripts" ADD CONSTRAINT "quill_scripts_run_fk" FOREIGN KEY ("run_id","ticket_id") REFERENCES "public"."campaign_runs"("id","ticket_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quill_scene_claims_script_idx" ON "quill_scene_claims" USING btree ("script_id");--> statement-breakpoint
CREATE INDEX "quill_scripts_ticket_idx" ON "quill_scripts" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "quill_scripts_run_idx" ON "quill_scripts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "quill_scripts_report_idx" ON "quill_scripts" USING btree ("report_id");--> statement-breakpoint
ALTER TABLE "task_results" ADD CONSTRAINT "task_results_kind_check" CHECK ("task_results"."kind" IN ('verification', 'scout_research', 'quill_script'));--> statement-breakpoint
-- Hand-added (DV-005B): guarantees enforced by PostgreSQL itself.
-- 1. Scripts can never change or disappear once written.
CREATE TRIGGER "quill_scripts_immutable" BEFORE UPDATE OR DELETE ON "quill_scripts"
  FOR EACH ROW EXECUTE FUNCTION "deskverse_refuse_change"();--> statement-breakpoint
CREATE TRIGGER "quill_scenes_immutable" BEFORE UPDATE OR DELETE ON "quill_scenes"
  FOR EACH ROW EXECUTE FUNCTION "deskverse_refuse_change"();--> statement-breakpoint
CREATE TRIGGER "quill_scene_claims_immutable" BEFORE UPDATE OR DELETE ON "quill_scene_claims"
  FOR EACH ROW EXECUTE FUNCTION "deskverse_refuse_change"();--> statement-breakpoint
-- 2. A script is written only by the CURRENT lease holder of a running
--    quill.script task, for that task's own snapshot, product and ticket,
--    from the pinned Scout report of the same ticket and product, whose
--    checksum, version and snapshot checksum match.
CREATE FUNCTION "deskverse_quill_script_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "worker_tasks" t
      JOIN "run_product_snapshots" s ON s."id" = t."snapshot_id"
      JOIN "scout_reports" r ON r."id" = NEW."report_id"
     WHERE t."id" = NEW."task_id" AND t."run_id" = NEW."run_id" AND t."ticket_id" = NEW."ticket_id"
       AND t."stage" = 'quill.script' AND t."status" = 'running' AND t."fence" = NEW."fence"
       AND t."snapshot_id" = NEW."snapshot_id" AND s."product_id" = NEW."product_id"
       AND s."checksum" = NEW."snapshot_checksum"
       AND r."ticket_id" = NEW."ticket_id" AND r."product_id" = NEW."product_id"
       AND r."checksum" = NEW."report_checksum" AND r."report_version" = NEW."report_version"
       AND r."snapshot_checksum" = NEW."snapshot_checksum"
  ) THEN
    RAISE EXCEPTION 'quill script refused: not the current lease holder, or not the pinned report' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "quill_scripts_guard" BEFORE INSERT ON "quill_scripts"
  FOR EACH ROW EXECUTE FUNCTION "deskverse_quill_script_guard"();--> statement-breakpoint
-- 3. Scenes and claim links can only be added while the script's task is
--    still running under the same fence (the completing transaction).
CREATE FUNCTION "deskverse_quill_child_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "quill_scripts" q JOIN "worker_tasks" t ON t."id" = q."task_id"
     WHERE q."id" = NEW."script_id" AND t."status" = 'running' AND t."fence" = q."fence"
  ) THEN
    RAISE EXCEPTION '% refused: the script is already complete', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "quill_scenes_guard" BEFORE INSERT ON "quill_scenes"
  FOR EACH ROW EXECUTE FUNCTION "deskverse_quill_child_guard"();--> statement-breakpoint
CREATE TRIGGER "quill_scene_claims_guard" BEFORE INSERT ON "quill_scene_claims"
  FOR EACH ROW EXECUTE FUNCTION "deskverse_quill_child_guard"();--> statement-breakpoint
-- 4. Only promotable claims, with their own supporting evidence: supported,
--    no sensitive topic, not time-sensitive, not an identifier, no conflict
--    on the same attribute, and every evidence key a "supports" link of
--    that claim in that report.
CREATE FUNCTION "deskverse_quill_claim_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  claim "scout_claims"%ROWTYPE;
BEGIN
  SELECT * INTO claim FROM "scout_claims" WHERE "report_id" = NEW."report_id" AND "key" = NEW."claim_key";
  IF claim."id" IS NULL OR claim."status" <> 'supported' OR claim."topic" IS NOT NULL
     OR claim."time_sensitive" OR claim."kind" = 'identity' OR claim."statement" <> NEW."statement" THEN
    RAISE EXCEPTION 'quill claim refused: % is not a promotable supported claim', NEW."claim_key" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF claim."attribute" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "scout_claims" c WHERE c."report_id" = NEW."report_id" AND c."status" = 'conflicting'
       AND lower(c."attribute") = lower(claim."attribute")
  ) THEN
    RAISE EXCEPTION 'quill claim refused: % has a conflicting claim', NEW."claim_key" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(NEW."evidence_keys") AS k(key)
     WHERE NOT EXISTS (
       SELECT 1 FROM "scout_evidence" e JOIN "scout_claim_evidence" l ON l."evidence_id" = e."id"
        WHERE e."report_id" = NEW."report_id" AND e."key" = k.key
          AND l."claim_id" = claim."id" AND l."relationship" = 'supports')
  ) THEN
    RAISE EXCEPTION 'quill claim refused: evidence for % does not support it', NEW."claim_key" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "quill_scene_claims_eligible" BEFORE INSERT ON "quill_scene_claims"
  FOR EACH ROW EXECUTE FUNCTION "deskverse_quill_claim_guard"();--> statement-breakpoint
COMMENT ON TABLE "quill_scripts" IS 'Immutable Quill scripts (DV-005B), one per completed quill.script task, each pinned to one verified Scout report.';--> statement-breakpoint
COMMENT ON TABLE "quill_scene_claims" IS 'Which supported Scout claim and evidence each scene states; the database refuses ineligible claims.';
