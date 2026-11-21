import path from "node:path"
import { configDefaults, defineConfig } from "vitest/config"

const alias = {
  "@": path.resolve(import.meta.dirname, "src"),
  // Next.js resolves the "server-only" marker itself (no package needed);
  // unit tests run server modules directly, so it maps to an empty module.
  "server-only": path.resolve(
    import.meta.dirname,
    "tests/stubs/server-only.ts",
  ),
}

export default defineConfig({
  resolve: { alias },
  test: {
    include: ["tests/**/*.test.ts"],
    // Real-FFmpeg tests run separately (yarn test:integration), and so do
    // real-PostgreSQL tests (yarn test:db): unit tests need neither.
    exclude: [...configDefaults.exclude, "tests/integration/**", "tests/db/**"],
    environment: "node",
  },
})
