import { promises as fs } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { GET as getDatabaseHealth } from "@/app/api/system/database/health/route"
import { isDatabaseHealthReport } from "@/lib/system/database-health"
import { findActiveProcesses, planMediaBackup } from "@/server/backup/backup"
import { manifestProblems } from "@/server/backup/manifest"
import {
  describeDatabase,
  parseDatabaseUrl,
  readDatabaseConfig,
  redact,
  type DatabaseConfig,
} from "@/server/db/config"
import { parseEnvFile } from "@/server/db/env-file"
import { classifyDatabaseError } from "@/server/db/errors"
import { checkDatabaseHealth } from "@/server/db/health"
import { journal } from "@/server/db/journal"
import {
  assertTestDatabase,
  isScratchDatabaseName,
  scratchDatabaseName,
} from "@/server/db/test-guard"
import { guardLocalSystemApi } from "@/server/http/local-api"

/** DV-004A unit tests. None of these need PostgreSQL. */

const URL_OK = "postgresql://deskverse_app:s3cret-pw@127.0.0.1:5432/deskverse"

function config(raw: string, variable: "DATABASE_URL" | "DATABASE_TEST_URL") {
  const result = parseDatabaseUrl(raw, variable)
  if (!result.ok) throw new Error(result.message)
  return result.config
}

describe("database configuration", () => {
  it("reports a missing DATABASE_URL as unconfigured", () => {
    for (const value of [undefined, "", "   "])
      expect(parseDatabaseUrl(value, "DATABASE_URL")).toEqual({
        ok: false,
        reason: "unconfigured",
        message: expect.stringContaining("DATABASE_URL isn't set"),
      })
    expect(readDatabaseConfig({}).ok).toBe(false)
  })

  it("parses a local URL into separate fields", () => {
    expect(config(URL_OK, "DATABASE_URL")).toEqual({
      variable: "DATABASE_URL",
      host: "127.0.0.1",
      port: 5432,
      database: "deskverse",
      user: "deskverse_app",
      password: "s3cret-pw",
    })
    expect(
      config("postgres://u_1:p%40ss@localhost/db", "DATABASE_URL"),
    ).toMatchObject({
      host: "localhost",
      port: 5432,
      password: "p@ss",
    })
    expect(
      config("postgresql://u:p@[::1]:6543/db", "DATABASE_URL"),
    ).toMatchObject({
      host: "::1",
      port: 6543,
    })
  })

  it.each([
    ["not a url", "isn't a valid URL"],
    ["mysql://u:p@127.0.0.1/db", "must start with postgresql://"],
    ["postgresql://u:p@127.0.0.1:0/db", "invalid port"],
    ["postgresql://u:p@127.0.0.1:70000/db", "isn't a valid URL"],
    ["postgresql://:p@127.0.0.1/db", "needs a user name"],
    ["postgresql://Bad-User:p@127.0.0.1/db", "needs a user name"],
    ["postgresql://u@127.0.0.1/db", "needs a password"],
    ["postgresql://u:REPLACE_ME@127.0.0.1/db", "REPLACE_ME placeholder"],
    ["postgresql://u:p@127.0.0.1/", "needs a database name"],
    ["postgresql://u:p@127.0.0.1/db;drop", "needs a database name"],
    ["postgresql://u:p@127.0.0.1/db?sslmode=disable", "must not have ?options"],
    ["postgresql://u:p@127.0.0.1/db?host=/tmp", "must not have ?options"],
    ["postgresql://u:p@127.0.0.1/db#x", "must not have ?options"],
  ])("rejects malformed URL %s", (raw, problem) => {
    const result = parseDatabaseUrl(raw, "DATABASE_URL")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("invalid")
      expect(result.message).toContain(problem)
    }
  })

  it.each([
    "postgresql://u:p@192.168.1.20:5432/db",
    "postgresql://u:p@0.0.0.0:5432/db",
    "postgresql://u:p@db.example.com/db",
    "postgresql://u:p@127.0.0.1.nip.io/db",
    "postgresql://u:p@[::ffff:10.0.0.1]/db",
  ])("refuses a non-loopback host: %s", (raw) => {
    const result = parseDatabaseUrl(raw, "DATABASE_URL")
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.message).toContain("must point at this computer")
  })

  it("never repeats the URL, user or password in messages", () => {
    const raws = [
      "postgresql://leaky_user:leaky-pass@10.0.0.1/db",
      "postgresql://leaky_user:leaky-pass@127.0.0.1/db?x=1",
      "postgresql://Leaky_User:leaky-pass@127.0.0.1/db",
    ]
    for (const raw of raws) {
      const result = parseDatabaseUrl(raw, "DATABASE_URL")
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).not.toMatch(/leaky/i)
        expect(result.message).not.toContain("10.0.0.1")
      }
    }
  })

  it("describes a database without the user or password", () => {
    const text = describeDatabase(config(URL_OK, "DATABASE_URL"))
    expect(text).toBe("deskverse on 127.0.0.1:5432")
  })

  it("redacts URLs and secrets from log text", () => {
    expect(
      redact(`connect to ${URL_OK} failed: s3cret-pw rejected`, "s3cret-pw"),
    ).toBe("connect to postgresql://[redacted] failed: [redacted] rejected")
  })
})

