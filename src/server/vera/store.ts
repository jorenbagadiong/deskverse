import type pg from "pg"
import type {
  VeraDocument,
  VeraFinding,
  VeraOverview,
  VeraReview,
} from "@/lib/vera/types"
import {
  canonicalJson,
  sha256,
  type Queryable,
} from "@/server/orchestrator/canonical"
import { currentProductSnapshots } from "@/server/orchestrator/store"
import type { CommitContext } from "@/server/orchestrator/workflows"
import { getDeliverable } from "@/server/pixel/store"
import { loadInputs, LineageError } from "./inputs"

export const reviewChecksum = (version: number, document: VeraDocument) =>
  sha256(canonicalJson({ version, document }))
export async function persistReview(
  c: pg.PoolClient,
  commit: CommitContext,
  doc: VeraDocument,
  beforeCommit?: () => void,
): Promise<Record<string, unknown>> {
  if (
    doc.taskId !== commit.taskId ||
    doc.runId !== commit.runId ||
    doc.pin.ticketId !== commit.ticketId
  )
    throw Error("Review ownership mismatch")
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `vera-review:${doc.pin.deliverableId}`,
  ])
  const version = (
    await c.query(
      "SELECT coalesce(max(review_version),0)::int+1 AS v FROM vera_reviews WHERE deliverable_id=$1",
      [doc.pin.deliverableId],
    )
  ).rows[0].v
  const checksum = reviewChecksum(version, doc)
  const { findings, ...meta } = doc
  const r = (
    await c.query(
      `INSERT INTO vera_reviews (task_id,run_id,ticket_id,product_id,deliverable_id,deliverable_version,deliverable_sha256,review_version,ruleset,verdict,checksum,document,fence,completed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        commit.taskId,
        commit.runId,
        commit.ticketId,
        doc.pin.productId,
        doc.pin.deliverableId,
        doc.pin.deliverableVersion,
        doc.pin.sha256,
        version,
        doc.ruleset,
        doc.verdict,
        checksum,
        { ...meta, findingCount: findings.length },
        commit.fence,
        doc.completedAt,
      ],
    )
  ).rows[0]
  for (const [i, f] of findings.entries())
    await c.query(
      "INSERT INTO vera_findings (review_id,position,rule_id,category,severity,outcome,scene_id,evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [r.id, i, f.ruleId, f.category, f.severity, f.outcome, f.sceneId, f],
    )
  beforeCommit?.()
  return {
    kind: "vera_review",
    reviewId: r.id,
    reviewVersion: version,
    deliverableId: doc.pin.deliverableId,
    deliverableVersion: doc.pin.deliverableVersion,
    verdict: doc.verdict,
    ruleset: doc.ruleset,
    checksum,
  }
}
async function currentInputs(db: Queryable, ticketId: string) {
  return new Map(
    (await currentProductSnapshots(db, ticketId)).snapshots.map((s) => [
      s.product.id,
      s.checksum,
    ]),
  )
}
export async function getReview(
  db: Queryable,
  ticketId: string,
  reviewId: string,
): Promise<VeraReview | null> {
  const r = (
    await db.query("SELECT * FROM vera_reviews WHERE id=$1 AND ticket_id=$2", [
      reviewId,
      ticketId,
    ])
  ).rows[0]
  if (!r) return null
  const findings = (
    await db.query(
      "SELECT evidence FROM vera_findings WHERE review_id=$1 ORDER BY position",
      [r.id],
    )
  ).rows.map((f) => f.evidence as VeraFinding)
  const { findingCount, ...meta } = r.document
  const doc = { ...meta, findings } as VeraDocument
  return {
    id: r.id,
    version: r.review_version,
    checksum: r.checksum,
    integrity:
      findingCount === findings.length &&
      reviewChecksum(r.review_version, doc) === r.checksum
        ? "verified"
        : "mismatch",
    current:
      (await currentInputs(db, ticketId)).get(r.product_id) ===
      doc.pin.manifest.snapshotChecksum,
    document: doc,
  }
}
export async function veraOverview(
  db: Queryable,
  ticketId: string,
  offset = 0,
  limit = 20,
): Promise<Omit<VeraOverview, "availability">> {
  const current = await currentInputs(db, ticketId)
  const rows = (
    await db.query(
      `SELECT d.id, (SELECT jsonb_build_object('id',r.id,'version',r.review_version,'verdict',r.verdict)
          FROM vera_reviews r WHERE r.deliverable_id=d.id AND r.ticket_id=d.ticket_id ORDER BY r.review_version DESC LIMIT 1) AS latest_review
       FROM pixel_deliverables d WHERE d.ticket_id=$1 ORDER BY d.created_at DESC,d.id LIMIT $2 OFFSET $3`,
      [ticketId, limit, offset],
    )
  ).rows
  const deliverables: VeraOverview["deliverables"] = []
  for (const row of rows) {
    const item = await getDeliverable(db, ticketId, row.id)
    if (!item) continue
    let isCurrent = false,
      reviewProblem: string | null = null
    try {
      const input = await loadInputs(db, ticketId, row.id)
      isCurrent =
        current.get(input.pin.productId) === input.pin.manifest.snapshotChecksum
    } catch (e) {
      if (e instanceof LineageError) reviewProblem = e.message
      else throw e
    }
    deliverables.push({
      ...item.deliverable,
      current: isCurrent,
      reviewProblem,
      latestReview: row.latest_review ?? null,
    })
  }
  const history = (
    await db.query(
      "SELECT id,deliverable_id,deliverable_version,review_version,verdict,completed_at FROM vera_reviews WHERE ticket_id=$1 ORDER BY completed_at DESC,id LIMIT $2 OFFSET $3",
      [ticketId, limit, offset],
    )
  ).rows.map((r) => ({
    id: r.id,
    deliverableId: r.deliverable_id,
    deliverableVersion: r.deliverable_version,
    version: r.review_version,
    verdict: r.verdict,
    createdAt: r.completed_at.toISOString(),
  }))
  const tasks = (
    await db.query(
      `SELECT t.id,t.run_id,t.params->'veraPin'->>'deliverableId' AS deliverable_id,t.status,t.attempts,t.max_attempts,t.failure_message FROM worker_tasks t WHERE t.ticket_id=$1 AND t.stage='vera.review' ORDER BY t.created_at DESC LIMIT 100`,
      [ticketId],
    )
  ).rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    deliverableId: r.deliverable_id,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    message: r.failure_message,
  }))
  const online = (
    await db.query(
      "SELECT 1 FROM orchestrator_workers WHERE last_seen_at > now()-interval '20 seconds' AND 'vera.review'=ANY(stages) LIMIT 1",
    )
  ).rowCount
  return {
    workerOnline: Boolean(online),
    deliverables,
    history,
    tasks,
    offset,
    limit,
  }
}
