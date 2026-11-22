CREATE TABLE "vera_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"rule_id" text NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"outcome" text NOT NULL,
	"scene_id" text,
	"evidence" jsonb NOT NULL,
	CONSTRAINT "vera_findings_position_unique" UNIQUE("review_id","position"),
	CONSTRAINT "vera_findings_position_check" CHECK ("vera_findings"."position" BETWEEN 0 AND 255),
	CONSTRAINT "vera_findings_outcome_check" CHECK ("vera_findings"."outcome" IN ('passed','failed','warning','manual_review_required','not_evaluated')),
	CONSTRAINT "vera_findings_severity_check" CHECK ("vera_findings"."severity" IN ('info','warning','revision','owner','fatal')),
	CONSTRAINT "vera_findings_size_check" CHECK (pg_column_size("vera_findings"."evidence") <= 16384 AND char_length("vera_findings"."rule_id") <= 100)
);
--> statement-breakpoint
CREATE TABLE "vera_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"deliverable_id" uuid NOT NULL,
	"deliverable_version" integer NOT NULL,
	"deliverable_sha256" text NOT NULL,
	"review_version" integer NOT NULL,
	"ruleset" text NOT NULL,
	"verdict" text NOT NULL,
	"checksum" text NOT NULL,
	"document" jsonb NOT NULL,
	"fence" bigint NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "vera_reviews_task_id_unique" UNIQUE("task_id"),
	CONSTRAINT "vera_reviews_version_unique" UNIQUE("deliverable_id","review_version"),
	CONSTRAINT "vera_reviews_version_check" CHECK ("vera_reviews"."review_version" >= 1 AND "vera_reviews"."deliverable_version" >= 1),
	CONSTRAINT "vera_reviews_ruleset_check" CHECK ("vera_reviews"."ruleset" = 'vera-rules/1'),
	CONSTRAINT "vera_reviews_verdict_check" CHECK ("vera_reviews"."verdict" IN ('pass', 'needs_revision', 'needs_owner_input', 'failed')),
	CONSTRAINT "vera_reviews_checksum_check" CHECK ("vera_reviews"."checksum" ~ '^[0-9a-f]{64}$' AND "vera_reviews"."deliverable_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "vera_reviews_document_check" CHECK (pg_column_size("vera_reviews"."document") <= 65536)
);
--> statement-breakpoint
ALTER TABLE "task_results" DROP CONSTRAINT "task_results_kind_check";--> statement-breakpoint
ALTER TABLE "vera_findings" ADD CONSTRAINT "vera_findings_review_id_vera_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."vera_reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vera_reviews" ADD CONSTRAINT "vera_reviews_deliverable_id_pixel_deliverables_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."pixel_deliverables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vera_reviews" ADD CONSTRAINT "vera_reviews_task_fk" FOREIGN KEY ("task_id","run_id") REFERENCES "public"."worker_tasks"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vera_reviews" ADD CONSTRAINT "vera_reviews_ticket_fk" FOREIGN KEY ("run_id","ticket_id") REFERENCES "public"."campaign_runs"("id","ticket_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vera_reviews_ticket_idx" ON "vera_reviews" USING btree ("ticket_id","completed_at");--> statement-breakpoint
ALTER TABLE "task_results" ADD CONSTRAINT "task_results_kind_check" CHECK ("task_results"."kind" IN ('verification', 'scout_research', 'quill_script', 'pixel_video', 'vera_review'));--> statement-breakpoint
-- Immutable assessment and ordered findings, inserted only in a fenced completion transaction.
CREATE TRIGGER vera_reviews_immutable BEFORE UPDATE OR DELETE ON vera_reviews
  FOR EACH ROW EXECUTE FUNCTION deskverse_refuse_change();
--> statement-breakpoint
CREATE TRIGGER vera_findings_immutable BEFORE UPDATE OR DELETE ON vera_findings
  FOR EACH ROW EXECUTE FUNCTION deskverse_refuse_change();
