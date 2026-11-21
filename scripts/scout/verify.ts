import "../load-env"

import { parseArgs } from "node:util"

import { runScoutScenario } from "./scenario"

/**
 * yarn scout:verify [--keep]
 *
 * Scout research crash/recovery verification (DV-005A) with real worker
 * processes on a scratch test database (from DATABASE_TEST_URL, never
 * DATABASE_URL), against local fixture sites only: a graceful SIGTERM, a
 * SIGKILL, and a crash between writing a report and committing it.
 * Prints every check; drops the database unless --keep.
 */
const { values } = parseArgs({ options: { keep: { type: "boolean" } } })
const started = Date.now()
runScoutScenario({
  keep: values.keep === true,
  log: (line) => console.log(`· ${line}`),
})
  .then((report) => {
    console.log(
      `\nScout research verification on ${report.database}${values.keep ? " (kept)" : " (dropped)"}`,
    )
    for (const p of report.products)
      console.log(`  ${p.name}: ${p.status} (${p.attempts.join(" → ")})`)
    console.log("")
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
