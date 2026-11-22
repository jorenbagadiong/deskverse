import { describe, expect, it } from "vitest"

import { runQuillScenario } from "../../scripts/quill/scenario"

/**
 * DV-005B scriptwriting crash recovery with real worker PROCESSES (the same
 * scenario as `yarn quill:verify`).
 */
describe("Quill scriptwriting crash recovery (multi-process)", () => {
  it(
    "recovers from SIGTERM, SIGKILL and a mid-commit crash with one script per product",
    { timeout: 240_000 },
    async () => {
      const report = await runQuillScenario()
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
        scripts: 6,
        taskResults: 6,
      })
    },
  )
})
