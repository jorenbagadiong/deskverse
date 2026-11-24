import type pg from "pg"
import {
  APPROVAL_POLICY,
  APPROVAL_REASONS,
  DECISION_FORMAT,
  decisionTransition,
  hasChecklist,
  hasRightsBasis,
  safeExternalUrl,
  type ApprovalReason,
  type DecisionInput,
  type DecisionKind,
} from "@/lib/approvals/policy"
import { AWAITING_QA } from "@/lib/pixel/types"
import { VERA_FORMAT, VERA_RULESET } from "@/lib/vera/types"
import {
  canonicalJson,
  sha256,
  type Queryable,
} from "@/server/orchestrator/canonical"
import {
  transaction,
  currentProductSnapshots,
} from "@/server/orchestrator/store"
import { ticketRenderStorage } from "@/server/pixel/store"
import { loadInputs, LineageError } from "@/server/vera/inputs"
import { aggregateVerdict } from "@/server/vera/rules"
import { getReview } from "@/server/vera/store"
import { fileDigest } from "@/server/vera/video"
import {
  errorResponse,
  HttpError,
  invalid,
  notFound,
} from "@/server/tickets/http"

interface DecisionRow {
  id: string
  kind: DecisionKind
  contract: string
  policy: string
  checklist: unknown
  reason: string
  notes: string
  revision: DecisionInput["revision"]
  previous_id: string | null
  deliverable_id: string
  deliverable_version: number
  deliverable_sha256: string
  review_id: string
  review_version: number
  review_checksum: string
  created_at: Date
}
const DECISION_COLUMNS = `id, kind, contract, policy, checklist, reason, notes, revision,
 previous_id, deliverable_id, deliverable_version, deliverable_sha256, review_id,
 review_version, review_checksum, created_at`

export async function approvalHistory(db: Queryable, id: string, offset = 0) {
  return (
    await db.query(
      `SELECT ${DECISION_COLUMNS} FROM approval_decisions WHERE deliverable_id=$1
     ORDER BY created_at DESC, id DESC LIMIT 21 OFFSET $2`,
      [id, offset],
    )
  ).rows as DecisionRow[]
}

async function candidate(db: Queryable, id: string) {
  const row = (
    await db.query(
      `SELECT d.id, d.ticket_id, d.product_id, d.deliverable_version, d.sha256,
     d.status, d.script_version, d.pixel_job_id, d.byte_size, t.number, t.status AS ticket_status,
     s.data AS snapshot, j.snapshot_checksum,
     NOT EXISTS (SELECT 1 FROM pixel_deliverables newer
       WHERE newer.product_id=d.product_id AND newer.deliverable_version>d.deliverable_version) AS newest,
     (SELECT r.id FROM vera_reviews r WHERE r.deliverable_id=d.id
       ORDER BY r.review_version DESC LIMIT 1) AS review_id
     FROM pixel_deliverables d JOIN affiliate_tickets t ON t.id=d.ticket_id
     JOIN pixel_render_jobs j ON j.id=d.render_job_id
     JOIN run_product_snapshots s ON s.id=j.snapshot_id WHERE d.id=$1`,
      [id],
    )
  ).rows[0]
  if (!row) throw notFound("This video version does not exist.")
  return row
}

