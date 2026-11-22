import type pg from "pg"

import type {
  QuillOverview,
  QuillProduct,
  QuillScene,
  QuillScript,
  QuillScriptDocument,
  QuillScriptSummary,
  QuillTaskState,
} from "@/lib/quill/types"
import {
  canonicalJson,
  sha256,
  type Queryable,
} from "@/server/orchestrator/canonical"
import { currentProductSnapshots } from "@/server/orchestrator/store"
import type { CommitContext } from "@/server/orchestrator/workflows"
import { QUILL_WORKFLOW } from "@/server/orchestrator/workflows"
import { selectFacts, MIN_ELIGIBLE_FACTS } from "@/server/quill/select"
import { verifyScoutReport } from "@/server/scout/store"

/**
 * Quill script persistence (DV-005B). `persistScript` runs inside the
 * orchestrator's completion transaction (completeTask →
 * deliverable.persist) while the task is still "running" under the
 * claim's fence; the database's own guards (0004) refuse anything else.
 * The checksum covers the whole script (metadata, scenes, claim links)
 * plus its task/run/report linkage; reads recompute it.
 */

interface Linkage {
  scriptVersion: number
  taskId: string
  runId: string
  snapshotId: string
}

export function scriptDocumentChecksum(
  linkage: Linkage,
  doc: QuillScriptDocument,
) {
  return sha256(canonicalJson({ ...linkage, document: doc }))
}

