import path from "node:path"
import { parseArgs } from "node:util"

import { fail, requireDatabase, run, describeDatabase } from "./cli"

import { restoreBackup } from "@/server/backup/backup"
import type { DatabaseUrlVariable } from "@/server/db/config"
import { journal } from "@/server/db/journal"

/**
 * yarn db:restore <backup folder> --target <DATABASE_URL|DATABASE_TEST_URL> --data-dir <new folder>
 *
 * Restores into an EMPTY database and a NEW data folder; it refuses to
 * overwrite anything. To use the restored data afterwards, point
 * DATABASE_URL and DESKVERSE_DATA_DIR at them.
 */
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { target: { type: "string" }, "data-dir": { type: "string" } },
})
const usage =
  "Usage: yarn db:restore <backup folder> --target DATABASE_URL --data-dir <new empty folder>"
if (positionals.length !== 1 || !values.target || !values["data-dir"])
  fail(usage)
if (values.target !== "DATABASE_URL" && values.target !== "DATABASE_TEST_URL")
  fail(
    "--target must be DATABASE_URL or DATABASE_TEST_URL (the name of the variable, not a URL).",
  )
const target = requireDatabase(values.target as DatabaseUrlVariable)
run(async () => {
  const result = await restoreBackup({
    dir: path.resolve(positionals[0]),
    target,
    dataRoot: path.resolve(values["data-dir"]!),
    journal,
  })
  console.log(
    `✓ Restored into ${describeDatabase(target)} and ${path.resolve(values["data-dir"]!)}`,
  )
  console.log(
    `  Schema ${result.migration}; ${Object.entries(result.tables)
      .map(([table, rows]) => `${table} ${rows} rows`)
      .join(", ")}; ${result.files} media files, all checksums verified.`,
  )
}, target.password)