/** Revalidate from local source records and media before using an approval. */
export async function approvalEligibility(
  db: Queryable,
  id: string,
  dataRoot: string,
) {
  const row = await candidate(db, id)
  const decision = (
    await db.query(
      `SELECT ${DECISION_COLUMNS} FROM approval_decisions a WHERE a.deliverable_id=$1
       AND NOT EXISTS (SELECT 1 FROM approval_decisions next WHERE next.deliverable_id=$1 AND next.previous_id=a.id)`,
      [id],
    )
  ).rows[0] as DecisionRow | undefined
  const reasons: ApprovalReason[] = []
  if (row.ticket_status === "archived") reasons.push("archived")
  if (!row.newest) reasons.push("superseded")
  const current = (
    await currentProductSnapshots(db, row.ticket_id)
  ).snapshots.find((item) => item.product.id === row.product_id)
  if (current?.checksum !== row.snapshot_checksum)
    reasons.push("inputs_changed")
  let inputs: Awaited<ReturnType<typeof loadInputs>> | null = null
  try {
    inputs = await loadInputs(db, row.ticket_id, id)
  } catch (error) {
    if (!(error instanceof LineageError)) throw error
  }
  if (!inputs || row.status !== AWAITING_QA) reasons.push("lineage")
  const review = row.review_id
    ? await getReview(db, row.ticket_id, row.review_id)
    : null
  if (!review) reasons.push("missing_review")
  else if (
    !inputs ||
    review.integrity !== "verified" ||
    review.document.format !== VERA_FORMAT ||
    review.document.ruleset !== VERA_RULESET ||
    canonicalJson(review.document.pin) !== canonicalJson(inputs.pin)
  )
    reasons.push("review_integrity")
  else if (
    review.document.verdict !== "pass" ||
    aggregateVerdict(review.document.findings) !== "pass"
  )
    reasons.push("qa_blocked")

  if (
    !inputs ||
    !inputs.pin.rightsAcknowledged ||
    !hasRightsBasis(inputs.pin.mediaRights, inputs.pin.mediaRightsNote)
  )
    reasons.push("rights")
  if (!safeExternalUrl(row.snapshot.product.affiliateUrl))
    reasons.push("affiliate")

  const fileMatches = await (async () => {
    try {
      const file = await ticketRenderStorage(dataRoot).resolveCompletedOutput(
        row.pixel_job_id,
      )
      return (
        file &&
        file.sizeBytes === Number(row.byte_size) &&
        (await fileDigest(file.path)) === row.sha256
      )
    } catch {
      return false
    }
  })()
  if (!fileMatches) reasons.push("media_integrity")
  const historical = reasons.some(
    (reason) =>
      reason === "archived" ||
      reason === "superseded" ||
      reason === "inputs_changed",
  )
  const canApprove =
    !reasons.length &&
    decisionTransition(
      decision?.kind ?? null,
      "approved",
      decision?.review_id === review?.id,
    )
  const eligible =
    !reasons.length &&
    decision?.kind === "approved" &&
    decision.policy === APPROVAL_POLICY &&
    decision.contract === DECISION_FORMAT &&
    hasChecklist(decision.checklist) &&
    decision.deliverable_sha256 === row.sha256 &&
    review !== null &&
    decision.review_id === review.id &&
    decision.review_version === review.version &&
    decision.review_checksum === review.checksum
  return {
    eligibility: {
      eligible,
      canApprove,
      historical,
      reasons,
      requiredOwnerActions: [
        ...reasons.map((reason) => APPROVAL_REASONS[reason]),
        ...(decision?.kind === "revision_requested"
          ? ["Review a newly rendered version after correcting the video."]
          : []),
        ...(!reasons.length && canApprove
          ? ["Review this exact video and explicitly confirm its checklist."]
          : []),
      ],
      approvedDeliverableId: eligible ? id : null,
      approvedReviewId: eligible ? review.id : null,
    },
    candidate: {
      id,
      ticketId: row.ticket_id as string,
      ticketNumber: row.number as number,
      productId: row.product_id as string,
      version: row.deliverable_version as number,
      scriptVersion: row.script_version as number,
      snapshot: row.snapshot as {
        ticket: { title: string; platform: string; instructions: string }
        product: {
          name: string
          affiliateUrl: string
          description: string
          mediaRights: string
          mediaRightsNote: string
        }
      },
    },
    decision: decision ?? null,
    review,
    script: inputs?.script.document ?? null,
    sources: inputs?.report.sources ?? [],
  }
}

type Eligibility = Awaited<
  ReturnType<typeof approvalEligibility>
>["eligibility"]

