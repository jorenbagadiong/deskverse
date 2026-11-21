import os from "node:os"
import path from "node:path"

import { defineConfig } from "@playwright/test"

/**
 * End-to-end tests for the critical office workflows (see e2e/).
 *
 * Local-first: by default the suite builds the app and serves the production
 * build on port 3210, and uses your installed Google Chrome (no browser
 * download). Overrides:
 *   E2E_BASE_URL=http://localhost:3000  reuse an already running server
 *   E2E_CHANNEL=chromium                use Playwright's bundled Chromium
 *                                       (after `yarn playwright install chromium`)
 */
const PORT = 3210
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
        reuseExistingServer: true,
        timeout: 300_000,
        // Renders made by the tests go to a throwaway folder, never to your
        // real Deskverse data directory.
        env: {
          DESKVERSE_DATA_DIR: path.join(os.tmpdir(), "deskverse-e2e-data"),
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
