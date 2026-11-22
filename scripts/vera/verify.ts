import "../load-env"
import { parseArgs } from "node:util"
import { runVeraScenario } from "./scenario"
const { values } = parseArgs({ options: { batches: { type: "string" } } })
const started = Date.now()
runVeraScenario({
  batches: (values.batches ?? "1,3,10").split(",").map(Number),
  log: (line) => console.log(line),
})
  .then((report) => {
    console.log(
      JSON.stringify(
        { ...report, seconds: (Date.now() - started) / 1000 },
        null,
        2,
      ),
    )
    process.exit(Object.values(report.checks).every(Boolean) ? 0 : 1)
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
