import type pg from "pg"

import { VERA_RULESET } from "@/lib/vera/types"
import { isUuid } from "@/lib/tickets/validation"
import {
  checksumSelection,
  parseCampaignSelections,
} from "@/server/campaign/launch"
import { canonicalJson, sha256 } from "@/server/orchestrator/canonical"
import {
  OrchestratorError,
  type Claim,
  type currentProductSnapshots,
} from "@/server/orchestrator/store"
import { pixelPlanHooks } from "@/server/pixel/plan"
import { getScript } from "@/server/quill/store"
import { verifyScoutReport } from "@/server/scout/store"
import { LineageError, loadInputs } from "@/server/vera/inputs"

type Snapshot = Awaited<
  ReturnType<typeof currentProductSnapshots>
>["snapshots"][number]
type HandoffRow = {
  task_id: string
  stage: string
  status: string
  same_scope: boolean
  result: Record<string, unknown>
  result_kind: string
  snapshot_id: string
  product_id: string
  source_params: Record<string, unknown>
  data: Snapshot["data"]
  checksum: string
  selection: unknown
  selection_checksum: string
  position: number
}

const nextStage: Record<string, string> = {
  "scout.research": "quill.script",
  "quill.script": "pixel.render",
  "pixel.render": "vera.review",
}

function artifactId(value: unknown, message: string) {
  if (typeof value !== "string" || !isUuid(value))
    throw new LineageError(message)
  return value
}

async function scoutPin(
  c: pg.PoolClient,
  claim: Claim,
  row: HandoffRow,
  payload: Record<string, unknown>,
) {
  const message =
    "Scout's exact report does not verify for this product and run."
  const reportId = artifactId(payload.reportId, message)
  const report = await verifyScoutReport(c, reportId)
  const owner = await c.query(
    "SELECT 1 FROM scout_reports WHERE id=$1 AND task_id=$2",
    [reportId, claim.taskId],
  )
  if (
    payload.kind !== "scout_research" ||
    !owner.rowCount ||
    !report?.intact ||
    report.runId !== claim.runId ||
    report.ticketId !== claim.ticketId ||
    report.productId !== row.product_id ||
    report.snapshotId !== row.snapshot_id ||
    report.snapshotChecksum !== row.checksum ||
    report.checksum !== payload.checksum ||
    report.reportVersion !== payload.reportVersion
  )
    throw new LineageError(message)
  return {
    reportId,
    reportVersion: report.reportVersion,
    reportChecksum: report.checksum,
  }
}

async function pixelPin(
  c: pg.PoolClient,
  claim: Claim,
  row: HandoffRow,
  payload: Record<string, unknown>,
) {
  const message =
    "Quill's exact script or its pinned Scout report does not verify for this product and run."
  const scriptId = artifactId(payload.scriptId, message)
  const script = await getScript(c, claim.ticketId, claim.runId, scriptId)
  const report = row.source_params
  if (
    payload.kind !== "quill_script" ||
    !script ||
    script.integrity !== "verified" ||
    script.taskId !== claim.taskId ||
    script.document.productId !== row.product_id ||
    script.document.ticketId !== claim.ticketId ||
    script.document.snapshotChecksum !== row.checksum ||
    script.checksum !== payload.checksum ||
    script.scriptVersion !== payload.scriptVersion ||
    script.document.report.id !== report.reportId ||
    script.document.report.version !== report.reportVersion ||
    script.document.report.checksum !== report.reportChecksum
  )
    throw new LineageError(message)
  if (!script.document.pixel.renderReady)
    throw new LineageError(
      "Quill's script is not ready for Pixel. Review the script and correct the inputs before starting a new campaign.",
    )

  const [selection] = parseCampaignSelections([row.selection])
  if (
    selection.productId !== row.product_id ||
    checksumSelection(row.checksum, selection) !== row.selection_checksum
  )
    throw new LineageError(
      "The frozen campaign image order and rights confirmation failed verification.",
    )

  const hooks = pixelPlanHooks(claim.ticketId, [{ ...selection, scriptId }])
  const [params] = (
    await hooks.prepare!(c, [
      {
        product: { ...row.data.product, position: row.position },
        data: row.data,
        checksum: row.checksum,
      },
    ])
  ).values()
  await hooks.onTask!(c, {
    taskId: row.task_id,
    runId: claim.runId,
    productId: row.product_id,
    snapshotId: row.snapshot_id,
    params,
  })
  return params
}

