import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"

/**
 * Deskverse database schema.
 *
 * DV-004A deliberately holds only an internal metadata table. It proves that
 * migrations, persistence, backup and restore work. Affiliate Ticket tables
 * arrive in DV-004B, each through a new versioned migration
 * (`yarn db:generate`), never by pushing schema changes directly.
 */

/** Small internal key/value facts about this database, e.g. when it was set up. */
export const appMetadata = pgTable("app_metadata", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const schema = { appMetadata }
