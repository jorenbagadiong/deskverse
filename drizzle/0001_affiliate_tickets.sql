CREATE TABLE "affiliate_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "affiliate_tickets_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"platform" text DEFAULT 'tiktok' NOT NULL,
	"publishing_preferences" jsonb DEFAULT '{"schedule":"","notes":""}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"create_request_id" text,
	"ready_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_tickets_number_unique" UNIQUE("number"),
	CONSTRAINT "affiliate_tickets_create_request_id_unique" UNIQUE("create_request_id"),
	CONSTRAINT "affiliate_tickets_title_check" CHECK (char_length(btrim("affiliate_tickets"."title")) BETWEEN 3 AND 120),
	CONSTRAINT "affiliate_tickets_description_check" CHECK (char_length("description") <= 5000),
	CONSTRAINT "affiliate_tickets_instructions_check" CHECK (char_length("instructions") <= 5000),
	CONSTRAINT "affiliate_tickets_priority_check" CHECK ("affiliate_tickets"."priority" IN ('low', 'normal', 'high')),
	CONSTRAINT "affiliate_tickets_platform_check" CHECK ("affiliate_tickets"."platform" IN ('tiktok', 'instagram_reels', 'youtube_shorts', 'other')),
	CONSTRAINT "affiliate_tickets_status_check" CHECK ("affiliate_tickets"."status" IN ('draft', 'ready', 'archived')),
	CONSTRAINT "affiliate_tickets_preferences_check" CHECK (jsonb_typeof("affiliate_tickets"."publishing_preferences") = 'object'),
	CONSTRAINT "affiliate_tickets_version_check" CHECK ("affiliate_tickets"."version" >= 1),
	CONSTRAINT "affiliate_tickets_archived_check" CHECK (("affiliate_tickets"."status" = 'archived') = ("affiliate_tickets"."archived_at" IS NOT NULL)),
	CONSTRAINT "affiliate_tickets_ready_check" CHECK (("affiliate_tickets"."status" = 'ready') = ("affiliate_tickets"."ready_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ticket_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"mime_type" text NOT NULL,
	"extension" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"duration_ms" integer,
	"original_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_assets_kind_check" CHECK (("ticket_assets"."kind" = 'image' AND "ticket_assets"."mime_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "ticket_assets"."duration_ms" IS NULL)
        OR ("ticket_assets"."kind" = 'video' AND "ticket_assets"."mime_type" = 'video/mp4' AND "ticket_assets"."duration_ms" IS NOT NULL)),
	CONSTRAINT "ticket_assets_extension_check" CHECK (("ticket_assets"."mime_type", "ticket_assets"."extension") IN (('image/jpeg', 'jpg'), ('image/png', 'png'), ('image/webp', 'webp'), ('video/mp4', 'mp4'))),
	CONSTRAINT "ticket_assets_size_check" CHECK ("ticket_assets"."byte_size" > 0),
	CONSTRAINT "ticket_assets_sha256_check" CHECK ("ticket_assets"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ticket_assets_dimensions_check" CHECK ("ticket_assets"."width" > 0 AND "ticket_assets"."height" > 0),
	CONSTRAINT "ticket_assets_duration_check" CHECK ("ticket_assets"."duration_ms" IS NULL OR "ticket_assets"."duration_ms" > 0),
	CONSTRAINT "ticket_assets_name_check" CHECK (char_length("original_name") <= 255)
);
--> statement-breakpoint
CREATE TABLE "ticket_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ticket_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ticket_id" uuid NOT NULL,
	"product_id" uuid,
	"asset_id" uuid,
	"type" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_events_type_check" CHECK ("ticket_events"."type" IN ('ticket_created', 'ticket_edited', 'product_added', 'product_updated', 'product_moved', 'product_removed', 'asset_uploaded', 'asset_removed', 'marked_ready', 'returned_to_draft', 'archived', 'restored')),
	CONSTRAINT "ticket_events_details_check" CHECK (jsonb_typeof("ticket_events"."details") = 'object')
);
--> statement-breakpoint
CREATE TABLE "ticket_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"affiliate_url" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"specifications" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"media_rights" text DEFAULT 'unspecified' NOT NULL,
	"media_rights_note" text DEFAULT '' NOT NULL,
	"create_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_products_create_request_id_unique" UNIQUE("create_request_id"),
	CONSTRAINT "ticket_products_id_ticket_unique" UNIQUE("id","ticket_id"),
	CONSTRAINT "ticket_products_position_check" CHECK ("ticket_products"."position" >= 0),
	CONSTRAINT "ticket_products_name_check" CHECK (char_length("name") <= 120),
	CONSTRAINT "ticket_products_affiliate_url_check" CHECK (char_length("affiliate_url") <= 2048),
	CONSTRAINT "ticket_products_description_check" CHECK (char_length("description") <= 5000),
	CONSTRAINT "ticket_products_specifications_check" CHECK (char_length("specifications") <= 5000),
	CONSTRAINT "ticket_products_notes_check" CHECK (char_length("notes") <= 5000),
	CONSTRAINT "ticket_products_source_check" CHECK (char_length("source") <= 500),
	CONSTRAINT "ticket_products_media_rights_check" CHECK ("ticket_products"."media_rights" IN ('unspecified', 'owned', 'licensed', 'permission', 'affiliate_program')),
	CONSTRAINT "ticket_products_media_rights_note_check" CHECK (char_length("media_rights_note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "ticket_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_references_product_url_unique" UNIQUE("product_id","url"),
	CONSTRAINT "ticket_references_kind_check" CHECK ("ticket_references"."kind" IN ('listing', 'manufacturer', 'review', 'demo_video', 'other')),
	CONSTRAINT "ticket_references_url_check" CHECK (char_length("ticket_references"."url") <= 2048 AND "ticket_references"."url" ~ '^https?://'),
	CONSTRAINT "ticket_references_label_check" CHECK (char_length("label") <= 200)
);
--> statement-breakpoint
ALTER TABLE "ticket_assets" ADD CONSTRAINT "ticket_assets_product_fk" FOREIGN KEY ("product_id","ticket_id") REFERENCES "public"."ticket_products"("id","ticket_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_affiliate_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."affiliate_tickets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_products" ADD CONSTRAINT "ticket_products_ticket_id_affiliate_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."affiliate_tickets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_references" ADD CONSTRAINT "ticket_references_product_fk" FOREIGN KEY ("product_id","ticket_id") REFERENCES "public"."ticket_products"("id","ticket_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "affiliate_tickets_status_updated_idx" ON "affiliate_tickets" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "affiliate_tickets_updated_idx" ON "affiliate_tickets" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "ticket_assets_product_idx" ON "ticket_assets" USING btree ("product_id","position");--> statement-breakpoint
CREATE INDEX "ticket_assets_ticket_idx" ON "ticket_assets" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_events_ticket_idx" ON "ticket_events" USING btree ("ticket_id","created_at","id");--> statement-breakpoint
CREATE INDEX "ticket_products_ticket_position_idx" ON "ticket_products" USING btree ("ticket_id","position");--> statement-breakpoint
CREATE INDEX "ticket_references_product_idx" ON "ticket_references" USING btree ("product_id","position");--> statement-breakpoint
-- Hand-added (DV-004B): document the owner-input rule in the database itself.
COMMENT ON TABLE "affiliate_tickets" IS 'Affiliate Tickets: the owner''s requests. Owner input only; worker output goes to separate tables.';--> statement-breakpoint
COMMENT ON TABLE "ticket_products" IS 'Products in a ticket, exactly as the owner supplied them. Workers never update these rows.';--> statement-breakpoint
COMMENT ON TABLE "ticket_references" IS 'Owner-supplied reference links. Stored only; never fetched by DV-004B.';--> statement-breakpoint
COMMENT ON TABLE "ticket_assets" IS 'Owner-uploaded media. Files live at <data dir>/tickets/<ticket_id>/assets/<id>.<extension>.';--> statement-breakpoint
COMMENT ON TABLE "ticket_events" IS 'Activity history, written in the same transaction as each change.';
