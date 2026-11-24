/** Test-only worker process. The parent creates the scratch database and temporary media. */
import assert from "node:assert/strict"

import { parseDatabaseUrl } from "@/server/db/config"
import { createPool } from "@/server/db/pool"
import { assertTestDatabase } from "@/server/db/test-guard"
import { createRegistry } from "@/server/orchestrator/workflows"
import { Worker } from "@/server/orchestrator/worker"
import { fixtureCampaignHandlers } from "./handlers"

const db = parseDatabaseUrl(process.env.DATABASE_TEST_URL, "DATABASE_TEST_URL")
assert(db.ok)
assertTestDatabase(db.config, null)
const dataRoot = process.env.DESKVERSE_DATA_DIR
assert(dataRoot && dataRoot.startsWith("/tmp/deskverse-campaign-"))
const [, , stage, point, port] = process.argv
const pool = createPool(db.config, { max: 6 })
const kill = () => process.kill(process.pid, "SIGKILL")
const handlers = fixtureCampaignHandlers(pool, dataRoot, Number(port), {
  scoutCrash: (_name, attempt) =>
    point === "before-scout-commit" && attempt === 1,
  quillTest:
    point === "before-quill-commit"
      ? { delayMs: 0, crashBeforeCommit: "SteelBoil" }
      : null,
  pixelTest:
    point === "during-render" || point === "after-output"
      ? [{ crashAt: point, product: "SteelBoil" }]
      : null,
})
const handler = handlers.find((candidate) => candidate.stage === stage)
assert(handler)
const worker = new Worker({
  pool,
  campaignCapable: true,
  pollMs: 50,
  leaseMs: 2500,
  slots: 1,
  registry: createRegistry({ verification: false, production: [handler] }),
  log(line) {
    console.log(line)
    if (point === "after-commit" && line.includes("completed (committed)"))
      kill()
  },
}).start()
process.once("SIGTERM", () => {
  void worker
    .stop()
    .then(() => pool.end())
    .then(() => process.exit(0))
})
