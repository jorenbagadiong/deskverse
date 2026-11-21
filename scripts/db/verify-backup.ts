import path from "node:path"

import { fail, run } from "./cli"

import { verifyBackup } from "@/server/backup/backup"

/** yarn db:backup:verify <backup folder> — re-checks every checksum. Read-only. */
const dir = process.argv[2]
if (!dir) fail("Usage: yarn db:backup:verify <backup folder>")
run(async () => {
  const problems = await verifyBackup(path.resolve(dir))
  if (problems.length > 0)
    fail(`Backup is damaged:\n  - ${problems.join("\n  - ")}`)
  console.log(
    "✓ Backup is intact: every checksum matches and the dump is readable.",
  )
})
