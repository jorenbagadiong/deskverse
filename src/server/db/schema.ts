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
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core"

import type { PublishingPreferences } from "@/lib/tickets/types"

/**
 * Deskverse database schema.
 *
 * Every change goes through a new versioned migration (`yarn db:generate`,
 * review the SQL, `yarn db:migrate`), never by pushing schema changes.
 *
 * DV-004A: app_metadata. DV-004B: Affiliate Tickets.
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

export const schema = {
  appMetadata,
  affiliateTickets,
  ticketProducts,
  ticketReferences,
  ticketAssets,
  ticketEvents,
}
