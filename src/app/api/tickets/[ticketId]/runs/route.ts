import { parseCampaignSelections } from "@/server/campaign/launch"
import { veraPlanHooks, type ReviewSelection } from "@/server/vera/plan"
import { veraTools } from "@/server/vera/tools"
import { dataRoot, HttpError } from "@/server/tickets/http"
import { pixelPlanHooks, type RenderSelection } from "@/server/pixel/plan"
import {
  availability,
  availableWorkflows,
  ids,
  pool,
} from "@/server/orchestrator/http"
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Quill (DV-005B): [{ productId, reportId }], 1–100, nothing else. */
function parseScripts(raw: unknown) {
  if (raw === undefined) return undefined
  const bad = () =>
    invalid(
      [{ path: "scripts", message: "Choose a research report per product." }],
      "Send scripts as [{ productId, reportId }].",
    )
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) throw bad()
  return raw.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).some((k) => k !== "productId" && k !== "reportId") ||
      typeof item.productId !== "string" ||
      typeof item.reportId !== "string" ||
      !UUID.test(item.productId) ||
      !UUID.test(item.reportId)
    )
      throw bad()
    return {
      productId: item.productId as string,
      reportId: item.reportId as string,
    }
  })
}

/** Pixel (DV-005C): [{ productId, scriptId, assetIds: 3–6, rightsAcknowledged? }], 1–100. */
function parseRenders(raw: unknown): RenderSelection[] | undefined {
  if (raw === undefined) return undefined
  const bad = () =>
    invalid(
      [
        {
          path: "renders",
          message: "Choose a script and 3–6 images per product.",
        },
      ],
      "Send renders as [{ productId, scriptId, assetIds, rightsAcknowledged? }].",
    )
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) throw bad()
  return raw.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).some(
        (k) =>
          !["productId", "scriptId", "assetIds", "rightsAcknowledged"].includes(
            k,
          ),
      ) ||
      typeof item.productId !== "string" ||
      !UUID.test(item.productId) ||
      typeof item.scriptId !== "string" ||
      !UUID.test(item.scriptId) ||
      !Array.isArray(item.assetIds) ||
      item.assetIds.length < 3 ||
      item.assetIds.length > 6 ||
      item.assetIds.some(
        (id: unknown) => typeof id !== "string" || !UUID.test(id),
      ) ||
      (item.rightsAcknowledged !== undefined &&
        typeof item.rightsAcknowledged !== "boolean")
    )
      throw bad()
    return {
      productId: item.productId as string,
      scriptId: item.scriptId as string,
      assetIds: item.assetIds as string[],
      rightsAcknowledged: item.rightsAcknowledged === true,
    }
  })
}

function parseReviews(raw: unknown): ReviewSelection[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100)
    throw invalid([], "Send reviews as [{ productId, deliverableId }].")
  return raw.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).some(
        (k) => !["productId", "deliverableId"].includes(k),
      ) ||
      typeof item.productId !== "string" ||
      !UUID.test(item.productId) ||
      typeof item.deliverableId !== "string" ||
      !UUID.test(item.deliverableId)
    )
      throw invalid([], "Choose one valid deliverable per product.")
    return { productId: item.productId, deliverableId: item.deliverableId }
  })
}

/**
 * GET  /api/tickets/:ticketId/runs  → { availability, runs }
 * POST /api/tickets/:ticketId/runs  { requestId, ticketVersion, mode, workflow?, verification? }
 *   mode "production" + workflow "scout-research-v1" (DV-005A): Scout
 *   research only, when source retrieval is switched on.
 *   mode "production" + explicit "campaign-v1" + campaign selections:
 *   Scout through Vera with ordered images and explicit owner confirmation.
 *   mode "production" + workflow "quill-script-v1" + scripts (DV-005B):
 *   Quill scriptwriting only, from the chosen, verified, current reports.
 *   mode "production" + workflow "pixel-render-v1" + renders (DV-005C):
 *   Pixel video only, from a chosen verified Quill script and 3–6 images.
 *   mode "verification": only in an isolated test environment.
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
      availability: await availability(),
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
        ![
          "requestId",
          "ticketVersion",
          "mode",
          "workflow",
          "verification",
          "scripts",
          "renders",
          "reviews",
          "campaign",
        ].includes(k),
    )
    if (
      extra.length > 0 ||
      typeof body.requestId !== "string" ||
      !/^[A-Za-z0-9-]{16,64}$/.test(body.requestId) ||
      typeof body.ticketVersion !== "number" ||
      !Number.isSafeInteger(body.ticketVersion) ||
      (body.mode !== "production" && body.mode !== "verification") ||
      (body.workflow !== undefined &&
        (typeof body.workflow !== "string" ||
          !/^[a-z0-9.-]{1,40}$/.test(body.workflow)))
    )
      throw invalid(
        [],
        "Send { requestId, ticketVersion, mode, workflow?, verification?, scripts?, renders?, reviews?, campaign? }.",
      )
    const scripts = parseScripts(body.scripts)
    const renders = parseRenders(body.renders)
    const reviews = parseReviews(body.reviews)
    const campaign =
      body.campaign === undefined
        ? undefined
        : parseCampaignSelections(body.campaign)
    if (body.workflow === "campaign-v1" && !campaign)
      throw invalid(
        [],
        "Choose products, ordered images and media-use confirmations.",
      )
    if (
      campaign &&
      (body.workflow !== "campaign-v1" || body.mode !== "production")
    )
      throw invalid(
        [],
        "Campaign selections require an explicit campaign-v1 production request.",
      )
    if (
      (scripts && body.workflow !== "quill-script-v1") ||
      (renders && body.workflow !== "pixel-render-v1") ||
      (reviews && body.workflow !== "vera-review-v1")
    )
      throw invalid([], "Input selections must match their workflow.")
    if (body.workflow === "vera-review-v1") {
      if (!reviews)
        throw invalid([], "Choose completed Pixel deliverables to review.")
      if (!(await veraTools()))
        throw new HttpError(
          503,
          "qa-unavailable",
          "Install local FFmpeg and FFprobe before starting QA.",
        )
    }
    const verification = parseVerification(body.verification, body.mode)
    const available = await availability()
    const { runId, created } = await planRun(pool(), {
      ticketId,
      ticketVersion: body.ticketVersion,
      requestId: body.requestId,
      mode: body.mode,
      workflow: body.workflow as string | undefined,
      productionAvailable:
        available.production || available.campaignTesting === true,
      ...(campaign
        ? {
            campaign: {
              selections: campaign,
              dataRoot: dataRoot(),
              testing: available.campaignTesting !== undefined,
            },
          }
        : {}),
      availableWorkflows: availableWorkflows(),
      verificationAllowed: available.verification,
      verification,
      scripts,
      ...(renders ? pixelPlanHooks(ticketId, renders) : {}),
      ...(reviews ? veraPlanHooks(ticketId, reviews) : {}),
    })
    return jsonResponse({ runId }, created ? 201 : 200)
  })
}