describe("database error classification", () => {
  const cases: [unknown, string][] = [
    [
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
      "offline",
    ],
    [
      new AggregateError([
        Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
      ]),
      "offline",
    ],
    [Object.assign(new Error("x"), { code: "ETIMEDOUT" }), "timeout"],
    [new Error("timeout expired"), "timeout"],
    [new Error("Connection terminated due to connection timeout"), "timeout"],
    [new Error("Connection terminated unexpectedly"), "offline"],
    [
      Object.assign(new Error('password authentication failed for user "x"'), {
        code: "28P01",
      }),
      "authentication",
    ],
    [
      Object.assign(new Error('no pg_hba.conf entry for host "x"'), {
        code: "28000",
      }),
      "authentication",
    ],
    [
      Object.assign(new Error('database "secret_db" does not exist'), {
        code: "3D000",
      }),
      "missing-database",
    ],
    [
      Object.assign(new Error("permission denied"), { code: "42501" }),
      "permission",
    ],
    [
      Object.assign(new Error('relation "x" does not exist'), {
        code: "42P01",
      }),
      "schema",
    ],
    [
      Object.assign(new Error("the database system is starting up"), {
        code: "57P03",
      }),
      "offline",
    ],
    [Object.assign(new Error("boom"), { code: "XX000" }), "error"],
    ["a string", "error"],
    [null, "error"],
  ]
  it.each(cases)("classifies %o as %s", (error, failure) => {
    const result = classifyDatabaseError(error)
    expect(result.failure).toBe(failure)
  })

  it("returns fixed messages that never echo the driver's text", () => {
    const error = Object.assign(
      new Error(
        'password authentication failed for user "owner_name" at 127.0.0.1',
      ),
      { code: "28P01" },
    )
    const { message } = classifyDatabaseError(error)
    expect(message).not.toContain("owner_name")
    expect(message).toMatch(/refused the password/)
  })
})

