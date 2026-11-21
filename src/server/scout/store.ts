import { createHash } from "node:crypto"

import type pg from "pg"

import type {
  ClaimStatus,
  ResearchBrief,
  ResearchClaim,
  ResearchEvidence,
  ResearchOverview,
  ResearchReport,
  ResearchReportSummary,
  ResearchSource,
  ResearchTaskState,
  SourceOutcome,
} from "@/lib/scout/types"
import { canonicalJson } from "@/server/orchestrator/store"
import type { CommitContext } from "@/server/orchestrator/workflows"
import { RESEARCH_WORKFLOW } from "@/server/orchestrator/workflows"
import type { AnalysedSource, Analysis } from "@/server/scout/analysis/claims"

/**
 * Scout research persistence (DV-005A).
 *
 * `persistResearch` runs inside the orchestrator's completion transaction
 * (completeTask → deliverable.persist), after the lease and fence were
 * verified and while the task is still "running". It writes the report,
 * its sources, evidence, claims and claim–evidence links in a handful of
 * statements, then returns the compact reference stored in task_results.
 * The database adds its own guards (0003): the report must come from the
 * task's current lease holder, children can only be added while that task
 * runs, and every row is immutable afterwards. A crash or a stale worker
 * therefore leaves no research rows at all.
 *
 * The checksum covers a canonical document of everything shown to the
 * owner (brief, sources, evidence, claims) plus the run/task/snapshot
 * linkage; reads recompute it, so a restored or tampered report shows up.
 */

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g

/** Strings PostgreSQL can store byte-for-byte (no NUL, no lone surrogates). */
function clean<T>(value: T): T {
  if (typeof value === "string")
    return value.replace(CONTROL, "").replace(LONE_SURROGATE, "�") as T
  if (Array.isArray(value)) return value.map(clean) as T
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        clean(v),
      ]),
    ) as T
  return value
}

const keyNumber = (k: string) => Number(k.slice(1))
const byKey = <T extends { key: string }>(a: T, b: T) =>
  keyNumber(a.key) - keyNumber(b.key)

interface Linkage {
  reportVersion: number
  taskId: string
  runId: string
  snapshotId: string
  productId: string
  snapshotChecksum: string
}

function sourceRecord(s: AnalysedSource): ResearchSource {
  return {
    key: s.key,
    position: s.position,
    referenceKind: s.referenceKind,
    label: s.label,
    requestedUrl: s.requestedUrl,
    finalUrl: s.finalUrl,
    title: s.title,
    outcome: s.outcome,
    httpStatus: s.httpStatus,
    contentType: s.contentType,
    byteCount: s.byteCount,
    contentSha256: s.contentSha256,
    retrievedAt: s.retrievedAt,
    trust: s.trust,
    identified: s.identified,
    transport: s.transport,
    detail: s.detail,
  }
}

/** The canonical document the checksum covers. */
export function reportDocument(
  linkage: Linkage,
  brief: ResearchBrief,
  sources: ResearchSource[],
  evidence: ResearchEvidence[],
  claims: ResearchClaim[],
) {
  return {
    format: "scout-report/1",
    ...linkage,
    brief,
    sources: [...sources].sort(byKey),
    evidence: [...evidence].sort(byKey),
    claims: [...claims].sort(byKey).map((c) => ({
      ...c,
      evidence: [...c.evidence].sort(
        (a, b) => keyNumber(a.key) - keyNumber(b.key),
      ),
    })),
  }
}

export const reportChecksum = (doc: ReturnType<typeof reportDocument>) =>
  sha256(canonicalJson(doc))

function counts(claims: { status: ClaimStatus }[]) {
  const out: Record<ClaimStatus, number> = {
    supported: 0,
    conflicting: 0,
    unverified: 0,
    insufficient_evidence: 0,
  }
  for (const c of claims) out[c.status]++
  return out
}

