import "../load-env"

import { parseArgs } from "node:util"

import { runQuillScenario } from "./scenario"

/**
 * yarn quill:verify [--keep]
 *
 * Quill scriptwriting crash/recovery verification (DV-005B) with real
 * worker processes on a scratch test database (from DATABASE_TEST_URL,
 * never DATABASE_URL), from real Scout reports of local fixture sites:
 * SIGTERM and SIGKILL during generation, a crash between writing a script
 * and committing it, and a fresh worker afterwards. Prints every check;
 * drops the database unless --keep.
 */
const { values } = parseArgs({ options: { keep: { type: "boolean" } } })
const started = Date.now()
runQuillScenario({
  keep: values.keep === true,
  log: (line) => console.log(`· ${line}`),
})
  .then((report) => {
    console.log(
      `\nQuill scriptwriting verification on ${report.database}${values.keep ? " (kept)" : " (dropped)"}`,
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
