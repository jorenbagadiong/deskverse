CREATE TABLE "app_metadata" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Hand-added (DV-004A): records when this database was first set up, so
-- persistence across restarts, backups and restores can be checked.
INSERT INTO "app_metadata" ("key", "value")
VALUES ('database.initialized', jsonb_build_object('milestone', 'DV-004A'))
ON CONFLICT ("key") DO NOTHING;