/** A loopback port with nothing listening. */
async function closedPort() {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** A loopback port that accepts connections and never answers. */
async function silentServer() {
  const sockets: net.Socket[] = []
  const server = net.createServer((socket) => sockets.push(socket))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => {
      for (const socket of sockets) socket.destroy()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

describe("database health check", () => {
  const at = () => new Date("2026-11-21T10:00:00.000Z")

  it("is unconfigured without DATABASE_URL, and says Pixel Studio still works", async () => {
    const report = await checkDatabaseHealth(journal, { env: {}, now: at })
    expect(report).toEqual({
      status: "unconfigured",
      message: expect.stringContaining("Pixel Studio works without it"),
      schema: null,
      checkedAt: "2026-11-21T10:00:00.000Z",
    })
  })

  it("is unconfigured for a malformed or non-local URL, without echoing it", async () => {
    for (const DATABASE_URL of [
      "nonsense",
      "postgresql://who:pw@203.0.113.9/db",
    ]) {
      const report = await checkDatabaseHealth(journal, {
        env: { DATABASE_URL },
      })
      expect(report.status).toBe("unconfigured")
      expect(JSON.stringify(report)).not.toMatch(/who|pw@|203\.0/)
    }
  })

  it("is offline when nothing listens, quickly", async () => {
    const port = await closedPort()
    const started = Date.now()
    const report = await checkDatabaseHealth(journal, {
      env: { DATABASE_URL: `postgresql://u:secret@127.0.0.1:${port}/db` },
    })
    expect(report.status).toBe("offline")
    expect(report.message).toContain("sudo systemctl start postgresql")
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(JSON.stringify(report)).not.toContain("secret")
  })

  it("times out (offline) against a server that never answers", async () => {
    const server = await silentServer()
    try {
      const started = Date.now()
      const report = await checkDatabaseHealth(journal, {
        env: {
          DATABASE_URL: `postgresql://u:secret@127.0.0.1:${server.port}/db`,
        },
        timeoutMs: 300,
      })
      expect(report.status).toBe("offline")
      expect(report.message).toMatch(/didn't answer in time/)
      expect(Date.now() - started).toBeLessThan(1_500)
    } finally {
      await server.close()
    }
  })

  it("never lets connection details reach the report", () => {
    const report = {
      status: "error",
      message: "Local PostgreSQL reported an unexpected error.",
      schema: null,
      checkedAt: "x",
    }
    expect(isDatabaseHealthReport(report)).toBe(true)
    expect(isDatabaseHealthReport({ ...report, status: "maybe" })).toBe(false)
    expect(isDatabaseHealthReport({ ...report, schema: "weird" })).toBe(false)
  })
})

describe("GET /api/system/database/health", () => {
  const request = (headers: Record<string, string>) =>
    new Request("http://localhost:3000/api/system/database/health", {
      headers: { host: "localhost:3000", ...headers },
    })

  it("answers a local browser with a no-store report", async () => {
    vi.stubEnv("DATABASE_URL", "")
    try {
      const response = await getDatabaseHealth(
        request({ "sec-fetch-site": "same-origin" }),
      )
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-store")
      const body = await response.json()
      expect(isDatabaseHealthReport(body)).toBe(true)
      expect(body.status).toBe("unconfigured")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("refuses DNS-rebinding and cross-site requests", async () => {
    for (const headers of [
      { host: "evil.example" },
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { "x-forwarded-for": "203.0.113.5" },
    ] as Record<string, string>[]) {
      const response = await getDatabaseHealth(request(headers))
      expect(response.status).toBe(403)
      expect(response.headers.get("cache-control")).toBe("no-store")
    }
  })

  it("is disabled on hosting platforms", async () => {
    const response = guardLocalSystemApi(request({}), { VERCEL: "1" })
    expect(response?.status).toBe(503)
    expect((await response!.json()).error).toBe("local-services-disabled")
  })
})

describe("test database guards", () => {
  const dev = config(URL_OK, "DATABASE_URL")
  const test = config(
    "postgresql://deskverse_test:t@127.0.0.1:5432/deskverse_test",
    "DATABASE_TEST_URL",
  )

  it("accepts the dedicated test database and scratch databases", () => {
    expect(() => assertTestDatabase(test, dev)).not.toThrow()
    expect(() =>
      assertTestDatabase(
        { ...test, database: "deskverse_test_restore_12_ab" },
        dev,
      ),
    ).not.toThrow()
  })

  it.each<[string, Partial<DatabaseConfig>]>([
    ["DATABASE_URL as a test target", { variable: "DATABASE_URL" }],
    ["the development database", { database: "deskverse" }],
    ["an arbitrary database", { database: "postgres" }],
    ["a look-alike database", { database: "deskverse_testing" }],
    ["a non-test role", { user: "deskverse_app" }],
    ["the superuser", { user: "postgres" }],
  ])("refuses %s", (_, change) => {
    expect(() => assertTestDatabase({ ...test, ...change }, dev)).toThrow(
      /Refusing to use this database for tests/,
    )
  })

  it("refuses a test URL that shares the development database or role", () => {
    expect(() =>
      assertTestDatabase(test, { ...dev, database: "deskverse_test" }),
    ).toThrow(/same database/)
    expect(() =>
      assertTestDatabase(test, { ...dev, user: "deskverse_test" }),
    ).toThrow(/same role/)
  })

  it("makes unique, valid scratch names and never treats the base database as scratch", () => {
    const a = scratchDatabaseName("Restore Test!", 123)
    const b = scratchDatabaseName("Restore Test!", 123)
    expect(a).toMatch(/^deskverse_test_restore_test_123_[0-9a-f]{8}$/)
    expect(a).not.toBe(b)
    expect(a.length).toBeLessThanOrEqual(63)
    expect(isScratchDatabaseName(a)).toBe(true)
    expect(isScratchDatabaseName("deskverse_test")).toBe(false)
    expect(isScratchDatabaseName("deskverse")).toBe(false)
    expect(isScratchDatabaseName('deskverse_test_x"; DROP')).toBe(false)
  })
})

describe(".env file parsing", () => {
  it("reads plain, quoted and exported values without expansion", () => {
    expect(
      parseEnvFile(
        [
          "# comment",
          "A=1",
          'B="two words"',
          "C='$NOT_EXPANDED'",
          "export D=4 # trailing comment",
          "not a line",
          "",
        ].join("\n"),
      ),
    ).toEqual({ A: "1", B: "two words", C: "$NOT_EXPANDED", D: "4" })
  })
})

describe("backup manifest validation", () => {
  const good = {
    format: "deskverse-backup",
    formatVersion: 1,
    database: { file: "database.dump", bytes: 1, sha256: "a".repeat(64) },
    media: {
      files: [
        {
          path: `video/jobs/job_${"0".repeat(32)}/assets/asset_${"1".repeat(32)}.png`,
          bytes: 1,
          sha256: "b".repeat(64),
        },
      ],
    },
  }
  it("accepts a well-formed manifest", () => {
    expect(manifestProblems(good)).toEqual([])
  })
  it.each([
    "../../etc/passwd",
    `video/jobs/job_${"0".repeat(32)}/../../x`,
    "/absolute/path",
    `video/jobs/not-a-job/x`,
  ])("refuses an unsafe media path %s", (bad) => {
    const manifest = structuredClone(good)
    manifest.media.files[0].path = bad
    expect(manifestProblems(manifest)).toContain(
      "media file list has an invalid entry",
    )
  })
  it("refuses other formats and versions", () => {
    expect(manifestProblems({ ...good, format: "zip" })).toContain(
      "not a Deskverse backup",
    )
    expect(manifestProblems({ ...good, formatVersion: 9 })[0]).toMatch(
      /unsupported backup format version 9/,
    )
  })
})

describe("media backup plan", () => {
  let root: string
  const job = `job_${"a".repeat(32)}`
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-plan-"))
    const dir = path.join(root, "video", "jobs", job)
    await fs.mkdir(path.join(dir, "assets"), { recursive: true })
    await fs.mkdir(path.join(dir, "output"), { recursive: true })
    await fs.mkdir(path.join(dir, "work", "segments"), { recursive: true })
    await fs.writeFile(path.join(dir, "job.json"), "{}")
    await fs.writeFile(path.join(dir, "project.json"), "{}")
    await fs.writeFile(
      path.join(dir, "assets", `asset_${"b".repeat(32)}.png`),
      "png",
    )
    await fs.writeFile(path.join(dir, "output", "video.mp4"), "mp4")
    await fs.writeFile(path.join(dir, "work", "segments", "0.mp4"), "scratch")
    await fs.symlink("/etc/passwd", path.join(dir, "assets", "link.png"))
    await fs.writeFile(path.join(dir, "stray.txt"), "?")
    await fs.mkdir(path.join(root, "video", "jobs", "not-a-job"))
  })
  afterAll(() => fs.rm(root, { recursive: true, force: true }))

  it("includes job metadata, uploads and outputs; leaves out work/ and symlinks", async () => {
    const plan = await planMediaBackup(root)
    expect(plan.files.map((f) => f.relative).sort()).toEqual([
      `video/jobs/${job}/assets/asset_${"b".repeat(32)}.png`,
      `video/jobs/${job}/job.json`,
      `video/jobs/${job}/output/video.mp4`,
      `video/jobs/${job}/project.json`,
    ])
    expect(plan.files).toHaveLength(4)
    expect(plan.jobs).toBe(1)
    expect(plan.scratchFolders).toBe(1)
    // The symlink, stray.txt and not-a-job.
    expect(plan.unrecognized).toBe(3)
  })

  it("is empty when there is no data folder yet", async () => {
    const plan = await planMediaBackup(path.join(root, "missing"))
    expect(plan.files).toEqual([])
  })
})

describe("running-process detection for offline backups", () => {
  let proc: string
  const project = "/home/u/deskverse"
  const data = "/home/u/.local/share/deskverse"
  async function fakeProcess(pid: number, cwd: string, argv: string[]) {
    const dir = path.join(proc, String(pid))
    await fs.mkdir(dir)
    await fs.symlink(cwd, path.join(dir, "cwd"))
    await fs.writeFile(path.join(dir, "cmdline"), `${argv.join("\0")}\0`)
  }
  beforeAll(async () => {
    proc = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-proc-"))
    await fakeProcess(10, project, ["next-server (v16.4.6)"])
    await fakeProcess(11, project, ["node", "/x/node_modules/.bin/next", "dev"])
    await fakeProcess(12, `${data}/video/jobs/job_x`, ["ffmpeg", "-i", "a"])
    await fakeProcess(13, project, [
      "node",
      "/x/node_modules/next/dist/server/lib/x.js",
    ])
    await fakeProcess(14, project, ["node", "scripts/db/backup.ts"])
    await fakeProcess(15, "/elsewhere", ["next", "dev"])
    await fs.mkdir(path.join(proc, "self"))
  })
  afterAll(() => fs.rm(proc, { recursive: true, force: true }))

  it("finds Deskverse servers and processes in the data folder only", async () => {
    const active = await findActiveProcesses(project, data, proc)
    expect(active?.sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 10, kind: "deskverse-server" },
      { pid: 11, kind: "deskverse-server" },
      { pid: 12, kind: "data-folder" },
    ])
  })

  it("says it can't tell without /proc", async () => {
    expect(
      await findActiveProcesses(project, data, "/nonexistent-proc"),
    ).toBeNull()
  })
})
