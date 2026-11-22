import path from "node:path"

import type pg from "pg"

import {
  AWAITING_QA,
  type PixelDeliverable,
  type PixelOverview,
  type PixelProduct,
  type PixelRenderState,
  type RenderState,
} from "@/lib/pixel/types"
import type { RenderProgress } from "@/lib/video/render-job"
import type { Queryable } from "@/server/orchestrator/canonical"
import { currentProductSnapshots } from "@/server/orchestrator/store"
import type { CommitContext } from "@/server/orchestrator/workflows"
import { PIXEL_WORKFLOW } from "@/server/orchestrator/workflows"
import { getScript } from "@/server/quill/store"
import { createVideoStorage, type VideoStorage } from "@/server/video/storage"

/**
 * Pixel ticket video persistence (DV-005C).
 *
 * Files: ticket renders live in their OWN private Pixel storage,
 * `<data>/ticket-renders/video/jobs/<job>/` (Pixel's storage code, a
 * separate root): Pixel Studio never lists, retries, deletes or cleans
 * them, and its startup recovery can't mistake them for its own jobs. The
 * finished MP4 stays where Pixel's renderer published it (no copy).
 *
 * Database: render state is written only by the current lease holder
 * (fenced); a deliverable is written in the transaction that completes
 * the task, guarded by triggers (0005), and never changes afterwards.
 */

export const TICKET_RENDER_DIR = "ticket-renders"

export function ticketRenderStorage(dataRoot: string): VideoStorage {
  return createVideoStorage(
    path.join(path.resolve(dataRoot), TICKET_RENDER_DIR),
  )
}

/** Updates render state, only while `fence` is still the task's current, running fence. */
export async function setRenderState(
  db: Queryable,
  renderJobId: string,
  fence: number,
  patch: {
    state?: RenderState
    pixelJobId?: string
    progress?: RenderProgress | null
    error?: string | null
  },
) {
  const r = await db.query(
    `UPDATE pixel_render_jobs j SET
        state = coalesce($3, j.state),
        pixel_job_id = coalesce($4, j.pixel_job_id),
        attempt_fence = $2,
        progress = CASE WHEN $5::boolean THEN $6::jsonb ELSE j.progress END,
        error = CASE WHEN $7::boolean THEN $8 ELSE j.error END,
        updated_at = now()
      WHERE j.id = $1 AND EXISTS (SELECT 1 FROM worker_tasks t WHERE t.id = j.task_id AND t.fence = $2 AND t.status = 'running')`,
    [
      renderJobId,
      fence,
      patch.state ?? null,
      patch.pixelJobId ?? null,
      patch.progress !== undefined,
      patch.progress === undefined ? null : JSON.stringify(patch.progress),
      patch.error !== undefined,
      patch.error?.slice(0, 500) ?? null,
    ],
  )
  return (r.rowCount ?? 0) > 0
}

export interface VerifiedVideo {
  pixelJobId: string
  sha256: string
  byteSize: number
  width: number
  height: number
  durationMs: number
  fps: number
  videoCodec: string
  pixelFormat: string
  audio: boolean
  encoder: string
  checks: Record<string, unknown>
}