export async function persistScript(
  c: pg.PoolClient,
  commit: CommitContext,
  doc: QuillScriptDocument,
  faults?: { beforeCommit?: () => void },
): Promise<Record<string, unknown>> {
  const task = (
    await c.query<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM worker_tasks WHERE id = $1 AND run_id = $2",
      [commit.taskId, commit.runId],
    )
  ).rows[0]
  if (!task) throw new Error("script task not found")
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `quill-script:${doc.productId}`,
  ])
  const version = (
    await c.query<{ v: number }>(
      "SELECT coalesce(max(script_version), 0)::int + 1 AS v FROM quill_scripts WHERE product_id = $1",
      [doc.productId],
    )
  ).rows[0].v
  const linkage: Linkage = {
    scriptVersion: version,
    taskId: commit.taskId,
    runId: commit.runId,
    snapshotId: task.snapshot_id,
  }
  const checksum = scriptDocumentChecksum(linkage, doc)
  const { scenes, ...meta } = doc
  const script = (
    await c.query<{ id: string }>(
      `INSERT INTO quill_scripts (run_id, ticket_id, task_id, snapshot_id, product_id, report_id, report_version, report_checksum,
                                  snapshot_checksum, script_version, schema_version, generation_mode, language, platform, status,
                                  pixel_text_compatible, render_ready, fence, checksum, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
      [
        commit.runId,
        commit.ticketId,
        commit.taskId,
        task.snapshot_id,
        doc.productId,
        doc.report.id,
        doc.report.version,
        doc.report.checksum,
        doc.snapshotChecksum,
        version,
        doc.generation.mode,
        doc.language,
        doc.platform,
        doc.status,
        doc.pixel.textCompatible,
        doc.pixel.renderReady,
        commit.fence,
        checksum,
        meta,
      ],
    )
  ).rows[0]
  const sceneIds = (
    await c.query<{ id: string; scene_key: string }>(
      `INSERT INTO quill_scenes (script_id, position, scene_key, kind, duration_ms, narration, caption, subtext, visual, notes)
       SELECT $1, x.position, x.id, x.kind, x."durationMs", x.narration, x.caption, x.subtext, x.visual, x.notes
         FROM jsonb_to_recordset($2::jsonb) AS x(position int, id text, kind text, "durationMs" int, narration text,
              caption text, subtext text, visual text, notes jsonb)
       RETURNING id, scene_key`,
      [
        script.id,
        JSON.stringify(scenes.map((s, position) => ({ ...s, position }))),
      ],
    )
  ).rows
  const byKey = new Map(sceneIds.map((r) => [r.scene_key, r.id]))
  const links = scenes.flatMap((s) =>
    s.claims.map((cl) => ({
      sceneId: byKey.get(s.id),
      claimKey: cl.claimKey,
      statement: cl.statement,
      evidenceKeys: cl.evidence.map((e) => e.key),
      evidence: cl.evidence,
    })),
  )
  if (links.length > 0)
    await c.query(
      `INSERT INTO quill_scene_claims (script_id, scene_id, report_id, claim_key, statement, evidence_keys, evidence)
       SELECT $1, (x."sceneId")::uuid, $2, x."claimKey", x.statement,
              ARRAY(SELECT jsonb_array_elements_text(x."evidenceKeys")), x.evidence
         FROM jsonb_to_recordset($3::jsonb) AS x("sceneId" text, "claimKey" text, statement text, "evidenceKeys" jsonb, evidence jsonb)`,
      [script.id, doc.report.id, JSON.stringify(links)],
    )
  // Test-only crash point (between writing the script and completing the task).
  faults?.beforeCommit?.()
  return {
    kind: "quill_script",
    scriptId: script.id,
    scriptVersion: version,
    checksum,
    reportId: doc.report.id,
    reportVersion: doc.report.version,
    mode: doc.generation.mode,
    scenes: scenes.length,
    pixelTextCompatible: doc.pixel.textCompatible,
    renderReady: doc.pixel.renderReady,
  }
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null)

/** One script, through its own ticket and run only; the checksum is recomputed. */
export async function getScript(
  pool: Queryable,
  ticketId: string,
  runId: string,
  scriptId: string,
): Promise<QuillScript | null> {
  const r = (
    await pool.query(
      "SELECT * FROM quill_scripts WHERE id = $1 AND ticket_id = $2 AND run_id = $3",
      [scriptId, ticketId, runId],
    )
  ).rows[0]
  if (!r) return null
  const sceneRows = (
    await pool.query(
      "SELECT * FROM quill_scenes WHERE script_id = $1 ORDER BY position",
      [r.id],
    )
  ).rows
  const claimRows = (
    await pool.query("SELECT * FROM quill_scene_claims WHERE script_id = $1", [
      r.id,
    ])
  ).rows
  const scenes: QuillScene[] = sceneRows.map((s) => ({
    id: s.scene_key,
    kind: s.kind,
    durationMs: s.duration_ms,
    narration: s.narration,
    caption: s.caption,
    subtext: s.subtext,
    visual: s.visual,
    claims: claimRows
      .filter((c) => c.scene_id === s.id)
      .sort(
        (a, b) => Number(a.claim_key.slice(1)) - Number(b.claim_key.slice(1)),
      )
      .map((c) => ({
        claimKey: c.claim_key,
        statement: c.statement,
        evidence: c.evidence,
      })),
    notes: s.notes,
  }))
  const document = { ...r.meta, scenes } as QuillScriptDocument
  const checksum = scriptDocumentChecksum(
    {
      scriptVersion: r.script_version,
      taskId: r.task_id,
      runId: r.run_id,
      snapshotId: r.snapshot_id,
    },
    document,
  )
  return {
    id: r.id,
    runId: r.run_id,
    taskId: r.task_id,
    scriptVersion: r.script_version,
    schemaVersion: r.schema_version,
    createdAt: iso(r.created_at)!,
    checksum: r.checksum,
    integrity: checksum === r.checksum ? "verified" : "mismatch",
    document,
  }
}

function summary(r: Record<string, unknown>): QuillScriptSummary {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    productId: r.product_id as string,
    productName: ((r.meta as { productName?: string })?.productName ??
      "Product") as string,
    scriptVersion: r.script_version as number,
    reportId: r.report_id as string,
    reportVersion: r.report_version as number,
    mode: r.generation_mode as QuillScriptSummary["mode"],
    createdAt: iso(r.created_at)!,
    scenes: Number(r.scenes),
    pixelTextCompatible: r.pixel_text_compatible as boolean,
    renderReady: r.render_ready as boolean,
  }
}

const SUMMARY_SQL = `SELECT q.*, (SELECT count(*) FROM quill_scenes s WHERE s.script_id = q.id) AS scenes FROM quill_scripts q`

/** Scripts of one run (bounded). */
export async function listRunScripts(
  pool: Queryable,
  ticketId: string,
  runId: string,
  limit = 100,
) {
  const rows = (
    await pool.query(
      `${SUMMARY_SQL} WHERE q.ticket_id = $1 AND q.run_id = $2 ORDER BY q.created_at LIMIT $3`,
      [ticketId, runId, Math.min(Math.max(limit, 1), 100)],
    )
  ).rows
  return rows.map(summary)
}

/**
 * Everything the Quill Scripts section needs (DV-005B): per product, the
 * Scout reports it could write from (with whether each still matches the
 * current product, verifies, and has enough eligible facts), the latest
 * Quill run's tasks, and every script version.
 */
export async function quillOverview(
  pool: Queryable,
  ticketId: string,
): Promise<Omit<QuillOverview, "availability">> {
  const { snapshots } = await currentProductSnapshots(pool, ticketId)
  const reportRows = (
    await pool.query(
      "SELECT id, product_id FROM scout_reports WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 200",
      [ticketId],
    )
  ).rows
  const products: QuillProduct[] = []
  for (const s of snapshots) {
    const reports = []
    for (const row of reportRows
      .filter((r) => r.product_id === s.product.id)
      .slice(0, 10)) {
      const v = await verifyScoutReport(pool, row.id)
      if (!v) continue
      const facts = v.intact ? selectFacts(v.report).eligible.length : 0
      const current = v.snapshotChecksum === s.checksum
      reports.push({
        reportId: v.reportId,
        reportVersion: v.reportVersion,
        createdAt: v.report.createdAt,
        status: v.report.status,
        current,
        integrity: v.report.integrity,
        eligibleFacts: facts,
        problem: !v.intact
          ? "Fails its checksum check; Quill won't use it."
          : !current
            ? "The product changed since this research; run Scout again."
            : facts < MIN_ELIGIBLE_FACTS
              ? `Only ${facts} fact${facts === 1 ? "" : "s"} can be used in copy (Quill needs ${MIN_ELIGIBLE_FACTS}).`
              : null,
      })
    }
    products.push({
      productId: s.product.id,
      name:
        String(s.product.name ?? "") || `Product #${s.product.position + 1}`,
      reports,
    })
  }
  const run = (
    await pool.query(
      "SELECT id, status, created_at FROM campaign_runs WHERE ticket_id = $1 AND workflow = $2 ORDER BY created_at DESC LIMIT 1",
      [ticketId, QUILL_WORKFLOW.id],
    )
  ).rows[0]
  let latestRun: QuillOverview["latestRun"] = null
  if (run) {
    const tasks = (
      await pool.query(
        `SELECT t.id, t.status, t.attempts, t.failure_message, t.params, s.product_id, s.position,
                s.data->'product'->>'name' AS product_name,
                (SELECT q.id FROM quill_scripts q WHERE q.task_id = t.id) AS script_id
           FROM worker_tasks t JOIN run_product_snapshots s ON s.id = t.snapshot_id
          WHERE t.run_id = $1 ORDER BY s.position`,
        [run.id],
      )
    ).rows
    latestRun = {
      id: run.id,
      status: run.status,
      createdAt: iso(run.created_at)!,
      tasks: tasks.map((t): QuillTaskState => ({
        productId: t.product_id,
        productName: t.product_name || `Product #${t.position + 1}`,
        taskId: t.id,
        status: t.status,
        attempts: t.attempts,
        failureMessage: t.failure_message,
        reportId: t.params?.reportId ?? null,
        reportVersion: t.params?.reportVersion ?? null,
        scriptId: t.script_id,
      })),
    }
  }
  const scripts = (
    await pool.query(
      `${SUMMARY_SQL} WHERE q.ticket_id = $1 ORDER BY q.created_at DESC, q.script_version DESC LIMIT 100`,
      [ticketId],
    )
  ).rows.map(summary)
  return { products, latestRun, scripts }
}
