import { parseArgs } from "node:util"

import { requireDatabase, run } from "../db/cli"

import { createPool } from "@/server/db/pool"
import { reconcileTicketRenders } from "@/server/pixel/reconcile"
import { RenderGate } from "@/server/video/render-gate"
import { resolveDataRoot } from "@/server/video/storage"

/**
 * yarn pixel:reconcile [--repair]
 *
 * Checks ticket video storage (<data>/ticket-renders) against the
 * database and the render gate (DV-005C). Read-only by default: reports
 * delivered videos (each MP4 re-checked), active and reusable renders, and
 * abandoned folders. --repair removes ONLY abandoned folders; delivered
 * videos and active renders are never touched.
 */
const { values } = parseArgs({ options: { repair: { type: "boolean" } } })
const config = requireDatabase()
run(async () => {
  const pool = createPool(config, {
    max: 2,
    applicationName: "deskverse-pixel-reconcile",
  })
  try {
    const dataRoot = resolveDataRoot()
    const report = await reconcileTicketRenders(
      pool,
      dataRoot,
      new RenderGate(dataRoot),
      { repair: values.repair === true },
    )
    console.log(
      `Delivered videos: ${report.delivered} (each MP4 checked against its record)`,
    )
    console.log(
      `Active renders:   ${report.active.length ? report.active.join(", ") : "none"}`,
    )
    console.log(
      `Reusable outputs: ${report.reusable.length ? report.reusable.join(", ") : "none"}`,
    )
    console.log(
      `Abandoned:        ${report.abandoned.length ? report.abandoned.join(", ") : "none"}${values.repair ? "" : report.abandoned.length ? " (run with --repair to remove)" : ""}`,
    )
    if (values.repair)
      console.log(
        `Removed:          ${report.removed.length ? report.removed.join(", ") : "nothing"}`,
      )
    if (report.problems.length) {
      console.log("\nProblems:")
      for (const p of report.problems) console.log(`  - ${p}`)
      process.exitCode = 1
    }
  } finally {
    await pool.end()
  }
}, config.password)