export async function persistDeliverable(
  c: pg.PoolClient,
  commit: CommitContext,
  renderJob: {
    id: string
    productId: string
    scriptId: string
    scriptVersion: number
    scriptChecksum: string
  },
  video: VerifiedVideo,
  faults?: { beforeCommit?: () => void },
): Promise<Record<string, unknown>> {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `pixel-deliverable:${renderJob.productId}`,
  ])
  const version = (
    await c.query<{ v: number }>(
      "SELECT coalesce(max(deliverable_version), 0)::int + 1 AS v FROM pixel_deliverables WHERE product_id = $1",
      [renderJob.productId],
    )
  ).rows[0].v
  const row = (
    await c.query<{ id: string }>(
      `INSERT INTO pixel_deliverables (render_job_id, run_id, ticket_id, task_id, product_id, script_id, script_version, script_checksum,
                                       deliverable_version, pixel_job_id, sha256, byte_size, width, height, duration_ms, fps, video_codec,
                                       pixel_format, audio, encoder, disclosure_verified, checks, status, fence, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, true, $21, $22, $23, clock_timestamp())
       RETURNING id`,
      [
        renderJob.id,
        commit.runId,
        commit.ticketId,
        commit.taskId,
        renderJob.productId,
        renderJob.scriptId,
        renderJob.scriptVersion,
        renderJob.scriptChecksum,
        version,
        video.pixelJobId,
        video.sha256,
        video.byteSize,
        video.width,
        video.height,
        video.durationMs,
        video.fps,
        video.videoCodec,
        video.pixelFormat,
        video.audio,
        video.encoder,
        video.checks,
        AWAITING_QA,
        commit.fence,
      ],
    )
  ).rows[0]
  await c.query(
    "UPDATE pixel_render_jobs SET state = 'completed', progress = NULL, error = NULL, updated_at = now() WHERE id = $1",
    [renderJob.id],
  )
  faults?.beforeCommit?.()
  return {
    kind: "pixel_video",
    deliverableId: row.id,
    deliverableVersion: version,
    sha256: video.sha256,
    byteSize: video.byteSize,
    durationMs: video.durationMs,
    scriptId: renderJob.scriptId,
    scriptVersion: renderJob.scriptVersion,
  }
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null)

function deliverableOf(r: Record<string, unknown>): PixelDeliverable {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    productId: r.product_id as string,
    productName: (r.product_name as string) || "Product",
    version: r.deliverable_version as number,
    scriptId: r.script_id as string,
    scriptVersion: r.script_version as number,
    scriptChecksum: r.script_checksum as string,
    sha256: r.sha256 as string,
    byteSize: Number(r.byte_size),
    width: r.width as number,
    height: r.height as number,
    durationMs: r.duration_ms as number,
    fps: r.fps as number,
    videoCodec: r.video_codec as string,
    pixelFormat: r.pixel_format as string,
    audio: r.audio as boolean,
    encoder: r.encoder as string,
    disclosureVerified: r.disclosure_verified as boolean,
    checks: r.checks as Record<string, unknown>,
    status: AWAITING_QA,
    verifiedAt: iso(r.verified_at)!,
    createdAt: iso(r.created_at)!,
  }
}

const DELIVERABLE_SQL = `SELECT d.*, s.data->'product'->>'name' AS product_name FROM pixel_deliverables d
  JOIN pixel_render_jobs j ON j.id = d.render_job_id JOIN run_product_snapshots s ON s.id = j.snapshot_id`

/** One deliverable, through its own ticket only (plus its Pixel job for serving). */
export async function getDeliverable(
  db: Queryable,
  ticketId: string,
  deliverableId: string,
) {
  const r = (
    await db.query(`${DELIVERABLE_SQL} WHERE d.id = $1 AND d.ticket_id = $2`, [
      deliverableId,
      ticketId,
    ])
  ).rows[0]
  return r
    ? { deliverable: deliverableOf(r), pixelJobId: r.pixel_job_id as string }
    : null
}

