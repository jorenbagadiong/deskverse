import "../load-env"

import { readDatabaseConfig } from "@/server/db/config"
import { createPool } from "@/server/db/pool"
import {
  readOrchestratorConfig,
  verificationAllowed,
} from "@/server/orchestrator/config"
import {
  createRegistry,
  MISSING_PRODUCTION_CAPABILITIES,
} from "@/server/orchestrator/workflows"
import { Worker } from "@/server/orchestrator/worker"

/**
 * yarn worker:start — the dedicated local orchestrator worker (DV-004C).
 *
 * A separate process from Next.js. Loads .env.local like `next dev`,
 * connects with DATABASE_URL, claims tasks it has handlers for, and stops
 * safely on Ctrl-C / SIGTERM (running tasks finish or are handed back).
 * A second signal exits immediately (leases then expire and are recovered).
 *
 * DV-004C has no production handlers, so on your development database the
 * worker only recovers expired leases and waits. Deterministic verification
 * handlers load only with DESKVERSE_ORCHESTRATOR_VERIFICATION=1 on a test
 * database.
 */
const db = readDatabaseConfig()
if (!db.ok) {
  console.error(`✗ ${db.message}`)
  process.exit(1)
}
const config = readOrchestratorConfig()
const verification = verificationAllowed(process.env, db.config)
if (process.env.DESKVERSE_ORCHESTRATOR_VERIFICATION === "1" && !verification) {
  console.error(
    "✗ Verification handlers only run on a test database (deskverse_test_*). Refusing to start.",
  )
  process.exit(1)
}
const registry = createRegistry({ verification })
const pool = createPool(db.config, {
  max: config.slots + 3,
  applicationName: "deskverse-worker",
})
const worker = new Worker({ pool, registry, ...config }).start()

console.log(
  `[worker] ${worker.id} started (pid ${process.pid}) on ${db.config.database}`,
)
console.log(
  registry.size > 0
    ? `[worker] handlers: ${[...registry.keys()].join(", ")} (verification only, no real work)`
    : `[worker] no production handlers yet (${MISSING_PRODUCTION_CAPABILITIES.map((c) => `${c.stage}: ${c.milestone}`).join("; ")}); recovering leases and waiting`,
)

let stopping = false
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) {
      console.log(
        "[worker] second signal: exiting now; unfinished leases will expire and be recovered",
      )
      process.exit(130)
    }
    stopping = true
    console.log(
      `[worker] ${signal}: finishing running tasks (up to ${config.shutdownGraceMs} ms), claiming nothing new`,
    )
    void worker
      .stop()
      .then(() => pool.end())
      .then(() => {
        console.log("[worker] stopped cleanly")
        process.exit(0)
      })
  })
