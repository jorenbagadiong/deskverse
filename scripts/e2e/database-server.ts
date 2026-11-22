import { spawn, type ChildProcess } from "node:child_process"
import { promises as fs } from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import pg from "pg"

import { startFixtureSites, type FixtureSites } from "../scout/fixture-sites"

import { parseDatabaseUrl, type DatabaseConfig } from "@/server/db/config"
import { readEnvFile } from "@/server/db/env-file"
import { journal } from "@/server/db/journal"
import { migrationsFolder, runMigrations } from "@/server/db/migrations"
import { createPool } from "@/server/db/pool"
import {
  assertTestDatabase,
  isScratchDatabaseName,
} from "@/server/db/test-guard"

/**
 * The server for database-writing E2E tests (E2E_DATABASE=1, DV-004B).
 *
 * Never touches the owner's data:
 * - a fresh scratch database `deskverse_test_e2e_<pid>_<random>`, created
 *   with DATABASE_TEST_URL (guarded) and migrated from empty;
 * - a fresh temporary data folder for media;
 * - the app (`next start`, already built) gets only those as DATABASE_URL
 *   and DESKVERSE_DATA_DIR. DATABASE_URL from .env.local is never read.
 * Both are removed on exit; leftovers from a killed run are removed at the
 * next start (their pid is no longer running).
 *
 * The app reaches PostgreSQL through a small TCP proxy on 127.0.0.1, so a
 * test can take the database "down" while the app keeps running: every
 * open connection is cut and new ones are refused, just as when
 * PostgreSQL stops. A control endpoint on 127.0.0.1 (E2E only):
 *   POST /restart            restart the app (same database and media)
 *   POST /database/offline   cut and refuse database connections
 *   POST /database/online    accept them again
 *   POST /worker/stop        stop the orchestrator worker (SIGTERM)
 *   POST /worker/start       (re)start it
 *
 * Scout (DV-005A): the app and worker run with research switched on, and
 * the worker reaches only local fixture sites through Scout's test
 * network (allowed on this scratch test database only). No real website
 * is contacted by the E2E suite.
 */

const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3211)
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? 3212)
const PROXY_PORT = Number(process.env.E2E_DATABASE_PROXY_PORT ?? 3213)
const PREFIX = "deskverse_test_e2e_"
const TEMP_PREFIX = "deskverse-e2e-tickets-"

const fromFile = readEnvFile()
const testUrl = process.env.DATABASE_TEST_URL || fromFile.DATABASE_TEST_URL
const parsed = parseDatabaseUrl(testUrl, "DATABASE_TEST_URL")
if (!parsed.ok) {
  console.error(`[e2e] ${parsed.message} Run scripts/db/setup-local.sh first.`)
  process.exit(1)
}
const devParsed = parseDatabaseUrl(
  process.env.DATABASE_URL || fromFile.DATABASE_URL,
  "DATABASE_URL",
)
const base = parsed.config
assertTestDatabase(base, devParsed.ok ? devParsed.config : null)

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function admin() {
  const c = new pg.Client({ ...base, connectionTimeoutMillis: 5_000 })
  c.on("error", () => {})
  return c
}

async function dropStale() {
  const c = admin()
  await c.connect()
  try {
    const rows = await c.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'deskverse\\_test\\_e2e\\_%'",
    )
    for (const { datname } of rows.rows) {
      const pid = Number(/^deskverse_test_e2e_(\d+)_/.exec(datname)?.[1])
      if (pid && !alive(pid) && isScratchDatabaseName(datname))
        await c.query(
          `DROP DATABASE IF EXISTS ${c.escapeIdentifier(datname)} WITH (FORCE)`,
        )
    }
  } finally {
    await c.end()
  }
  for (const entry of await fs.readdir(os.tmpdir())) {
    const pid = Number(new RegExp(`^${TEMP_PREFIX}(\\d+)-`).exec(entry)?.[1])
    if (pid && !alive(pid))
      await fs.rm(path.join(os.tmpdir(), entry), {
        recursive: true,
        force: true,
      })
  }
}

const name = `${PREFIX}${process.pid}_${Math.random().toString(16).slice(2, 10)}`
let dataDir = ""
let child: ChildProcess | null = null
let control: http.Server | null = null
let offline = false
let proxy: net.Server | null = null
let sites: FixtureSites | null = null
const connections = new Set<net.Socket>()

function startProxy() {
  proxy = net.createServer((client) => {
    if (offline) return client.destroy()
    const upstream = net.connect(base.port, base.host)
    connections.add(client).add(upstream)
    const close = () => {
      client.destroy()
      upstream.destroy()
      connections.delete(client)
      connections.delete(upstream)
    }
    client.on("error", close).on("close", close)
    upstream.on("error", close).on("close", close)
    client.pipe(upstream).pipe(client)
  })
  return new Promise<void>((resolve) =>
    proxy!.listen(PROXY_PORT, "127.0.0.1", resolve),
  )
}

function setOffline(value: boolean) {
  offline = value
  if (value) for (const socket of connections) socket.destroy()
}

const urlFor = (config: DatabaseConfig) =>
  `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${config.database}`