--> statement-breakpoint
CREATE FUNCTION deskverse_vera_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM worker_tasks t
      JOIN run_product_snapshots s ON s.id = t.snapshot_id AND s.run_id = t.run_id
      JOIN pixel_deliverables d ON d.id = NEW.deliverable_id
      JOIN pixel_render_jobs j ON j.id=d.render_job_id
      JOIN run_product_snapshots original ON original.id=j.snapshot_id
    WHERE t.id = NEW.task_id AND t.run_id = NEW.run_id AND t.ticket_id = NEW.ticket_id
      AND t.stage = 'vera.review' AND t.status = 'running' AND t.fence = NEW.fence
      AND t.lease_expires_at > clock_timestamp()
      AND s.product_id = NEW.product_id AND d.product_id = NEW.product_id AND d.ticket_id = NEW.ticket_id
      AND d.deliverable_version = NEW.deliverable_version AND d.sha256 = NEW.deliverable_sha256
      AND NEW.document->'pin' = t.params->'veraPin'
      AND NEW.document->>'taskId' = t.id::text AND NEW.document->>'runId' = t.run_id::text
      AND NEW.document->>'format' = 'vera-review/1' AND NEW.document->>'ruleset' = NEW.ruleset
      AND NEW.document->>'verdict' = NEW.verdict
      AND NEW.document->'pin'->>'deliverableId' = d.id::text
      AND NEW.document->'pin'->>'productId' = d.product_id::text
      AND NEW.document->'pin'->>'ticketId' = d.ticket_id::text
      AND NEW.document->'pin'->>'sha256' = d.sha256
      AND NEW.document->'pin'->>'deliverableVersion' = d.deliverable_version::text
      AND NEW.document->'pin'->>'renderJobId' = j.id::text
      AND NEW.document->'pin'->>'sourceSnapshotId' = original.id::text
      AND NEW.document->'pin'->>'manifestChecksum' = j.manifest_checksum
      AND NEW.document->'pin'->'manifest'->'script'->>'id' = d.script_id::text
      AND NEW.document->'pin'->'manifest'->'script'->>'version' = d.script_version::text
      AND NEW.document->'pin'->'manifest'->'script'->>'checksum' = d.script_checksum
      AND NEW.document->'pin'->'manifest'->'report'->>'id' = j.report_id::text
      AND NEW.document->'pin'->'manifest'->'report'->>'version' = j.report_version::text
      AND NEW.document->'pin'->'manifest'->'report'->>'checksum' = j.report_checksum
      AND NEW.document->'pin'->'manifest'->>'snapshotChecksum' = original.checksum
      AND NEW.document->'pin'->>'mediaRights' = coalesce(original.data->'product'->>'mediaRights','unspecified')
      AND NEW.document->'pin'->>'mediaRightsNote' = coalesce(original.data->'product'->>'mediaRightsNote','')
      AND NEW.document->'pin'->>'rightsAcknowledged' = j.rights_acknowledged::text
  ) THEN RAISE EXCEPTION 'Vera review refused: ownership, pin or current lease does not match'
    USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER vera_reviews_guard BEFORE INSERT ON vera_reviews
  FOR EACH ROW EXECUTE FUNCTION deskverse_vera_review_guard();
--> statement-breakpoint
CREATE FUNCTION deskverse_vera_finding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vera_reviews r JOIN worker_tasks t ON t.id = r.task_id
    WHERE r.id = NEW.review_id AND t.status = 'running' AND t.fence = r.fence
      AND t.lease_expires_at > clock_timestamp()
      AND NEW.evidence->>'deliverableId' = r.deliverable_id::text
      AND NEW.evidence->>'ruleset' = r.ruleset
      AND NEW.evidence->>'ruleId' = NEW.rule_id
      AND NEW.evidence->>'category' = NEW.category
      AND NEW.evidence->>'severity' = NEW.severity
      AND NEW.evidence->>'outcome' = NEW.outcome
      AND (NEW.evidence->>'sceneId') IS NOT DISTINCT FROM NEW.scene_id
  ) THEN RAISE EXCEPTION 'Vera finding refused: review is completed or evidence does not match'
    USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER vera_findings_guard BEFORE INSERT ON vera_findings
  FOR EACH ROW EXECUTE FUNCTION deskverse_vera_finding_guard();
--> statement-breakpoint
CREATE FUNCTION deskverse_vera_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM worker_tasks t JOIN task_results x ON x.task_id = t.id
    WHERE t.id = NEW.task_id AND t.status = 'completed' AND x.kind = 'vera_review'
      AND x.fence = NEW.fence AND x.payload->>'reviewId' = NEW.id::text
      AND x.payload->>'checksum' = NEW.checksum
      AND (SELECT count(*) FROM vera_findings f WHERE f.review_id = NEW.id) = (NEW.document->>'findingCount')::int
      AND (NEW.document->>'findingCount')::int BETWEEN 1 AND 256
  ) THEN RAISE EXCEPTION 'Vera review and task completion must be atomic, with all findings'
    USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NULL;
END; $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER vera_reviews_completion AFTER INSERT ON vera_reviews
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION deskverse_vera_completion_guard();
--> statement-breakpoint
-- A review task's chosen source stays pinned across retries, cancellation and recovery.
CREATE FUNCTION deskverse_vera_pin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.stage = 'vera.review' AND
    (NEW.id, NEW.stage, NEW.run_id, NEW.ticket_id, NEW.snapshot_id, NEW.params)
      IS DISTINCT FROM (OLD.id, OLD.stage, OLD.run_id, OLD.ticket_id, OLD.snapshot_id, OLD.params)
  THEN RAISE EXCEPTION 'Vera task input pin is immutable' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER vera_task_pin_immutable BEFORE UPDATE ON worker_tasks
  FOR EACH ROW EXECUTE FUNCTION deskverse_vera_pin_guard();
