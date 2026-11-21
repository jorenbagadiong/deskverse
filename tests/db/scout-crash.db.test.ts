import { describe, expect, it } from "vitest"

import { runScoutScenario } from "../../scripts/scout/scenario"

/**
 * DV-005A research crash recovery with real worker PROCESSES (the same
 * scenario as `yarn scout:verify`): SIGTERM and SIGKILL during research,
 * and a crash between writing a report and committing it, on a scratch
 * database against local fixture sites.
 */
describe("Scout research crash recovery (multi-process)", () => {
  it(
    "recovers from a graceful stop, a SIGKILL and a mid-commit crash with one report per product",
    { timeout: 240_000 },
    async () => {
      const report = await runScoutScenario()
      const failed = Object.entries(report.checks).filter(([, ok]) => !ok)
      expect(
        failed,
        JSON.stringify(
          { products: report.products, evidence: report.evidence },
          null,
          2,
        ),
      ).toEqual([])
      expect(report.evidence).toMatchObject({
        completed: 6,
        reports: 6,
        taskResults: 6,
      })
    },
  )
})