function conflict(message: string): never {
  throw new HttpError(409, "approval-conflict", message)
}

async function lock(c: pg.PoolClient, key: string) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key])
}

export async function recordDecision(
  pool: pg.Pool,
  id: string,
  input: DecisionInput,
  dataRoot: string,
) {
  return transaction(pool, async (c) => {
    await lock(c, `approval-request:${input.requestId}`)
    const requestHash = sha256(canonicalJson({ id, input }))
    const replay = (
      await c.query<
        DecisionRow & {
          request_hash: string
          eligibility_at_decision: Eligibility
        }
      >(
        `SELECT ${DECISION_COLUMNS}, request_hash, eligibility_at_decision FROM approval_decisions WHERE request_id=$1`,
        [input.requestId],
      )
    ).rows[0]
    if (replay) {
      const { request_hash, eligibility_at_decision, ...decision } = replay
      if (request_hash !== requestHash)
        conflict("This request ID was already used for a different decision.")
      return { decision, eligibility: eligibility_at_decision }
    }

    const row = await candidate(c, id)
    // Ticket mutations lock this parent. Pixel and Vera writes serialize on these same keys.
    await c.query("SELECT id FROM affiliate_tickets WHERE id=$1 FOR UPDATE", [
      row.ticket_id,
    ])
    await lock(c, `pixel-deliverable:${row.product_id}`)
    await lock(c, `vera-review:${id}`)
    const detail = await approvalEligibility(c, id, dataRoot)
    const prior = detail.decision
    if ((prior?.id ?? null) !== input.expectedDecisionId)
      conflict(
        "Another decision was recorded. Reload and review the current history.",
      )
    const review = detail.review
    if (
      !review ||
      (input.kind === "withdrawn"
        ? input.reviewId !== prior?.review_id
        : input.reviewId !== review.id)
    )
      return conflict(
        "The Vera assessment changed. Reload and review the latest report.",
      )
    if (
      !decisionTransition(
        prior?.kind ?? null,
        input.kind,
        prior?.review_id === review.id,
      )
    )
      return conflict(
        "This decision does not follow the current decision. Review the history first.",
      )
    if (
      input.kind === "approved" &&
      (!detail.eligibility.canApprove || !hasChecklist(input.checklist))
    )
      conflict(
        detail.eligibility.requiredOwnerActions.join(" ") ||
          "This version cannot be approved.",
      )
    if (
      input.revision?.sceneIds.some(
        (id) => !detail.script?.scenes.some((scene) => scene.id === id),
      )
    )
      throw invalid([], "The revision references a scene outside this video.")
    if (
      input.kind !== "withdrawn" &&
      (review.integrity !== "verified" ||
        review.document.pin.deliverableId !== id)
    )
      conflict("The pinned Vera review could not be verified.")

    const pin =
      input.kind === "withdrawn" && prior
        ? {
            id: prior.review_id,
            version: prior.review_version,
            checksum: prior.review_checksum,
          }
        : review
    const eligible = input.kind === "approved"
    const eligibility: Eligibility = {
      ...detail.eligibility,
      eligible,
      canApprove:
        !detail.eligibility.reasons.length &&
        decisionTransition(input.kind, "approved", pin.id === review.id),
      approvedDeliverableId: eligible ? id : null,
      approvedReviewId: eligible ? pin.id : null,
      requiredOwnerActions: eligible
        ? []
        : detail.eligibility.reasons.map((reason) => APPROVAL_REASONS[reason]),
    }
    const decision = (
      await c.query<DecisionRow>(
        `INSERT INTO approval_decisions (
        ticket_id, product_id, deliverable_id, deliverable_version, deliverable_sha256,
        review_id, review_version, review_checksum, kind, contract, policy,
        checklist, notes, reason, revision, previous_id, request_id, request_hash, eligibility_at_decision
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING ${DECISION_COLUMNS}`,
        [
          row.ticket_id,
          row.product_id,
          id,
          row.deliverable_version,
          row.sha256,
          pin.id,
          pin.version,
          pin.checksum,
          input.kind,
          DECISION_FORMAT,
          APPROVAL_POLICY,
          input.checklist,
          input.notes,
          input.reason,
          input.revision,
          input.expectedDecisionId,
          input.requestId,
          requestHash,
          eligibility,
        ],
      )
    ).rows[0]
    return { decision, eligibility }
  })
}