async function startApp() {
  // Through the proxy, so the database can be taken down underneath the app.
  const db: DatabaseConfig = { ...base, database: name, port: PROXY_PORT }
  child = spawn(
    path.join(process.cwd(), "node_modules", ".bin", "next"),
    ["start", "-H", "127.0.0.1", "--port", String(APP_PORT)],
    {
      stdio: "inherit",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: "production",
        DATABASE_URL: urlFor(db),
        DATABASE_TEST_URL: "",
        DESKVERSE_DATA_DIR: dataDir,
        // Deterministic verification runs (DV-004C): this scratch database only.
        DESKVERSE_ORCHESTRATOR_VERIFICATION: "1",
        // Scout research (DV-005A): offered by the app; the worker does it.
        DESKVERSE_SCOUT_RETRIEVAL: "on",
      },
    },
  )
  // Wait until it answers.
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${APP_PORT}/api/system/database/health`,
      )
      if (response.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error("the app didn't start")
}

/**
 * A real orchestrator worker process (DV-004C) on the same scratch
 * database, also through the proxy, so outages reach it too.
 */
let worker: ChildProcess | null = null
function startWorker() {
  const db: DatabaseConfig = { ...base, database: name, port: PROXY_PORT }
  worker = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./scripts/server-only-hook.mjs",
      "scripts/worker/start.ts",
    ],
    {
      stdio: "inherit",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DATABASE_URL: urlFor(db),
        DATABASE_TEST_URL: "",
        DESKVERSE_ORCHESTRATOR_VERIFICATION: "1",
        DESKVERSE_WORKER_LEASE_MS: "2000",
        DESKVERSE_WORKER_POLL_MS: "100",
        DESKVERSE_ORCHESTRATOR_RETRY_BASE_MS: "200",
        DESKVERSE_ORCHESTRATOR_RETRY_MAX_MS: "1000",
        DESKVERSE_WORKER_SHUTDOWN_GRACE_MS: "1000",
        DESKVERSE_SCOUT_RETRIEVAL: "on",
        DESKVERSE_SCOUT_TEST_NETWORK: JSON.stringify({ port: sites!.port }),
        // Pixel (DV-005C): the same temporary media folder as the app.
        DESKVERSE_DATA_DIR: dataDir,
        DESKVERSE_SCOUT_HOST_INTERVAL_MS: "0",
        DESKVERSE_SCOUT_REQUEST_TIMEOUT_MS: "5000",
        NODE_ENV: "production",
      },
    },
  )
}

async function stopWorker() {
  const running = worker
  worker = null
  if (!running || running.exitCode !== null) return
  await new Promise<void>((resolve) => {
    running.once("exit", () => resolve())
    running.kill("SIGTERM")
    setTimeout(() => running.kill("SIGKILL"), 5_000).unref()
  })
}

async function stopApp() {
  const running = child
  child = null
  if (!running || running.exitCode !== null) return
  await new Promise<void>((resolve) => {
    running.once("exit", () => resolve())
    running.kill("SIGTERM")
    setTimeout(() => running.kill("SIGKILL"), 5_000).unref()
  })
}

/**
 * Idempotent: signals can arrive more than once (Playwright signals the
 * whole process group and tsx forwards it too), and every caller must wait
 * for the same cleanup to finish before the process exits.
 */
let cleaning: Promise<void> | null = null
function cleanup() {
  cleaning ??= doCleanup()
  return cleaning
}

async function doCleanup() {
  control?.close()
  await stopWorker()
  await stopApp()
  setOffline(true)
  proxy?.close()
  await sites?.close()
  try {
    const c = admin()
    await c.connect()
    if (isScratchDatabaseName(name))
      await c.query(
        `DROP DATABASE IF EXISTS ${c.escapeIdentifier(name)} WITH (FORCE)`,
      )
    await c.end()
  } catch {
    console.error(`[e2e] couldn't drop ${name}; the next run removes it`)
  }
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true })
}

async function main() {
  await dropStale()
  const c = admin()
  await c.connect()
  await c.query(`CREATE DATABASE ${c.escapeIdentifier(name)}`)
  await c.end()
  const pool = createPool({ ...base, database: name }, { max: 1 })
  await runMigrations(pool, journal, migrationsFolder())
  await pool.end()
  dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `${TEMP_PREFIX}${process.pid}-`),
  )
  console.log(`[e2e] scratch database ${name}, temporary media folder ready`)

  control = http.createServer((request, response) => {
    const done = (status: number, body: object) => {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(body))
    }
    if (request.method !== "POST") return done(405, { error: "POST only" })
    const action = request.url
    void (async () => {
      try {
        if (action === "/database/offline") setOffline(true)
        else if (action === "/database/online") setOffline(false)
        else if (action === "/restart") {
          await stopApp()
          await startApp()
        } else if (action === "/worker/stop") await stopWorker()
        else if (action === "/worker/start") {
          await stopWorker()
          startWorker()
        } else return done(404, { error: "unknown action" })
        done(200, { ok: true, offline })
      } catch (error) {
        done(500, { error: String(error) })
      }
    })()
  })
  await new Promise<void>((resolve) =>
    control!.listen(CONTROL_PORT, "127.0.0.1", resolve),
  )
  await startProxy()
  sites = await startFixtureSites()
  await startApp()
  startWorker()
  console.log(
    `[e2e] app on http://127.0.0.1:${APP_PORT}, control on 127.0.0.1:${CONTROL_PORT}`,
  )
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    void cleanup().then(() => process.exit(0))
  })

main().catch(async (error) => {
  console.error(
    `[e2e] ${error instanceof Error ? error.message : String(error)}`,
  )
  await cleanup()
  process.exit(1)
})