export async function persistResearch(
  c: pg.PoolClient,
  commit: CommitContext,
  outcome: { analysis: Analysis; sources: AnalysedSource[] },
  faults?: { beforeCommit?: () => void },
): Promise<Record<string, unknown>> {
  const task = (
    await c.query<{
      snapshot_id: string
      product_id: string
      checksum: string
    }>(
      `SELECT t.snapshot_id, s.product_id, s.checksum FROM worker_tasks t
         JOIN run_product_snapshots s ON s.id = t.snapshot_id
        WHERE t.id = $1 AND t.run_id = $2`,
      [commit.taskId, commit.runId],
    )
  ).rows[0]
  if (!task) throw new Error("research task not found")
  // Report versions count per product; allocate them one at a time.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `scout-report:${task.product_id}`,
  ])
  const version = (
    await c.query<{ v: number }>(
      "SELECT coalesce(max(report_version), 0)::int + 1 AS v FROM scout_reports WHERE product_id = $1",
      [task.product_id],
    )
  ).rows[0].v

  const linkage: Linkage = {
    reportVersion: version,
    taskId: commit.taskId,
    runId: commit.runId,
    snapshotId: task.snapshot_id,
    productId: task.product_id,
    snapshotChecksum: task.checksum,
  }
  const doc = clean(
    reportDocument(
      linkage,
      outcome.analysis.brief,
      outcome.sources.map(sourceRecord),
      outcome.analysis.evidence,
      outcome.analysis.claims,
    ),
  )
  const checksum = reportChecksum(doc)

  const report = (
    await c.query<{ id: string }>(
      `INSERT INTO scout_reports (run_id, ticket_id, task_id, snapshot_id, product_id, report_version, schema_version,
                                  status, extraction_mode, fence, snapshot_checksum, checksum, brief)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        commit.runId,
        commit.ticketId,
        commit.taskId,
        task.snapshot_id,
        task.product_id,
        version,
        doc.brief.status,
        doc.brief.extraction.mode,
        commit.fence,
        task.checksum,
        checksum,
        doc.brief,
      ],
    )
  ).rows[0]

  const sourceIds = new Map<string, string>()
  if (doc.sources.length > 0)
    for (const row of (
      await c.query<{ id: string; key: string }>(
        `INSERT INTO scout_sources (report_id, key, position, reference_kind, label, requested_url, final_url, title, outcome,
                                    http_status, content_type, byte_count, content_sha256, retrieved_at, trust, identified, transport, detail)
         SELECT $1, x.key, x.position, x."referenceKind", x.label, x."requestedUrl", x."finalUrl", x.title, x.outcome,
                x."httpStatus", x."contentType", x."byteCount", x."contentSha256", x."retrievedAt", x.trust, x.identified, x.transport, x.detail
           FROM jsonb_to_recordset($2::jsonb) AS x(key text, position int, "referenceKind" text, label text, "requestedUrl" text,
                "finalUrl" text, title text, outcome text, "httpStatus" int, "contentType" text, "byteCount" int,
                "contentSha256" text, "retrievedAt" timestamptz, trust text, identified boolean, transport text, detail text)
         RETURNING id, key`,
        [report.id, JSON.stringify(doc.sources)],
      )
    ).rows)
      sourceIds.set(row.key, row.id)

  const evidenceIds = new Map<string, string>()
  if (doc.evidence.length > 0)
    for (const row of (
      await c.query<{ id: string; key: string }>(
        `INSERT INTO scout_evidence (report_id, source_id, key, method, location, passage, statement, attribute, value, model)
         SELECT $1, (x."sourceId")::uuid, x.key, x.method, x.location, x.passage, x.statement, x.attribute, x.value, x.model
           FROM jsonb_to_recordset($2::jsonb) AS x("sourceId" text, key text, method text, location text, passage text,
                statement text, attribute text, value text, model text)
         RETURNING id, key`,
        [
          report.id,
          JSON.stringify(
            doc.evidence.map((e) => ({
              ...e,
              sourceId: sourceIds.get(e.sourceKey),
            })),
          ),
        ],
      )
    ).rows)
      evidenceIds.set(row.key, row.id)

  const claimIds = new Map<string, string>()
  if (doc.claims.length > 0)
    for (const row of (
      await c.query<{ id: string; key: string }>(
        `INSERT INTO scout_claims (report_id, key, origin, kind, attribute, value, statement, status, reason, topic, time_sensitive)
         SELECT $1, x.key, x.origin, x.kind, x.attribute, x.value, x.statement, x.status, x.reason, x.topic, x."timeSensitive"
           FROM jsonb_to_recordset($2::jsonb) AS x(key text, origin text, kind text, attribute text, value text,
                statement text, status text, reason text, topic text, "timeSensitive" boolean)
         RETURNING id, key`,
        [
          report.id,
          JSON.stringify(
            doc.claims.map((cl) => ({
              key: cl.key,
              origin: cl.origin,
              kind: cl.kind,
              attribute: cl.attribute,
              value: cl.value,
              statement: cl.statement,
              status: cl.status,
              reason: cl.reason,
              topic: cl.topic,
              timeSensitive: cl.timeSensitive,
            })),
          ),
        ],
      )
    ).rows)
      claimIds.set(row.key, row.id)

  const links = doc.claims.flatMap((cl) =>
    cl.evidence.map((e) => ({
      claimId: claimIds.get(cl.key),
      evidenceId: evidenceIds.get(e.key),
      relationship: e.relationship,
    })),
  )
  if (links.length > 0)
    await c.query(
      `INSERT INTO scout_claim_evidence (report_id, claim_id, evidence_id, relationship)
       SELECT $1, (x."claimId")::uuid, (x."evidenceId")::uuid, x.relationship
         FROM jsonb_to_recordset($2::jsonb) AS x("claimId" text, "evidenceId" text, relationship text)`,
      [report.id, JSON.stringify(links)],
    )

  // Test-only crash point (between writing the report and completing the task).
  faults?.beforeCommit?.()

  return {
    kind: "scout_research",
    reportId: report.id,
    reportVersion: version,
    checksum,
    status: doc.brief.status,
    counts: counts(doc.claims),
    sources: {
      read: doc.sources.filter((s) => s.outcome === "ok").length,
      total: doc.sources.length,
    },
  }
}

// ---------------------------------------------------------------------------
// Reads (ownership is always checked through ticket → run → snapshot)
// ---------------------------------------------------------------------------

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null)

export async function getResearchReport(
  pool: pg.Pool,
  ticketId: string,
  runId: string,
  snapshotId: string,
  page: { offset: number; limit: number } = { offset: 0, limit: 100 },
): Promise<ResearchReport | null> {
  const r = (
    await pool.query(
      `SELECT r.*, s.data->'product'->>'name' AS product_name FROM scout_reports r
         JOIN run_product_snapshots s ON s.id = r.snapshot_id AND s.run_id = r.run_id
        WHERE r.ticket_id = $1 AND r.run_id = $2 AND r.snapshot_id = $3`,
      [ticketId, runId, snapshotId],
    )
  ).rows[0]
  if (!r) return null
  const sources: ResearchSource[] = (
    await pool.query("SELECT * FROM scout_sources WHERE report_id = $1", [r.id])
  ).rows
    .map((s) => ({
      key: s.key,
      position: s.position,
      referenceKind: s.reference_kind,
      label: s.label,
      requestedUrl: s.requested_url,
      finalUrl: s.final_url,
      title: s.title,
      outcome: s.outcome,
      httpStatus: s.http_status,
      contentType: s.content_type,
      byteCount: s.byte_count,
      contentSha256: s.content_sha256,
      retrievedAt: iso(s.retrieved_at),
      trust: s.trust,
      identified: s.identified,
      transport: s.transport,
      detail: s.detail,
    }))
    .sort(byKey)
  const evidence: ResearchEvidence[] = (
    await pool.query(
      `SELECT e.*, s.key AS source_key FROM scout_evidence e JOIN scout_sources s ON s.id = e.source_id AND s.report_id = e.report_id
        WHERE e.report_id = $1`,
      [r.id],
    )
  ).rows
    .map((e) => ({
      key: e.key,
      sourceKey: e.source_key,
      method: e.method,
      location: e.location,
      passage: e.passage,
      statement: e.statement,
      attribute: e.attribute,
      value: e.value,
      model: e.model,
    }))
    .sort(byKey)
  const links = (
    await pool.query<{
      claim_key: string
      evidence_key: string
      relationship: string
    }>(
      `SELECT c.key AS claim_key, e.key AS evidence_key, l.relationship FROM scout_claim_evidence l
         JOIN scout_claims c ON c.id = l.claim_id AND c.report_id = l.report_id
         JOIN scout_evidence e ON e.id = l.evidence_id AND e.report_id = l.report_id
        WHERE l.report_id = $1`,
      [r.id],
    )
  ).rows
  const claims: ResearchClaim[] = (
    await pool.query("SELECT * FROM scout_claims WHERE report_id = $1", [r.id])
  ).rows
    .map((c) => ({
      key: c.key,
      origin: c.origin,
      kind: c.kind,
      attribute: c.attribute,
      value: c.value,
      statement: c.statement,
      status: c.status,
      reason: c.reason,
      topic: c.topic,
      timeSensitive: c.time_sensitive,
      evidence: links
        .filter((l) => l.claim_key === c.key)
        .map((l) => ({
          key: l.evidence_key,
          relationship:
            l.relationship as ResearchClaim["evidence"][number]["relationship"],
        }))
        .sort((a, b) => keyNumber(a.key) - keyNumber(b.key)),
    }))
    .sort(byKey)
  const doc = reportDocument(
    {
      reportVersion: r.report_version,
      taskId: r.task_id,
      runId: r.run_id,
      snapshotId: r.snapshot_id,
      productId: r.product_id,
      snapshotChecksum: r.snapshot_checksum,
    },
    r.brief,
    sources,
    evidence,
    claims,
  )
  const limit = Math.min(Math.max(page.limit, 1), 100)
  const offset = Math.max(page.offset, 0)
  return {
    id: r.id,
    runId: r.run_id,
    taskId: r.task_id,
    snapshotId: r.snapshot_id,
    productId: r.product_id,
    productName: r.product_name || "Product",
    reportVersion: r.report_version,
    schemaVersion: r.schema_version,
    status: r.status,
    createdAt: iso(r.created_at)!,
    checksum: r.checksum,
    snapshotChecksum: r.snapshot_checksum,
    integrity: reportChecksum(doc) === r.checksum ? "verified" : "mismatch",
    brief: r.brief,
    sources,
    claims,
    evidence: {
      items: evidence.slice(offset, offset + limit),
      total: evidence.length,
      offset,
      limit,
    },
  }
}

export async function listResearch(
  pool: pg.Pool,
  ticketId: string,
): Promise<Omit<ResearchOverview, "availability">> {
  const reports: ResearchReportSummary[] = (
    await pool.query(
      `SELECT r.id, r.run_id, r.snapshot_id, r.product_id, r.report_version, r.status, r.created_at,
              s.data->'product'->>'name' AS product_name,
              (SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*)::int AS n FROM scout_claims c WHERE c.report_id = r.id GROUP BY status) x) AS counts,
              (SELECT count(*)::int FROM scout_sources x WHERE x.report_id = r.id AND x.outcome = 'ok') AS read,
              (SELECT count(*)::int FROM scout_sources x WHERE x.report_id = r.id) AS total
         FROM scout_reports r JOIN run_product_snapshots s ON s.id = r.snapshot_id AND s.run_id = r.run_id
        WHERE r.ticket_id = $1 ORDER BY r.created_at DESC, r.report_version DESC LIMIT 100`,
      [ticketId],
    )
  ).rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    snapshotId: r.snapshot_id,
    productId: r.product_id,
    productName: r.product_name || "Product",
    reportVersion: r.report_version,
    status: r.status,
    createdAt: iso(r.created_at)!,
    counts: {
      supported: 0,
      conflicting: 0,
      unverified: 0,
      insufficient_evidence: 0,
      ...(r.counts ?? {}),
    },
    sources: { read: r.read, total: r.total },
  }))
  const run = (
    await pool.query(
      "SELECT id, status, ticket_version, created_at FROM campaign_runs WHERE ticket_id = $1 AND workflow = $2 ORDER BY created_at DESC LIMIT 1",
      [ticketId, RESEARCH_WORKFLOW.id],
    )
  ).rows[0]
  let latestRun: ResearchOverview["latestRun"] = null
  if (run) {
    const tasks = (
      await pool.query(
        `SELECT t.id, t.status, t.attempts, t.failure_message, t.snapshot_id, s.product_id, s.position,
                s.data->'product'->>'name' AS product_name,
                (SELECT r.id FROM scout_reports r WHERE r.task_id = t.id) AS report_id,
                (SELECT e.details FROM run_events e WHERE e.task_id = t.id AND e.type IN ('task_needs_input', 'task_failed', 'task_retry_scheduled')
                  ORDER BY e.id DESC LIMIT 1) AS details
           FROM worker_tasks t JOIN run_product_snapshots s ON s.id = t.snapshot_id
          WHERE t.run_id = $1 ORDER BY s.position`,
        [run.id],
      )
    ).rows
    latestRun = {
      id: run.id,
      status: run.status,
      ticketVersion: run.ticket_version,
      createdAt: iso(run.created_at)!,
      tasks: tasks.map((t): ResearchTaskState => ({
        snapshotId: t.snapshot_id,
        productId: t.product_id,
        productName: t.product_name || `Product #${t.position + 1}`,
        taskId: t.id,
        status: t.status,
        attempts: t.attempts,
        failureMessage: t.failure_message,
        sourceProblems: Array.isArray(t.details?.sources)
          ? (t.details.sources as { host?: unknown; outcome?: unknown }[])
              .filter(
                (p) =>
                  typeof p.host === "string" && typeof p.outcome === "string",
              )
              .slice(0, 10)
              .map((p) => ({
                host: p.host as string,
                outcome: p.outcome as SourceOutcome,
              }))
          : [],
        reportId: t.report_id,
      })),
    }
  }
  return { latestRun, reports }
}
