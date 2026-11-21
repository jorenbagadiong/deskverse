CREATE TABLE "orchestrator_workers" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"pid" integer NOT NULL,
	"stages" text[] NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "orchestrator_workers_id_check" CHECK (char_length("orchestrator_workers"."worker_id") <= 200),
	CONSTRAINT "orchestrator_workers_stages_check" CHECK (cardinality("orchestrator_workers"."stages") <= 20)
);
--> statement-breakpoint
CREATE TABLE "scout_claim_evidence" (
	"report_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"relationship" text NOT NULL,
	CONSTRAINT "scout_claim_evidence_pk" PRIMARY KEY("claim_id","evidence_id"),
	CONSTRAINT "scout_claim_evidence_relationship_check" CHECK ("scout_claim_evidence"."relationship" IN ('supports', 'contradicts', 'context'))
);
--> statement-breakpoint
CREATE TABLE "scout_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"key" text NOT NULL,
	"origin" text NOT NULL,
	"kind" text NOT NULL,
	"attribute" text,
	"value" text,
	"statement" text NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"topic" text,
	"time_sensitive" boolean NOT NULL,
	CONSTRAINT "scout_claims_id_report_unique" UNIQUE("id","report_id"),
	CONSTRAINT "scout_claims_report_key_unique" UNIQUE("report_id","key"),
	CONSTRAINT "scout_claims_key_check" CHECK ("scout_claims"."key" ~ '^C[0-9]{1,3}$'),
	CONSTRAINT "scout_claims_origin_check" CHECK ("scout_claims"."origin" IN ('owner', 'source')),
	CONSTRAINT "scout_claims_kind_check" CHECK ("scout_claims"."kind" IN ('attribute', 'statement', 'identity')),
	CONSTRAINT "scout_claims_status_check" CHECK ("scout_claims"."status" IN ('supported', 'conflicting', 'unverified', 'insufficient_evidence')),
	CONSTRAINT "scout_claims_text_check" CHECK (char_length("scout_claims"."statement") BETWEEN 1 AND 500 AND char_length("scout_claims"."reason") <= 300 AND ("scout_claims"."attribute" IS NULL OR char_length("scout_claims"."attribute") <= 80) AND ("scout_claims"."value" IS NULL OR char_length("scout_claims"."value") <= 200)),
	CONSTRAINT "scout_claims_topic_check" CHECK ("scout_claims"."topic" IS NULL OR "scout_claims"."topic" IN ('price', 'discount', 'commission', 'rating', 'performance', 'health', 'certification', 'warranty', 'delivery', 'stock', 'superiority')),
	CONSTRAINT "scout_claims_source_status_check" CHECK ("scout_claims"."origin" = 'owner' OR "scout_claims"."status" IN ('supported', 'conflicting'))
);
--> statement-breakpoint
CREATE TABLE "scout_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"key" text NOT NULL,
	"method" text NOT NULL,
	"location" text NOT NULL,
	"passage" text NOT NULL,
	"statement" text NOT NULL,
	"attribute" text,
	"value" text,
	"model" text,
	CONSTRAINT "scout_evidence_id_report_unique" UNIQUE("id","report_id"),
	CONSTRAINT "scout_evidence_report_key_unique" UNIQUE("report_id","key"),
	CONSTRAINT "scout_evidence_key_check" CHECK ("scout_evidence"."key" ~ '^E[0-9]{1,3}$'),
	CONSTRAINT "scout_evidence_method_check" CHECK ("scout_evidence"."method" IN ('json-ld', 'html-meta', 'html-table', 'html-list', 'html-text', 'text-plain', 'ollama')),
	CONSTRAINT "scout_evidence_location_check" CHECK (char_length("location") <= 200),
	CONSTRAINT "scout_evidence_passage_check" CHECK (char_length("scout_evidence"."passage") BETWEEN 1 AND 600),
	CONSTRAINT "scout_evidence_statement_check" CHECK (char_length("statement") <= 300),
	CONSTRAINT "scout_evidence_fields_check" CHECK (("scout_evidence"."attribute" IS NULL OR char_length("scout_evidence"."attribute") <= 80) AND ("scout_evidence"."value" IS NULL OR char_length("scout_evidence"."value") <= 200) AND ("scout_evidence"."model" IS NULL OR char_length("scout_evidence"."model") <= 120)),
	CONSTRAINT "scout_evidence_model_check" CHECK (("scout_evidence"."method" = 'ollama') = ("scout_evidence"."model" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "scout_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"report_version" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"status" text NOT NULL,
	"extraction_mode" text NOT NULL,
	"fence" bigint NOT NULL,
	"snapshot_checksum" text NOT NULL,
	"checksum" text NOT NULL,
	"brief" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scout_reports_task_id_unique" UNIQUE("task_id"),
	CONSTRAINT "scout_reports_product_version_unique" UNIQUE("product_id","report_version"),
	CONSTRAINT "scout_reports_version_check" CHECK ("scout_reports"."report_version" >= 1),
	CONSTRAINT "scout_reports_schema_check" CHECK ("scout_reports"."schema_version" = 1),
	CONSTRAINT "scout_reports_status_check" CHECK ("scout_reports"."status" IN ('complete', 'insufficient_evidence')),
	CONSTRAINT "scout_reports_extraction_check" CHECK ("scout_reports"."extraction_mode" IN ('deterministic', 'deterministic+ollama')),
	CONSTRAINT "scout_reports_checksum_check" CHECK ("scout_reports"."checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "scout_reports_snapshot_checksum_check" CHECK ("scout_reports"."snapshot_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "scout_reports_brief_check" CHECK (pg_column_size("scout_reports"."brief") <= 131072)
);
--> statement-breakpoint
CREATE TABLE "scout_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"key" text NOT NULL,
	"position" integer NOT NULL,
	"reference_kind" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"requested_url" text NOT NULL,
	"final_url" text,
	"title" text,
	"outcome" text NOT NULL,
	"http_status" integer,
	"content_type" text,
	"byte_count" integer DEFAULT 0 NOT NULL,
	"content_sha256" text,
	"retrieved_at" timestamp with time zone,
	"trust" text NOT NULL,
	"identified" boolean NOT NULL,
	"transport" text,
	"detail" text,
	CONSTRAINT "scout_sources_id_report_unique" UNIQUE("id","report_id"),
	CONSTRAINT "scout_sources_report_key_unique" UNIQUE("report_id","key"),
	CONSTRAINT "scout_sources_key_check" CHECK ("scout_sources"."key" ~ '^S[0-9]{1,2}$'),
	CONSTRAINT "scout_sources_position_check" CHECK ("scout_sources"."position" BETWEEN 0 AND 99),
	CONSTRAINT "scout_sources_kind_check" CHECK ("scout_sources"."reference_kind" IN ('listing', 'manufacturer', 'review', 'demo_video', 'other')),
	CONSTRAINT "scout_sources_label_check" CHECK (char_length("label") <= 200),
	CONSTRAINT "scout_sources_url_check" CHECK (char_length("scout_sources"."requested_url") <= 2048 AND ("scout_sources"."final_url" IS NULL OR char_length("scout_sources"."final_url") <= 2048)),
	CONSTRAINT "scout_sources_title_check" CHECK ("scout_sources"."title" IS NULL OR char_length("scout_sources"."title") <= 300),
	CONSTRAINT "scout_sources_outcome_check" CHECK ("outcome" IN ('ok', 'invalid_url', 'blocked_address', 'dns_failed', 'robots_disallowed', 'robots_unavailable', 'redirect_refused', 'too_many_redirects', 'login_required', 'paywall', 'captcha', 'forbidden', 'not_found', 'rate_limited', 'server_error', 'http_error', 'timeout', 'network_error', 'unsupported_type', 'too_large', 'javascript_required', 'product_mismatch', 'no_content', 'affiliate_link_skipped', 'not_attempted')),
	CONSTRAINT "scout_sources_status_check" CHECK ("scout_sources"."http_status" IS NULL OR "scout_sources"."http_status" BETWEEN 100 AND 599),
	CONSTRAINT "scout_sources_type_check" CHECK ("scout_sources"."content_type" IS NULL OR char_length("scout_sources"."content_type") <= 100),
	CONSTRAINT "scout_sources_bytes_check" CHECK ("scout_sources"."byte_count" BETWEEN 0 AND 20971520),
	CONSTRAINT "scout_sources_sha_check" CHECK ("scout_sources"."content_sha256" IS NULL OR "scout_sources"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "scout_sources_trust_check" CHECK ("scout_sources"."trust" IN ('manufacturer', 'seller_listing', 'independent_review', 'unknown')),
	CONSTRAINT "scout_sources_transport_check" CHECK ("scout_sources"."transport" IS NULL OR "scout_sources"."transport" IN ('https', 'http')),
	CONSTRAINT "scout_sources_detail_check" CHECK ("scout_sources"."detail" IS NULL OR char_length("scout_sources"."detail") <= 300),
	CONSTRAINT "scout_sources_read_check" CHECK (("scout_sources"."outcome" = 'ok') = "scout_sources"."identified" AND ("scout_sources"."content_sha256" IS NULL OR "scout_sources"."retrieved_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "task_results" DROP CONSTRAINT "task_results_kind_check";--> statement-breakpoint
ALTER TABLE "scout_claim_evidence" ADD CONSTRAINT "scout_claim_evidence_claim_fk" FOREIGN KEY ("claim_id","report_id") REFERENCES "public"."scout_claims"("id","report_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scout_claim_evidence" ADD CONSTRAINT "scout_claim_evidence_evidence_fk" FOREIGN KEY ("evidence_id","report_id") REFERENCES "public"."scout_evidence"("id","report_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scout_claims" ADD CONSTRAINT "scout_claims_report_id_scout_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."scout_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scout_evidence" ADD CONSTRAINT "scout_evidence_source_fk" FOREIGN KEY ("source_id","report_id") REFERENCES "public"."scout_sources"("id","report_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scout_reports" ADD CONSTRAINT "scout_reports_task_fk" FOREIGN KEY ("task_id","run_id") REFERENCES "public"."worker_tasks"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scout_reports" ADD CONSTRAINT "scout_reports_snapshot_fk" FOREIGN KEY ("snapshot_id","run_id") REFERENCES "public"."run_product_snapshots"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scout_reports" ADD CONSTRAINT "scout_reports_run_fk" FOREIGN KEY ("run_id","ticket_id") REFERENCES "public"."campaign_runs"("id","ticket_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scout_sources" ADD CONSTRAINT "scout_sources_report_id_scout_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."scout_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scout_claim_evidence_evidence_idx" ON "scout_claim_evidence" USING btree ("evidence_id");--> statement-breakpoint
CREATE INDEX "scout_claims_report_idx" ON "scout_claims" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "scout_evidence_report_idx" ON "scout_evidence" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "scout_reports_ticket_idx" ON "scout_reports" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "scout_reports_run_idx" ON "scout_reports" USING btree ("run_id");--> statement-breakpoint
ALTER TABLE "task_results" ADD CONSTRAINT "task_results_kind_check" CHECK ("task_results"."kind" IN ('verification', 'scout_research'));--> statement-breakpoint
-- Hand-added (DV-005A): guarantees enforced by PostgreSQL itself.
-- 1. Research records can never change or disappear once written.
CREATE TRIGGER "scout_reports_immutable" BEFORE UPDATE OR DELETE ON "scout_reports"
  FOR EACH ROW EXECUTE FUNCTION "deskverse_refuse_change"();--> statement-breakpoint
CREATE TRIGGER "scout_sources_immutable" BEFORE UPDATE OR DELETE ON "scout_sources"
  FOR EACH ROW EXECUTE FUNCTION "deskverse_refuse_change"();--> statement-breakpoint
CREATE TRIGGER "scout_evidence_immutable" BEFORE UPDATE OR DELETE ON "scout_evidence"
  FOR EACH ROW EXECUTE FUNCTION "deskverse_refuse_change"();--> statement-breakpoint
CREATE TRIGGER "scout_claims_immutable" BEFORE UPDATE OR DELETE ON "scout_claims"
  FOR EACH ROW EXECUTE FUNCTION "deskverse_refuse_change"();--> statement-breakpoint
CREATE TRIGGER "scout_claim_evidence_immutable" BEFORE UPDATE OR DELETE ON "scout_claim_evidence"
  FOR EACH ROW EXECUTE FUNCTION "deskverse_refuse_change"();--> statement-breakpoint
-- 2. A report is written only by the CURRENT lease holder of a running
--    scout.research task, for that task's own snapshot, product and ticket.
--    A stale worker (older fence) or a finished task is refused.
CREATE FUNCTION "deskverse_scout_report_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "worker_tasks" t
      JOIN "run_product_snapshots" s ON s."id" = t."snapshot_id"
     WHERE t."id" = NEW."task_id" AND t."run_id" = NEW."run_id" AND t."ticket_id" = NEW."ticket_id"
       AND t."stage" = 'scout.research' AND t."status" = 'running' AND t."fence" = NEW."fence"
       AND t."snapshot_id" = NEW."snapshot_id" AND s."product_id" = NEW."product_id"
       AND s."checksum" = NEW."snapshot_checksum"
  ) THEN
    RAISE EXCEPTION 'scout report refused: not the current lease holder of this research task' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "scout_reports_guard" BEFORE INSERT ON "scout_reports"
  FOR EACH ROW EXECUTE FUNCTION "deskverse_scout_report_guard"();--> statement-breakpoint
-- 3. Sources, evidence and claims can only be added while the report's
--    task is still running under the same fence (i.e. in the transaction
--    that completes it), never appended to a finished report later.
CREATE FUNCTION "deskverse_scout_child_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "scout_reports" r JOIN "worker_tasks" t ON t."id" = r."task_id"
     WHERE r."id" = NEW."report_id" AND t."status" = 'running' AND t."fence" = r."fence"
  ) THEN
    RAISE EXCEPTION '% refused: the research report is already complete', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "scout_sources_guard" BEFORE INSERT ON "scout_sources"
  FOR EACH ROW EXECUTE FUNCTION "deskverse_scout_child_guard"();--> statement-breakpoint
CREATE TRIGGER "scout_evidence_guard" BEFORE INSERT ON "scout_evidence"
  FOR EACH ROW EXECUTE FUNCTION "deskverse_scout_child_guard"();--> statement-breakpoint
CREATE TRIGGER "scout_claims_guard" BEFORE INSERT ON "scout_claims"
  FOR EACH ROW EXECUTE FUNCTION "deskverse_scout_child_guard"();--> statement-breakpoint
CREATE TRIGGER "scout_claim_evidence_guard" BEFORE INSERT ON "scout_claim_evidence"
  FOR EACH ROW EXECUTE FUNCTION "deskverse_scout_child_guard"();--> statement-breakpoint
COMMENT ON TABLE "scout_reports" IS 'Immutable Scout research briefs (DV-005A), one per completed scout.research task. Owner-input tables are never changed by Scout.';--> statement-breakpoint
COMMENT ON TABLE "scout_sources" IS 'Retrieval outcome per reference. Page bodies are not stored; only metadata and a content checksum.';--> statement-breakpoint
COMMENT ON TABLE "scout_evidence" IS 'Short cited passages (<= 600 characters) or structured-data fragments.';--> statement-breakpoint
COMMENT ON TABLE "orchestrator_workers" IS 'Recent worker check-ins (DV-005A), informational only.';
