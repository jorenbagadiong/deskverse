import { createHash } from "node:crypto"
import { createReadStream, promises as fs } from "node:fs"
import path from "node:path"

import { isRenderJobId } from "@/lib/video/ids"
import type { Queryable } from "@/server/orchestrator/canonical"
import { ticketRenderStorage } from "@/server/pixel/store"
import type { RenderGate } from "@/server/video/render-gate"

/**
 * Ticket-render storage reconciliation (DV-005C). Read-only unless
 * `repair` is set. Classifies every Pixel job folder under
 * <data>/ticket-renders against PostgreSQL and the render gate:
 *
 * - delivered: a committed deliverable references it; its MP4 is checked
 *   (regular file, recorded size and SHA-256). Never touched.
 * - active: the gate's live owner, or a running task's current job. Never
 *   touched.
 * - reusable: a finished output of a task that hasn't committed yet (it
 *   will be reused on retry). Never touched.
 * - abandoned: anything else (failed/cancelled/interrupted renders, outputs
 *   of tasks that ended without committing, stray folders). Reported;
 *   removed only with `repair`.
 * Deliverable records whose files are missing or changed are reported
 * (they can only be fixed by restoring a backup).
 */

export interface ReconcileReport {
  delivered: number
  active: string[]
  reusable: string[]
  abandoned: string[]
  removed: string[]
  problems: string[]
}

async function sha256File(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

export async function reconcileTicketRenders(
  db: Queryable,
  dataRoot: string,
  gate: RenderGate,
  { repair = false }: { repair?: boolean } = {},
): Promise<ReconcileReport> {
  const storage = ticketRenderStorage(dataRoot)
  const jobsDir = path.join(storage.root, "jobs")
  const report: ReconcileReport = {
    delivered: 0,
    active: [],
    reusable: [],
    abandoned: [],
    removed: [],
    problems: [],
  }
  const deliverables = (
    await db.query(
      "SELECT pixel_job_id, byte_size, sha256 FROM pixel_deliverables",
    )
  ).rows
  const delivered = new Map(
    deliverables.map((d) => [d.pixel_job_id as string, d]),
  )
  const jobs = (
    await db.query(
      `SELECT j.pixel_job_id, t.status FROM pixel_render_jobs j JOIN worker_tasks t ON t.id = j.task_id WHERE j.pixel_job_id IS NOT NULL`,
    )
  ).rows
  const running = new Set(
    jobs
      .filter((j) => j.status === "running")
      .map((j) => j.pixel_job_id as string),
  )
  const pending = new Set(
    jobs
      .filter((j) => ["queued", "retry_wait"].includes(j.status))
      .map((j) => j.pixel_job_id as string),
  )
  const status = await gate.status()
  const gateJob =
    status.held && status.owner?.storageRoot === storage.root
      ? status.owner.jobId
      : null

  for (const d of deliverables) {
    const file = path.join(jobsDir, d.pixel_job_id, "output", "video.mp4")
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.size !== Number(d.byte_size))
        report.problems.push(
          `${d.pixel_job_id}: the delivered MP4 is missing or has the wrong size`,
        )
      else if ((await sha256File(file)) !== d.sha256)
        report.problems.push(
          `${d.pixel_job_id}: the delivered MP4 doesn't match its checksum`,
        )
    } catch {
      report.problems.push(
        `${d.pixel_job_id}: the delivered MP4 is missing (restore a backup)`,
      )
    }
  }
  let names: string[] = []
  try {
    names = (await fs.readdir(jobsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    names = []
  }
  for (const name of names.sort()) {
    if (!isRenderJobId(name)) {
      report.problems.push(`unrecognised folder ${name} (left alone)`)
      continue
    }
    if (delivered.has(name)) {
      report.delivered++
      continue
    }
    if (name === gateJob || running.has(name)) {
      report.active.push(name)
      continue
    }
    const job = await storage.readJob(name).catch(() => null)
    if (job?.state === "completed" && pending.has(name)) {
      report.reusable.push(name)
      continue
    }
    report.abandoned.push(name)
    if (repair) {
      // Interrupted renders are marked failed first (Pixel refuses to delete active jobs).
      if (job && (job.state === "queued" || job.state === "rendering"))
        await storage
          .transitionJob(name, "failed", {
            error: { code: "interrupted", message: "Abandoned ticket render." },
          })
          .catch(() => undefined)
      try {
        await storage.deleteJob(name as Parameters<typeof storage.deleteJob>[0])
        report.removed.push(name)
      } catch (error) {
        report.problems.push(
          `${name}: couldn't remove (${(error as Error).message})`,
        )
      }
    }
  }
  return report
}
