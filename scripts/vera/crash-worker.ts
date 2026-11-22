/** Test-only process harness: real production handler and durable Worker, guarded scratch DB. */
import { parseDatabaseUrl } from "@/server/db/config"
import { assertTestDatabase } from "@/server/db/test-guard"
import { createPool } from "@/server/db/pool"
import { createRegistry } from "@/server/orchestrator/workflows"
import { Worker } from "@/server/orchestrator/worker"
import { createVeraHandler } from "@/server/vera/handler"

const db = parseDatabaseUrl(process.env.DATABASE_TEST_URL, "DATABASE_TEST_URL")
if (!db.ok) throw Error(db.message)
assertTestDatabase(db.config, null)
if (!process.env.DESKVERSE_DATA_DIR?.startsWith("/tmp/"))
  throw Error("Test data must be temporary")
const pool = createPool(db.config, { max: 5 })
const mode = process.env.VERA_CRASH_POINT
const handler = createVeraHandler({
  pool,
  dataRoot: process.env.DESKVERSE_DATA_DIR,
  commands: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
  beforeCommit: () => {
    if (mode === "before-commit") process.kill(process.pid, "SIGKILL")
  },
})
const worker = new Worker({
  pool,
  registry: createRegistry({
    verification: false,
    production: [
      {
        ...handler,
        async run(ctx) {
          console.log("VERA_REVIEW_STARTED")
          return handler.run(ctx)
        },
      },
    ],
  }),
  leaseMs: 2000,
  pollMs: 50,
  shutdownGraceMs: 100,
  log: (line) => {
    console.log(line)
    if (mode === "after-commit" && line.includes("completed (committed)"))
      process.kill(process.pid, "SIGKILL")
  },
}).start()
let stopping = false
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    if (stopping) process.exit(130)
    stopping = true
    void worker
      .stop()
      .then(() => pool.end())
      .then(() => process.exit(0))
  })
