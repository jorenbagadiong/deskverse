import "../load-env"

import { parseArgs } from "node:util"

import { runScenario } from "./scenario"

/**
 * yarn orchestrator:verify [--keep]
 *
 * Runs the deterministic 10-product orchestration verification with real
 * worker processes, a graceful stop and a forced crash, on a scratch test
 * database created from DATABASE_TEST_URL (never DATABASE_URL), then drops
 * it (unless --keep). Prints every check. It verifies the orchestration
 * infrastructure only: no AI content, script, video or review is produced.
 */
const { values } = parseArgs({ options: { keep: { type: "boolean" } } })
const started = Date.now()
runScenario({
  keep: values.keep === true,
  log: (line) => console.log(`· ${line}`),
})
  .then((report) => {
    console.log(
      `\nDeterministic orchestration verification on ${report.database}${values.keep ? " (kept)" : " (dropped)"}`,
    )
    for (const p of report.products)
      console.log(`  product ${p.position + 1}: ${p.states.join(" → ")}`)
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
