import { parseArgs } from "node:util"

import { requireDatabase, run } from "../db/cli"

import { createDatabase, createPool } from "@/server/db/pool"
import { reconcileTicketMedia } from "@/server/tickets/media"
import { resolveDataRoot } from "@/server/video/storage"

/**
 * yarn tickets:reconcile [--apply]
 *
 * Compares Affiliate Ticket media on disk with the database (DV-004B).
 * Read-only by default. With --apply: deletes unfinished uploads
 * (staging/*.part) and MOVES files that no record references to
 * <data dir>/tickets-orphaned/<time>/ (nothing is deleted outright).
 * Records whose file is missing or damaged are only reported.
 */
const { values } = parseArgs({ options: { apply: { type: "boolean" } } })
const config = requireDatabase()
run(async () => {
  const pool = createPool(config, {
    max: 1,
    applicationName: "deskverse-reconcile",
  })
  try {
    const report = await reconcileTicketMedia(
      createDatabase(pool),
      resolveDataRoot(),
      {
        apply: values.apply === true,
      },
    )
    const verb = values.apply ? "Removed" : "Found"
    console.log(`${verb} ${report.staging.length} unfinished upload(s).`)
    console.log(
      `${values.apply ? "Moved to tickets-orphaned/" : "Found"} ${report.orphans.length} file(s) with no database record.`,
    )
    console.log(
      `Unrecognized entries (left alone): ${report.unrecognized.length}.`,
    )
    if (report.damaged.length > 0) {
      console.log(
        `✗ ${report.damaged.length} record(s) whose file is missing or damaged:`,
      )
      for (const d of report.damaged)
        console.log(`  ticket ${d.ticketId}, file ${d.assetId}: ${d.problem}`)
      console.log(
        "  Remove those files in the ticket page and upload them again.",
      )
      process.exit(1)
    }
    console.log("✓ Every registered file is present and matches its checksum.")
    if (!values.apply && report.staging.length + report.orphans.length > 0)
      console.log("Run yarn tickets:reconcile --apply to tidy up.")
  } finally {
    await pool.end()
  }
}, config.password)