export async function listApprovals(
  db: Queryable,
  filters: {
    offset: number
    status: string
    platform: string
    search: string
  },
) {
  const rows = (
    await db.query(
      `WITH inbox AS (
       SELECT d.id, d.ticket_id, t.number AS ticket_number,
         s.data->'product'->>'name' AS product_name, s.data->'ticket'->>'platform' AS platform,
         d.deliverable_version, d.script_version, r.review_version, r.verdict,
         coalesce(a.kind, 'pending') AS decision, a.review_id = r.id AS same_review,
         (t.status = 'archived' OR EXISTS (SELECT 1 FROM pixel_deliverables n
           WHERE n.product_id=d.product_id AND n.deliverable_version>d.deliverable_version)) AS historical,
         greatest(d.created_at,r.completed_at,a.created_at) AS updated_at
       FROM pixel_deliverables d JOIN affiliate_tickets t ON t.id=d.ticket_id
       JOIN pixel_render_jobs j ON j.id=d.render_job_id JOIN run_product_snapshots s ON s.id=j.snapshot_id
       LEFT JOIN LATERAL (SELECT id, review_version, verdict, completed_at FROM vera_reviews
         WHERE deliverable_id=d.id ORDER BY review_version DESC LIMIT 1) r ON true
       LEFT JOIN LATERAL (SELECT kind, review_id, created_at FROM approval_decisions head
         WHERE head.deliverable_id=d.id AND NOT EXISTS (SELECT 1 FROM approval_decisions next
           WHERE next.deliverable_id=d.id AND next.previous_id=head.id)) a ON true
       WHERE ($2='' OR s.data->'ticket'->>'platform'=$2)
         AND ($3='' OR strpos(lower('AFT-' || lpad(t.number::text,greatest(4,length(t.number::text)),'0') || ' ' ||
           t.number::text || ' ' || t.title || ' ' ||
           (s.data->'product'->>'name')),lower($3))>0)
     )
     SELECT * FROM inbox WHERE $1='' OR
       CASE $1 WHEN 'historical' THEN historical
         WHEN 'needs_owner_input' THEN verdict='needs_owner_input'
         WHEN 'failed' THEN verdict='failed'
         WHEN 'pending' THEN NOT historical AND (decision='pending' OR (decision='approved' AND NOT same_review))
         ELSE decision=$1 END
     ORDER BY updated_at DESC,id DESC LIMIT 21 OFFSET $4`,
      [filters.status, filters.platform, filters.search, filters.offset],
    )
  ).rows
  return {
    items: rows.slice(0, 20) as {
      id: string
      ticket_id: string
      ticket_number: number
      product_name: string
      platform: string
      deliverable_version: number
      script_version: number
      review_version: number | null
      verdict: import("@/lib/vera/types").Verdict | null
      decision: DecisionKind | "pending"
      same_review: boolean | null
      historical: boolean
      updated_at: string
    }[],
    hasMore: rows.length > 20,
  }
}

export async function recordBulkDecisions(
  db: pg.Pool,
  items: readonly { deliverableId: string; input: DecisionInput }[],
  root: string,
) {
  const results = []
  for (const { deliverableId, input } of items) {
    try {
      results.push({
        deliverableId,
        ok: true,
        ...(await recordDecision(db, deliverableId, input, root)),
      })
    } catch (error) {
      const response = errorResponse(error)
      const { message } = await response.json()
      results.push({
        deliverableId,
        ok: false,
        status: response.status,
        message,
      })
    }
  }
  return results
}