async function veraPin(
  c: pg.PoolClient,
  claim: Claim,
  row: HandoffRow,
  payload: Record<string, unknown>,
) {
  const message =
    "Pixel's exact deliverable does not verify for this product and run."
  const deliverableId = artifactId(payload.deliverableId, message)
  const { pin, deliverable, renderJob } = await loadInputs(
    c,
    claim.ticketId,
    deliverableId,
  )
  if (
    payload.kind !== "pixel_video" ||
    deliverable.task_id !== claim.taskId ||
    deliverable.run_id !== claim.runId ||
    renderJob.run_id !== claim.runId ||
    pin.manifest.script.runId !== claim.runId ||
    pin.researchLocation.runId !== claim.runId ||
    pin.researchLocation.snapshotId !== row.snapshot_id ||
    pin.productId !== row.product_id ||
    pin.sourceSnapshotId !== row.snapshot_id ||
    pin.manifest.snapshotChecksum !== row.checksum ||
    pin.manifestChecksum !== row.source_params.manifestChecksum ||
    pin.sha256 !== payload.sha256 ||
    pin.deliverableVersion !== payload.deliverableVersion ||
    pin.byteSize !== payload.byteSize
  )
    throw new LineageError(message)
  return { veraPin: pin, ruleset: VERA_RULESET }
}

/** Only the completion transaction calls this, while it holds the run lock and fence. */
export async function handoffCampaignResult(c: pg.PoolClient, claim: Claim) {
  const stage = nextStage[claim.stage]
  if (!stage) return null
  const { rows } = await c.query<HandoffRow>(
    `SELECT next.id AS task_id, next.stage, next.status, next.snapshot_id, s.position,
            next.ticket_id = source.ticket_id AND next.snapshot_id = source.snapshot_id AS same_scope,
            result.payload AS result, result.kind AS result_kind,
            s.product_id, s.data, s.checksum, s.campaign_selection AS selection,
            s.campaign_selection_checksum AS selection_checksum, source.params AS source_params
       FROM task_dependencies edge
       JOIN worker_tasks source ON source.id = edge.depends_on_task_id AND source.run_id = edge.run_id
       JOIN worker_tasks next ON next.id = edge.task_id AND next.run_id = edge.run_id
       JOIN run_product_snapshots s ON s.id = source.snapshot_id AND s.run_id = edge.run_id
       JOIN task_results result ON result.task_id = source.id AND result.run_id = source.run_id
      WHERE edge.run_id = $1 AND source.id = $2 AND source.ticket_id = $3
        AND source.status = 'completed'`,
    [claim.runId, claim.taskId, claim.ticketId],
  )
  const [row] = rows
  if (
    rows.length !== 1 ||
    row.stage !== stage ||
    !row.same_scope ||
    row.status !== "waiting_dependencies"
  )
    throw new Error("Invalid campaign dependency graph.")

  // Validate the handoff before writing the dependent task. On a refusal the
  // original result can still commit for audit, with a blocked product chain.
  await c.query("SAVEPOINT campaign_handoff")
  try {
    if (row.result.kind !== row.result_kind)
      throw new LineageError("The upstream result kind does not verify.")
    if (sha256(canonicalJson(row.data)) !== row.checksum)
      throw new LineageError(
        "The frozen product snapshot failed its checksum check.",
      )
    const params = await (
      stage === "quill.script"
        ? scoutPin
        : stage === "pixel.render"
          ? pixelPin
          : veraPin
    )(c, claim, row, row.result)
    const written = await c.query(
      "UPDATE worker_tasks SET params = $2 WHERE id = $1 AND status = 'waiting_dependencies' AND params = '{}'::jsonb",
      [row.task_id, params],
    )
    if (written.rowCount !== 1) throw new Error("Campaign pin already set.")
    await c.query("RELEASE SAVEPOINT campaign_handoff")
    return null
  } catch (error) {
    if (!(error instanceof LineageError || error instanceof OrchestratorError))
      throw error
    await c.query("ROLLBACK TO SAVEPOINT campaign_handoff")
    await c.query("RELEASE SAVEPOINT campaign_handoff")
    return { taskId: row.task_id, message: error.message.slice(0, 500) }
  }
}
