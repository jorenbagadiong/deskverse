import type { ReviewPin } from "@/lib/vera/types"
import { VERA_RULESET } from "@/lib/vera/types"
import {
  canonicalJson,
  sha256,
  type Queryable,
} from "@/server/orchestrator/canonical"
import { manifestChecksum, manifestFromRow } from "@/server/pixel/plan"
import { getScript } from "@/server/quill/store"
import { verifyScoutReport } from "@/server/scout/store"

export class LineageError extends Error {}
export async function loadInputs(
  db: Queryable,
  ticketId: string,
  deliverableId: string,
) {
  const d = (
    await db.query(
      "SELECT * FROM pixel_deliverables WHERE id = $1 AND ticket_id = $2",
      [deliverableId, ticketId],
    )
  ).rows[0]
  if (!d)
    throw new LineageError(
      "The selected Pixel deliverable does not belong to this ticket.",
    )
  const j = (
    await db.query(
      "SELECT * FROM pixel_render_jobs WHERE id = $1 AND ticket_id = $2 AND product_id = $3",
      [d.render_job_id, ticketId, d.product_id],
    )
  ).rows[0]
  if (
    !j ||
    j.state !== "completed" ||
    !d.disclosure_verified ||
    j.task_id !== d.task_id ||
    j.pixel_job_id !== d.pixel_job_id ||
    j.script_id !== d.script_id ||
    j.script_version !== d.script_version ||
    j.script_checksum !== d.script_checksum
  )
    throw new LineageError(
      "The Pixel deliverable and completed render manifest do not match.",
    )
  const s = (
    await db.query(
      "SELECT run_id FROM quill_scripts WHERE id = $1 AND ticket_id = $2 AND product_id = $3",
      [j.script_id, ticketId, d.product_id],
    )
  ).rows[0]
  const script = s ? await getScript(db, ticketId, s.run_id, j.script_id) : null
  if (
    !script ||
    script.integrity !== "verified" ||
    script.checksum !== j.script_checksum ||
    script.scriptVersion !== j.script_version ||
    script.document.ticketId !== ticketId ||
    script.document.productId !== d.product_id
  )
    throw new LineageError(
      "The exact pinned Quill script is missing, corrupt or owned by another product.",
    )
  const manifest = manifestFromRow(j, script.runId)
  if (manifestChecksum(manifest) !== j.manifest_checksum)
    throw new LineageError(
      "The pinned render manifest checksum does not verify.",
    )
  const report = await verifyScoutReport(db, j.report_id)
  if (
    !report?.intact ||
    report.ticketId !== ticketId ||
    report.productId !== d.product_id ||
    report.reportVersion !== j.report_version ||
    report.checksum !== j.report_checksum ||
    canonicalJson(script.document.report) !== canonicalJson(manifest.report) ||
    report.snapshotChecksum !== j.snapshot_checksum ||
    script.document.snapshotChecksum !== j.snapshot_checksum
  )
    throw new LineageError(
      "The exact Scout report, script and frozen product lineage do not verify.",
    )
  const snapshot = (
    await db.query(
      "SELECT data, checksum FROM run_product_snapshots WHERE id = $1 AND ticket_id = $2 AND product_id = $3",
      [j.snapshot_id, ticketId, d.product_id],
    )
  ).rows[0]
  if (
    !snapshot ||
    snapshot.checksum !== j.snapshot_checksum ||
    sha256(canonicalJson(snapshot.data)) !== snapshot.checksum
  )
    throw new LineageError(
      "The original frozen product snapshot fails verification.",
    )
  const product = snapshot.data.product as {
    id: string
    mediaRights?: string
    mediaRightsNote?: string
    assets?: { id: string; sha256: string; kind: string }[]
  }
  if (
    product.id !== d.product_id ||
    new Set(manifest.assets.map((a) => a.id)).size !== manifest.assets.length ||
    manifest.assets.some(
      (a) =>
        !product.assets?.some(
          (f) => f.id === a.id && f.sha256 === a.sha256 && f.kind === "image",
        ),
    )
  )
    throw new LineageError(
      "The manifest uses images outside its original frozen product.",
    )
  const pin: ReviewPin = {
    ticketId,
    productId: d.product_id,
    deliverableId: d.id,
    deliverableVersion: d.deliverable_version,
    sha256: d.sha256,
    byteSize: Number(d.byte_size),
    renderJobId: j.id,
    manifestChecksum: j.manifest_checksum,
    manifest,
    researchLocation: { runId: report.runId, snapshotId: report.snapshotId },
    sourceSnapshotId: j.snapshot_id,
    mediaRights: product.mediaRights ?? "unspecified",
    mediaRightsNote: product.mediaRightsNote ?? "",
    rightsAcknowledged: j.rights_acknowledged,
    ruleset: VERA_RULESET,
  }
  return { pin, deliverable: d, renderJob: j, script, report: report.report }
}
