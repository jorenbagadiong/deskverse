import os from "node:os"
import path from "node:path"

import { defineConfig } from "@playwright/test"

import { readEnvFile } from "./src/server/db/env-file"

/**
 * End-to-end tests for the critical office workflows (see e2e/).
 *
 * Local-first: by default the suite builds the app and serves the production
 * build on port 3210, and uses your installed Google Chrome (no browser
 * download). Overrides:
 *   E2E_BASE_URL=http://localhost:3000  reuse an already running server
 *   E2E_CHANNEL=chromium                use Playwright's bundled Chromium
 *                                       (after `yarn playwright install chromium`)
 *   E2E_DATABASE=1                      for tests that write to the database:
 *                                       always starts a fresh server on its
 *                                       own port, never reuses one, and
 *                                       refuses E2E_BASE_URL
 *
 * Database (DV-004A): the server the suite starts never sees your
 * development DATABASE_URL. It gets the test database (DATABASE_TEST_URL,
 * from the environment or .env.local) as its DATABASE_URL, or an empty
 * value, which also stops Next.js loading DATABASE_URL from .env.local.
 * A reused or external server (E2E_BASE_URL) may be using any database, so
 * a test that changes database data must run with E2E_DATABASE=1.
 */
const databaseTests = process.env.E2E_DATABASE === "1"
if (databaseTests && process.env.E2E_BASE_URL)
  throw new Error(
    "E2E_DATABASE=1 tests start their own server on the test database; unset E2E_BASE_URL.",
  )
const PORT = databaseTests ? 3211 : 3210
const testDatabaseUrl =
  process.env.DATABASE_TEST_URL || readEnvFile().DATABASE_TEST_URL || ""
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`
const channel =
  process.env.E2E_CHANNEL === "chromium"
    ? undefined
    : (process.env.E2E_CHANNEL ?? "chrome")

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // WebGL scenes are GPU-heavy; keep parallelism modest.
  workers: 2,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    channel,
    trace: "retain-on-failure",
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `yarn build && yarn start --port ${PORT}`,
        url: `${baseURL}/office`,
        reuseExistingServer: !databaseTests,
        timeout: 300_000,
        // Renders made by the tests go to a throwaway folder, never to your
        // real Deskverse data directory.
        env: {
          DESKVERSE_DATA_DIR: path.join(os.tmpdir(), "deskverse-e2e-data"),
          DATABASE_URL: testDatabaseUrl,
          DATABASE_TEST_URL: "",
        },
      },
  projects: [
    {
      name: "desktop",
      use: { viewport: { width: 1280, height: 900 } },
      testIgnore: /(fallback|mobile)\.spec/,
    },
    {
      name: "mobile-375",
      use: {
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
      },
      testMatch: /mobile\.spec/,
    },
    {
      name: "mobile-360",
      use: {
        viewport: { width: 360, height: 740 },
        isMobile: true,
        hasTouch: true,
      },
      testMatch: /mobile\.spec/,
    },
    {
      name: "no-webgl",
      use: {
        viewport: { width: 1280, height: 900 },
        launchOptions: {
          args: ["--disable-3d-apis", "--disable-webgl", "--disable-gpu"],
        },
      },
      testMatch: /fallback\.spec/,
    },
  ],
})
