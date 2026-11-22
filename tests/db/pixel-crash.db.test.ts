import { describe, expect, it } from "vitest"

import { runPixelScenario } from "../../scripts/pixel/scenario"

/**
 * DV-005C multi-process verification with real FFmpeg (the same scenario
 * as `yarn pixel:verify`, smaller batches): ticket workers and standalone
 * Pixel Studio renders share the render gate; SIGTERM, SIGKILL and crash
 * points during FFmpeg, after the output and inside the commit.
 */
describe("Pixel ticket videos across processes (real FFmpeg)", () => {
  it(
    "renders independently, never overlaps, recovers from crashes with one deliverable per task",
    { timeout: 900_000 },
    async () => {
      const report = await runPixelScenario({
        batches: [2, 3],
        studioRenders: 1,
      })
      const failed = Object.entries(report.checks).filter(([, ok]) => !ok)
      expect(failed, JSON.stringify(report.evidence, null, 2)).toEqual([])
    },
  )
})