export async function pixelOverview(
  db: Queryable,
  ticketId: string,
): Promise<Omit<PixelOverview, "availability">> {
  const { snapshots } = await currentProductSnapshots(db, ticketId)
  const assetRows = (
    await db.query(
      "SELECT id, product_id, mime_type, sha256, width, height, original_name FROM ticket_assets WHERE ticket_id = $1 AND kind = 'image' ORDER BY position, created_at",
      [ticketId],
    )
  ).rows
  const scriptRows = (
    await db.query(
      `SELECT q.id, q.run_id, q.product_id,
              ARRAY(SELECT a->>'id' FROM jsonb_array_elements(s.data->'product'->'assets') a WHERE a->>'kind' = 'image') AS image_ids
         FROM quill_scripts q JOIN run_product_snapshots s ON s.id = q.snapshot_id
        WHERE q.ticket_id = $1 ORDER BY q.created_at DESC LIMIT 100`,
      [ticketId],
    )
  ).rows
  const products: PixelProduct[] = []
  for (const s of snapshots) {
    const product = s.data.product as { mediaRights?: string }
    const productScripts = scriptRows
      .filter((r) => r.product_id === s.product.id)
      .slice(0, 10)
    // "In the script's input": the images frozen with the newest script
    // (images uploaded later can't be used with it).
    const frozenIds = new Set<string>(productScripts[0]?.image_ids ?? [])
    const scripts = []
    for (const row of productScripts) {
      const script = await getScript(db, ticketId, row.run_id, row.id)
      if (!script) continue
      const current = script.document.snapshotChecksum === s.checksum
      scripts.push({
        scriptId: script.id,
        scriptVersion: script.scriptVersion,
        reportVersion: script.document.report.version,
        createdAt: script.createdAt,
        integrity: script.integrity,
        current,
        textCompatible: script.document.pixel.textCompatible,
        imageIds: row.image_ids as string[],
        problem:
          script.integrity !== "verified"
            ? "Fails its checksum check."
            : !current
              ? "The product changed after this script (e.g. new images). Run Scout and Quill again."
              : !script.document.pixel.textCompatible
                ? "Doesn't fit Pixel's text limits."
                : null,
      })
    }
    products.push({
      productId: s.product.id,
      name:
        String(s.product.name ?? "") || `Product #${s.product.position + 1}`,
      mediaRights: product.mediaRights ?? "unspecified",
      images: assetRows
        .filter((a) => a.product_id === s.product.id)
        .map((a) => ({
          assetId: a.id,
          sha256: a.sha256,
          mimeType: a.mime_type,
          width: a.width,
          height: a.height,
          name: a.original_name,
          inScriptInput: frozenIds.has(a.id),
        })),
      scripts,
    })
  }
  const run = (
    await db.query(
      "SELECT id, status, created_at FROM campaign_runs WHERE ticket_id = $1 AND workflow = $2 ORDER BY created_at DESC LIMIT 1",
      [ticketId, PIXEL_WORKFLOW.id],
    )
  ).rows[0]
  let latestRun: PixelOverview["latestRun"] = null
  if (run) {
    const rows = (
      await db.query(
        `SELECT j.*, t.status AS task_status, t.failure_message, t.attempts, s.data->'product'->>'name' AS product_name,
                (SELECT d.id FROM pixel_deliverables d WHERE d.task_id = t.id) AS deliverable_id
           FROM pixel_render_jobs j JOIN worker_tasks t ON t.id = j.task_id JOIN run_product_snapshots s ON s.id = j.snapshot_id
          WHERE j.run_id = $1 ORDER BY s.position`,
        [run.id],
      )
    ).rows
    latestRun = {
      id: run.id,
      status: run.status,
      createdAt: iso(run.created_at)!,
      renders: rows.map((r): PixelRenderState => ({
        renderJobId: r.id,
        taskId: r.task_id,
        productId: r.product_id,
        productName: r.product_name || "Product",
        taskStatus: r.task_status,
        state: r.state,
        progress: r.task_status === "running" ? (r.progress ?? null) : null,
        error: r.error,
        failureMessage: r.failure_message,
        attempts: r.attempts,
        scriptVersion: r.script_version,
        deliverableId: r.deliverable_id,
      })),
    }
  }
  const deliverables = (
    await db.query(
      `${DELIVERABLE_SQL} WHERE d.ticket_id = $1 ORDER BY d.created_at DESC LIMIT 100`,
      [ticketId],
    )
  ).rows.map(deliverableOf)
  return { products, latestRun, deliverables }
}
