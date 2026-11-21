import { defineConfig } from "drizzle-kit"

/**
 * drizzle-kit configuration (DV-004A), used for `yarn db:generate`, which
 * turns changes in src/server/db/schema.ts into a new versioned SQL file in
 * drizzle/. Review the SQL, then apply it with `yarn db:migrate`.
 *
 * Generating needs no database connection, so no credentials appear here.
 * Deskverse deliberately doesn't use `drizzle-kit push` (it changes a live
 * schema without a migration file).
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
})
