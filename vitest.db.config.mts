import path from "node:path"
import { defineConfig } from "vitest/config"

/**
 * Real PostgreSQL tests (yarn test:db, DV-004A). Kept out of `yarn test` so
 * unit tests never need a database.
 *
 * They only ever use DATABASE_TEST_URL (from the environment or .env.local):
 * tests/db/setup.ts removes DATABASE_URL from the test process, and every
 * test works in its own scratch database (deskverse_test_<label>_<pid>_<rand>)
 * that it creates and drops, so parallel files can't collide. Without
 * DATABASE_TEST_URL the run FAILS rather than skipping, so it can't be
 * mistaken for a pass.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(
        import.meta.dirname,
        "tests/stubs/server-only.ts",
      ),
    },
  },
  test: {
    include: ["tests/db/**/*.db.test.ts"],
    setupFiles: ["tests/db/setup.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
