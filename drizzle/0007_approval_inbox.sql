ALTER TABLE "vera_reviews"
ADD CONSTRAINT "vera_reviews_approval_pin_unique" UNIQUE (
  "id",
  "ticket_id",
  "product_id",
  "deliverable_id",
  "deliverable_version",
  "deliverable_sha256",
  "review_version",
  "checksum"
);

--> statement-breakpoint
CREATE TABLE "approval_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ticket_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "deliverable_id" uuid NOT NULL,
  "deliverable_version" integer NOT NULL,
  "deliverable_sha256" text NOT NULL,
  "review_id" uuid NOT NULL,
  "review_version" integer NOT NULL,
  "review_checksum" text NOT NULL,
  "kind" text NOT NULL,
  "contract" text NOT NULL,
  "policy" text NOT NULL,
  "checklist" jsonb,
  "notes" text NOT NULL,
  "reason" text NOT NULL,
  "revision" jsonb,
  "previous_id" uuid,
  "request_id" uuid NOT NULL,
  "request_hash" text NOT NULL,
  "eligibility_at_decision" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "approval_decisions_request_id_unique" UNIQUE ("request_id"),
  CONSTRAINT "approval_decisions_deliverable_id_unique" UNIQUE ("deliverable_id", "id"),
  CONSTRAINT "approval_decisions_previous_unique" UNIQUE ("deliverable_id", "previous_id"),
  CONSTRAINT "approval_decisions_kind_check" CHECK (
    "approval_decisions"."kind" IN (
      'approved',
      'revision_requested',
      'rejected',
      'withdrawn'
    )
  ),
  CONSTRAINT "approval_decisions_contract_check" CHECK (
    "approval_decisions"."contract" = 'approval-decision/1'
  ),
  CONSTRAINT "approval_decisions_policy_check" CHECK (
    "approval_decisions"."policy" = 'approval-policy/1'
  ),
  CONSTRAINT "approval_decisions_notes_check" CHECK (char_length("approval_decisions"."notes") <= 2000),
  CONSTRAINT "approval_decisions_reason_check" CHECK (
    char_length("approval_decisions"."reason") <= 2000
    AND (
      "approval_decisions"."kind" = 'approved'
      OR length(btrim("approval_decisions"."reason")) > 0
    )
  ),
  CONSTRAINT "approval_decisions_revision_check" CHECK (
    (
      (
        "approval_decisions"."kind" = 'revision_requested'
      ) = ("approval_decisions"."revision" IS NOT NULL)
    )
    AND (
      "approval_decisions"."revision" IS NULL
      OR (
        pg_column_size("approval_decisions"."revision") <= 16384
        AND jsonb_typeof("approval_decisions"."revision") = 'object'
      )
    )
  ),
  CONSTRAINT "approval_decisions_previous_self_check" CHECK (
    "approval_decisions"."previous_id" <> "approval_decisions"."id"
  ),
  CONSTRAINT "approval_decisions_receipt_check" CHECK (
    jsonb_typeof("approval_decisions"."eligibility_at_decision") = 'object'
    AND pg_column_size("approval_decisions"."eligibility_at_decision") <= 8192
  ),
  CONSTRAINT "approval_decisions_request_hash_check" CHECK (
    "approval_decisions"."request_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "approval_decisions_checklist_check" CHECK (
    (
      ("approval_decisions"."kind" = 'approved') = ("approval_decisions"."checklist" IS NOT NULL)
    )
    AND (
      "approval_decisions"."checklist" IS NULL
      OR "approval_decisions"."checklist" = '{"watched":true,"imagery":true,"presentation":true,"claims":true,"disclosure":true,"rights":true,"affiliate":true}'::jsonb
    )
  )
);

--> statement-breakpoint
ALTER TABLE "approval_decisions"
ADD CONSTRAINT "approval_decisions_deliverable_id_pixel_deliverables_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."pixel_deliverables" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

--> statement-breakpoint
ALTER TABLE "approval_decisions"
ADD CONSTRAINT "approval_decisions_previous_fk" FOREIGN KEY ("deliverable_id", "previous_id") REFERENCES "public"."approval_decisions" ("deliverable_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

--> statement-breakpoint
ALTER TABLE "approval_decisions"
ADD CONSTRAINT "approval_decisions_review_pin_fk" FOREIGN KEY (
  "review_id",
  "ticket_id",
  "product_id",
  "deliverable_id",
  "deliverable_version",
  "deliverable_sha256",
  "review_version",
  "review_checksum"
) REFERENCES "public"."vera_reviews" (
  "id",
  "ticket_id",
  "product_id",
  "deliverable_id",
  "deliverable_version",
  "deliverable_sha256",
  "review_version",
  "checksum"
) ON DELETE RESTRICT ON UPDATE NO ACTION;

--> statement-breakpoint
CREATE UNIQUE INDEX "approval_decisions_root_unique" ON "approval_decisions" USING btree ("deliverable_id")
WHERE
  "approval_decisions"."previous_id" IS NULL;

--> statement-breakpoint
CREATE INDEX "approval_decisions_history_idx" ON "approval_decisions" USING btree (
  "deliverable_id",
  "created_at" DESC NULLS LAST,
  "id" DESC NULLS LAST
);

--> statement-breakpoint
CREATE FUNCTION deskverse_approval_previous_guard () RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.previous_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM approval_decisions a WHERE a.id = NEW.previous_id AND a.deliverable_id = NEW.deliverable_id
  ) THEN
    RAISE EXCEPTION 'Prior decision must already exist for this video' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE TRIGGER approval_decisions_previous_guard
BEFORE INSERT ON approval_decisions FOR EACH ROW
EXECUTE FUNCTION deskverse_approval_previous_guard ();

--> statement-breakpoint
CREATE TRIGGER approval_decisions_immutable
BEFORE UPDATE OR DELETE ON approval_decisions FOR EACH ROW
EXECUTE FUNCTION deskverse_refuse_change ();

--> statement-breakpoint
CREATE TRIGGER approval_decisions_no_truncate
BEFORE TRUNCATE ON approval_decisions FOR EACH STATEMENT
EXECUTE FUNCTION deskverse_refuse_change ();
