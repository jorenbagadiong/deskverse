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
 *   E2E_DATABASE=1                      the database-writing suite (yarn
 *                                       test:e2e:db): a fresh server on a
 *                                       scratch database, never reused, and
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

/**
 * The suites are separate on purpose:
 * - ordinary (default): every spec except the Affiliate Ticket specs, on a
 *   server that may be reused and only ever reads the test database;
 * - database (E2E_DATABASE=1, `yarn test:e2e:db`): only the Affiliate
 *   Ticket specs (e2e/tickets*.spec.ts), which write data, on a fresh
 *   server with its own scratch database and media folder
 *   (scripts/e2e/database-server.ts). Never reused, never E2E_BASE_URL.
 */
const TICKET_SPECS = /tickets(-mobile|-keyboard|-workflow)?\.spec\.ts$/
/** Never matches: a project with nothing to run in this suite. */
const NOTHING = /^$/
const only = (ordinary: RegExp, database: RegExp) =>
  databaseTests
    ? { testMatch: database }
    : { testMatch: ordinary, testIgnore: TICKET_SPECS }

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // WebGL scenes are GPU-heavy; keep parallelism modest. The database suite
  // runs one test at a time: its tests restart the shared server.
  workers: databaseTests ? 1 : 2,
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
    : databaseTests
      ? {
          command:
            "yarn build && yarn tsx --import ./scripts/server-only-hook.mjs scripts/e2e/database-server.ts",
          url: `${baseURL}/tickets`,
          reuseExistingServer: false,
          timeout: 300_000,
          // Lets the wrapper drop its scratch database and media folder.
          gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
          env: { E2E_APP_PORT: String(PORT), E2E_CONTROL_PORT: "3212" },
        }
      : {
          command: `yarn build && yarn start --port ${PORT}`,
          url: `${baseURL}/office`,
          reuseExistingServer: true,
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
      ...only(
        /^(?!.*(fallback|mobile)\.spec).*\.spec\.ts$/,
        /tickets(-keyboard|-workflow)?\.spec\.ts$/,
      ),
    },
    {
      name: "mobile-375",
      use: {
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
      },
      ...only(/mobile\.spec/, /tickets-mobile\.spec\.ts$/),
    },
    {
      name: "mobile-360",
      use: {
        viewport: { width: 360, height: 740 },
        isMobile: true,
        hasTouch: true,
      },
      ...only(/mobile\.spec/, /tickets-mobile\.spec\.ts$/),
    },
    {
      name: "no-webgl",
      use: {
        viewport: { width: 1280, height: 900 },
        launchOptions: {
          args: ["--disable-3d-apis", "--disable-webgl", "--disable-gpu"],
        },
      },
      ...only(/fallback\.spec/, NOTHING),
    },
  ],
})
