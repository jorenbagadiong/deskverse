import { describe, expect, it } from "vitest"

import { runScenario } from "../../scripts/orchestrator/scenario"

/**
 * DV-004C crash and restart recovery with real worker PROCESSES (the same
 * scenario as `yarn orchestrator:verify`): 10 products, 3 workers, a
 * graceful SIGTERM and a forced SIGKILL while tasks are in flight, on its
 * own scratch database. Deterministic verification steps only.
 */
describe("orchestrator crash recovery (multi-process)", () => {
  it(
    "recovers from a graceful stop and a SIGKILL with no duplicate results",
    { timeout: 240_000 },
    async () => {
      const report = await runScenario()
      const failed = Object.entries(report.checks).filter(([, ok]) => !ok)
      expect(failed, JSON.stringify(report.evidence, null, 2)).toEqual([])
      expect(report.runStatus).toBe("completed_with_errors")
      expect(report.evidence).toMatchObject({ completedTasks: 35, results: 35 })
    },
  )
})
