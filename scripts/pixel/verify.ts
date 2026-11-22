import "../load-env"

import { parseArgs } from "node:util"

import { runPixelScenario } from "./scenario"

/**
 * yarn pixel:verify [--keep] [--batches 1,3,10]
 *
 * Pixel ticket video verification (DV-005C) with real FFmpeg and real
 * worker processes on a scratch test database and a temporary data folder
 * (never your real data): batches of 1, 3 and 10 products, standalone
 * Pixel Studio renders competing for the render gate, SIGTERM/SIGKILL and
 * crash points, a damaged image, then reconciliation. Prints every check.
 */
const { values } = parseArgs({
  options: { keep: { type: "boolean" }, batches: { type: "string" } },
})
const started = Date.now()
const batches = (values.batches ?? "1,3,10").split(",").map(Number)
runPixelScenario({
  batches,
  keep: values.keep === true,
  log: (line) => console.log(`· ${line}`),
})
  .then((report) => {
    console.log(
      `\nPixel ticket video verification on ${report.database}${values.keep ? " (kept)" : " (dropped)"}\n`,
    )
    for (const [check, ok] of Object.entries(report.checks))
      console.log(`  ${ok ? "✓" : "✗"} ${check}`)
    console.log(`\n${JSON.stringify(report.evidence, null, 2)}`)
    console.log(
      `\nFinished in ${((Date.now() - started) / 1000).toFixed(1)} s.`,
    )
    process.exit(Object.values(report.checks).every(Boolean) ? 0 : 1)
  })
  .catch((error: unknown) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
