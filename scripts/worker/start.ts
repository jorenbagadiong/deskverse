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
import { readScoutConfig, testNetworkAllowed } from "@/server/scout/config"
import { createScoutHandler } from "@/server/scout/handler"
import { parseTestNetwork, testNetwork } from "@/server/scout/net/test-network"

/**
 * yarn worker:start — the dedicated local orchestrator worker (DV-004C).
 *
 * A separate process from Next.js. Loads .env.local like `next dev`,
 * connects with DATABASE_URL, claims tasks it has handlers for, and stops
 * safely on Ctrl-C / SIGTERM (running tasks finish or are handed back).
 * A second signal exits immediately (leases then expire and are recovered).
 *
 * Production handlers (DV-005A): Scout's `scout.research`, registered when
 * source retrieval is switched on (DESKVERSE_SCOUT_RETRIEVAL=on). Without
 * it the worker only recovers expired leases and waits. Deterministic
 * verification handlers load only with DESKVERSE_ORCHESTRATOR_VERIFICATION=1
 * on a test database; so does Scout's fixture network
 * (DESKVERSE_SCOUT_TEST_NETWORK).
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
if (
  process.env.DESKVERSE_SCOUT_TEST_NETWORK &&
  !testNetworkAllowed(process.env, db.config)
) {
  console.error(
    "✗ Scout's fixture network only runs on a test database (deskverse_test_*). Refusing to start.",
  )
  process.exit(1)
}
const scout = readScoutConfig()
const fixture = process.env.DESKVERSE_SCOUT_TEST_NETWORK
  ? parseTestNetwork(process.env.DESKVERSE_SCOUT_TEST_NETWORK)
  : null
const registry = createRegistry({
  verification,
  production: scout.retrieval
    ? [
        createScoutHandler({
          config: scout,
          ...(fixture
            ? {
                network: testNetwork(fixture),
                crashBeforeCommit: (name, attempt) =>
                  Boolean(fixture.crashBeforeCommit) &&
                  name.includes(fixture.crashBeforeCommit!) &&
                  attempt === 1,
              }
            : {}),
        }),
      ]
    : [],
})
const pool = createPool(db.config, {
  max: config.slots + 3,
  applicationName: "deskverse-worker",
})
const worker = new Worker({ pool, registry, ...config }).start()

console.log(
  `[worker] ${worker.id} started (pid ${process.pid}) on ${db.config.database}`,
)
const stages = [...registry.values()]
console.log(
  stages.length > 0
    ? `[worker] handlers: ${stages.map((h) => `${h.stage} (${h.kind === "verification" ? "verification only, no real work" : "production"})`).join(", ")}`
    : "[worker] no handlers enabled; recovering leases and waiting",
)
if (registry.get("scout.research"))
  console.log(
    `[worker] Scout research: reads owner-supplied reference pages${fixture ? " (FIXTURE NETWORK: test sites only)" : ""}; extraction ${scout.extraction}${scout.extraction === "ollama" && !scout.ollama ? ` (unusable: ${scout.ollamaProblem})` : ""}`,
  )
else
  console.log(
    "[worker] Scout research is off (set DESKVERSE_SCOUT_RETRIEVAL=on in .env.local to enable it)",
  )
console.log(
  `[worker] full campaign unavailable until ${MISSING_PRODUCTION_CAPABILITIES.map((c) => `${c.stage}: ${c.milestone}`).join("; ")}`,
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
