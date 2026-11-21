import { availability, ids, pool } from "@/server/orchestrator/http"
import { listRuns, planRun } from "@/server/orchestrator/store"
import {
  handle,
  invalid,
  jsonBody,
  jsonResponse,
  notFound,
} from "@/server/tickets/http"
import type { VerificationOptions } from "@/server/orchestrator/store"
import { VERIFICATION_WORKFLOW } from "@/server/orchestrator/workflows"

const STAGES: readonly string[] = VERIFICATION_WORKFLOW.stages.map(
  (s) => s.stage,
)

/** Optional deterministic behaviour for verification runs (test environment only). */
function parseVerification(raw: unknown, mode: unknown): VerificationOptions {
  if (raw === undefined) return { durationMs: 400 }
  const bad = () =>
    invalid([
      { path: "verification", message: "Invalid verification options." },
    ])
  if (
    mode !== "verification" ||
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw)
  )
    throw bad()
  const {
    durationMs = 400,
    faults = [],
    ...rest
  } = raw as Record<string, unknown>
  if (
    Object.keys(rest).length > 0 ||
    typeof durationMs !== "number" ||
    !Number.isInteger(durationMs) ||
    durationMs < 0 ||
    durationMs > 5_000 ||
    !Array.isArray(faults) ||
    faults.length > 20
  )
    throw bad()
  for (const f of faults as Record<string, unknown>[]) {
    if (
      !f ||
      Object.keys(f).some(
        (k) => !["product", "stage", "kind", "times"].includes(k),
      ) ||
      !Number.isInteger(f.product) ||
      (f.product as number) < 0 ||
      (f.product as number) > 99 ||
      !STAGES.includes(f.stage as string) ||
      !["transient", "permanent", "needs_input"].includes(f.kind as string) ||
      (f.times !== undefined &&
        (!Number.isInteger(f.times) ||
          (f.times as number) < 1 ||
          (f.times as number) > 9))
    )
      throw bad()
  }
  return { durationMs, faults: faults as VerificationOptions["faults"] }
}

/**
 * GET  /api/tickets/:ticketId/runs  → { availability, runs }
 * POST /api/tickets/:ticketId/runs  { requestId, ticketVersion, mode }
 *   mode "production": refused (503 capability-unavailable) until the real
 *   Scout/Quill/Pixel/Vera handlers exist. mode "verification": only in an
 *   isolated test environment (see availability.verification).
 *   201 { runId } (200 if the requestId was already used).
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/tickets/[ticketId]/runs">,
) {
  return handle(request, async () => {
    const { ticketId } = ids(await ctx.params)
    const exists = await pool().query(
      "SELECT 1 FROM affiliate_tickets WHERE id = $1",
      [ticketId],
    )
    if (!exists.rowCount) throw notFound()
    return jsonResponse({
      availability: availability(),
      runs: await listRuns(pool(), ticketId),
    })
  })
}

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/tickets/[ticketId]/runs">,
) {
  return handle(request, async () => {
    const { ticketId } = ids(await ctx.params)
    const body = await jsonBody(request)
    const extra = Object.keys(body).filter(
      (k) =>
        !["requestId", "ticketVersion", "mode", "verification"].includes(k),
    )
    if (
      extra.length > 0 ||
      typeof body.requestId !== "string" ||
      !/^[A-Za-z0-9-]{16,64}$/.test(body.requestId) ||
      typeof body.ticketVersion !== "number" ||
      !Number.isSafeInteger(body.ticketVersion) ||
      (body.mode !== "production" && body.mode !== "verification")
    )
      throw invalid(
        [],
        "Send { requestId, ticketVersion, mode, verification? }.",
      )
    const verification = parseVerification(body.verification, body.mode)
    const available = availability()
    const { runId, created } = await planRun(pool(), {
      ticketId,
      ticketVersion: body.ticketVersion,
      requestId: body.requestId,
      mode: body.mode,
      productionAvailable: available.production,
      verificationAllowed: available.verification,
      verification,
    })
    return jsonResponse({ runId }, created ? 201 : 200)
  })
}
