ALTER TABLE "campaign_runs"
ADD COLUMN "campaign_request_hash" text;

--> statement-breakpoint
ALTER TABLE "run_product_snapshots"
ADD COLUMN "campaign_selection" jsonb;

--> statement-breakpoint
ALTER TABLE "run_product_snapshots"
ADD COLUMN "campaign_selection_checksum" text;

--> statement-breakpoint
ALTER TABLE "campaign_runs"
ADD CONSTRAINT "campaign_runs_request_hash_check" CHECK (
  (
    "campaign_runs"."campaign_request_hash" IS NOT NULL
  ) = ("campaign_runs"."workflow" = 'campaign-v1')
  AND (
    "campaign_runs"."campaign_request_hash" IS NULL
    OR "campaign_runs"."campaign_request_hash" ~ '^[0-9a-f]{64}$'
  )
);

--> statement-breakpoint
ALTER TABLE "run_product_snapshots"
ADD CONSTRAINT "run_product_snapshots_campaign_selection_check" CHECK (
  (
    "run_product_snapshots"."campaign_selection" IS NULL
  ) = (
    "run_product_snapshots"."campaign_selection_checksum" IS NULL
  )
  AND (
    "run_product_snapshots"."campaign_selection" IS NULL
    OR (
      jsonb_typeof("run_product_snapshots"."campaign_selection") = 'object'
      AND pg_column_size("run_product_snapshots"."campaign_selection") <= 4096
      AND "run_product_snapshots"."campaign_selection_checksum" ~ '^[0-9a-f]{64}$'
    )
  )
);

--> statement-breakpoint
CREATE FUNCTION deskverse_campaign_request_guard () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.campaign_request_hash IS NOT NULL OR NEW.campaign_request_hash IS NOT NULL)
    AND (OLD.id, OLD.ticket_id, OLD.ticket_version, OLD.workflow, OLD.mode, OLD.request_id, OLD.campaign_request_hash)
      IS DISTINCT FROM
        (NEW.id, NEW.ticket_id, NEW.ticket_version, NEW.workflow, NEW.mode, NEW.request_id, NEW.campaign_request_hash)
  THEN
    RAISE EXCEPTION 'Campaign launch identity and request hash are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE TRIGGER campaign_request_immutable
BEFORE UPDATE ON campaign_runs FOR EACH ROW
EXECUTE FUNCTION deskverse_campaign_request_guard ();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION deskverse_vera_pin_guard () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  campaign boolean;
  pinned boolean;
BEGIN
  SELECT r.workflow = 'campaign-v1' INTO campaign FROM campaign_runs r WHERE r.id = OLD.run_id;
  IF (campaign OR OLD.stage = 'vera.review') AND
    (NEW.id, NEW.stage, NEW.run_id, NEW.ticket_id, NEW.snapshot_id)
      IS DISTINCT FROM (OLD.id, OLD.stage, OLD.run_id, OLD.ticket_id, OLD.snapshot_id)
  THEN
    IF OLD.stage = 'vera.review' THEN
      RAISE EXCEPTION 'Vera task input pin is immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RAISE EXCEPTION 'Campaign task pin identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NOT campaign THEN
    IF OLD.stage = 'vera.review' AND NEW.params IS DISTINCT FROM OLD.params THEN
      RAISE EXCEPTION 'Vera task input pin is immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  pinned := CASE NEW.stage
    WHEN 'scout.research' THEN true
    WHEN 'quill.script' THEN NEW.params ?& ARRAY['reportId', 'reportVersion', 'reportChecksum']
    WHEN 'pixel.render' THEN NEW.params ? 'manifestChecksum'
    WHEN 'vera.review' THEN NEW.params ?& ARRAY['veraPin', 'ruleset']
    ELSE false
  END;

  IF NEW.params IS DISTINCT FROM OLD.params AND NOT (
    OLD.status = 'waiting_dependencies' AND NEW.status = OLD.status
    AND OLD.params = '{}'::jsonb AND OLD.stage <> 'scout.research' AND pinned
    AND EXISTS (
      SELECT 1 FROM task_dependencies d
      JOIN worker_tasks p ON p.id = d.depends_on_task_id AND p.run_id = d.run_id
      JOIN task_results x ON x.task_id = p.id AND x.run_id = p.run_id
      WHERE d.task_id = OLD.id AND d.run_id = OLD.run_id
        AND p.snapshot_id = OLD.snapshot_id AND p.ticket_id = OLD.ticket_id
        AND p.status = 'completed'
        AND x.kind = CASE OLD.stage
          WHEN 'quill.script' THEN 'scout_research'
          WHEN 'pixel.render' THEN 'quill_script'
          WHEN 'vera.review' THEN 'pixel_video'
        END
    )
  ) THEN
    RAISE EXCEPTION 'Campaign task input pin is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status IN ('queued', 'retry_wait', 'running', 'completed') AND NOT pinned THEN
    RAISE EXCEPTION 'Campaign task requires a durable input pin' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status = 'running' AND OLD.status <> 'running' AND NOT EXISTS (
    SELECT 1 FROM orchestrator_workers w
    WHERE w.worker_id = NEW.lease_owner AND 'campaign.handoffs' = ANY(w.stages)
      AND w.last_seen_at > now() - interval '15 seconds'
  ) THEN
    RAISE EXCEPTION 'Campaign task requires a compatible worker' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
