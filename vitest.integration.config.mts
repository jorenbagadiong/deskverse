import path from "node:path"
import { defineConfig } from "vitest/config"

/**
 * Real FFmpeg integration tests (yarn test:integration). Kept out of
 * `yarn test` so unit tests never need FFmpeg installed. Same aliases as
 * vitest.config.mts.
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
    include: ["tests/integration/**/*.integration.test.ts"],
    environment: "node",
    testTimeout: 5 * 60_000,
    hookTimeout: 60_000,
  },
})
