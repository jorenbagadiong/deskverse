import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

import { requireDatabase, run } from "./cli"

import { createBackup } from "@/server/backup/backup"
import { journal } from "@/server/db/journal"
import { resolveDataRoot } from "@/server/video/storage"

import packageJson from "../../package.json"

/**
 * yarn db:backup [--out <folder>]
 *
 * Offline backup of the Deskverse database and Pixel Studio's job files.
 * Stop Deskverse first; the command refuses while it is running.
 * Default folder: ~/.local/share/deskverse-backups (outside the data folder
 * and the repository).
 */
const { values } = parseArgs({ options: { out: { type: "string" } } })
const config = requireDatabase()
run(async () => {
  const backupsRoot = path.resolve(
    values.out ??
      path.join(os.homedir(), ".local", "share", "deskverse-backups"),
  )
  const { dir, manifest } = await createBackup({
    db: config,
    journal,
    dataRoot: resolveDataRoot(),
    backupsRoot,
    projectRoot: process.cwd(),
    deskverseVersion: packageJson.version,
  })
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
  console.log(`✓ Backup written and verified: ${dir}`)
  console.log(
    `  Database: ${mb(manifest.database.bytes)}, schema ${manifest.database.migrations.current}, ` +
      Object.entries(manifest.database.tables)
        .map(([table, rows]) => `${table} ${rows} rows`)
        .join(", "),
  )
  console.log(
    `  Media:    ${manifest.media.jobs} render jobs, ${manifest.media.files.length} files, ${mb(manifest.media.bytes)} ` +
      `(left out ${manifest.media.excluded.scratchFolders} temporary work folders)`,
  )
  console.log(
    "  Copy this folder to another drive to protect against disk loss.",
  )
}, config.password)
