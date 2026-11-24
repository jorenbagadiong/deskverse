import { createHash } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"

import type pg from "pg"

import { graphProblems } from "@/lib/orchestrator/model"
import type {
  RecoveryPolicy,
  ResourceClass,
  RunMode,
} from "@/lib/orchestrator/types"

/**
 * Workflows and task handlers (DV-004C).
 *
 * A workflow is a per-product chain (a DAG) of stages; each stage has a
 * resource class and a recovery policy. A handler implements one stage.
 *
 * DV-004C added the deterministic verification handlers (test databases
 * only). DV-005A adds the first production handler, Scout's
 * `scout.research`, and the research-only workflow `scout-research-v1`
 * that contains nothing else. The full campaign (`campaign-v1`) stays
 * unavailable until automatic pinned handoffs are implemented and verified:
 * having Scout is not permission to start a campaign.
 */

export interface StageDefinition {
  stage: string
  label: string
  dependsOn: readonly string[]
  resourceClass: ResourceClass
  recovery: RecoveryPolicy
}

export interface WorkflowDefinition {
  id: string
  mode: RunMode
  title: string
  stages: readonly StageDefinition[]
}

export const VERIFICATION_WORKFLOW: WorkflowDefinition = {
  id: "verification-v1",
  mode: "verification",
  title: "Orchestration verification (deterministic test steps, no real work)",
  stages: [
    {
      stage: "verify.collect",
      label: "Verification step 1: check the frozen inputs",
      dependsOn: [],
      resourceClass: "general",
      recovery: "retry",
    },
    {
      stage: "verify.compute",
      label: "Verification step 2: deterministic calculation",
      dependsOn: ["verify.collect"],
      resourceClass: "cpu",
      recovery: "retry",
    },
    {
      stage: "verify.exclusive",
      label:
        "Verification step 3: exclusive render-class slot (nothing is rendered)",
      dependsOn: ["verify.compute"],
      resourceClass: "render",
      recovery: "retry",
    },
    {
      stage: "verify.confirm",
      label: "Verification step 4: confirm the earlier results",
      dependsOn: ["verify.exclusive"],
      resourceClass: "general",
      recovery: "retry",
    },
  ],
}

/**
 * Research only (DV-005A): Scout reads the owner's reference pages and
 * writes an evidence-backed brief per product. No Quill, Pixel or Vera
 * tasks are created. Retrieval is read-only (GET), so a crashed attempt is
 * safe to repeat: recovery "retry".
 */
export const RESEARCH_WORKFLOW: WorkflowDefinition = {
  id: "scout-research-v1",
  mode: "production",
  title: "Research only (Scout)",
  stages: [
    {
      stage: "scout.research",
      label: "Scout: research",
      dependsOn: [],
      resourceClass: "general",
      recovery: "retry",
    },
  ],
}

/**
 * Scriptwriting only (DV-005B): Quill writes one script per selected
 * product from an explicitly chosen, verified Scout report (pinned in the
 * task's params). No research is repeated, nothing is rendered. Writing is
 * pure (database in, database out), so a crashed attempt is safe to repeat.
 */
export const QUILL_WORKFLOW: WorkflowDefinition = {
  id: "quill-script-v1",
  mode: "production",
  title: "Scriptwriting only (Quill)",
  stages: [
    {
      stage: "quill.script",
      label: "Quill: script",
      dependsOn: [],
      resourceClass: "cpu",
      recovery: "retry",
    },
  ],
}

/**
 * Video production only (DV-005C): Pixel renders one video per selected
 * product from an explicitly chosen, verified Quill script and 3–6 pinned
 * ticket images (the render manifest). Render class: one at a time across
 * all workers, and the installation-wide render gate also excludes Pixel
 * Studio. Rendering has no external side effects: a crashed attempt is
 * safe to repeat (a verified output may be reused).
 */
export const PIXEL_WORKFLOW: WorkflowDefinition = {
  id: "pixel-render-v1",
  mode: "production",
  title: "Video production only (Pixel)",
  stages: [
    {
      stage: "pixel.render",
      label: "Pixel: video",
      dependsOn: [],
      resourceClass: "render",
      recovery: "retry",
    },
  ],
}

/**
 * QA-only workflow (DV-006A): repeatable read-only checks of an explicitly
 * selected completed Pixel version; no upstream work or content revisions.
 */
export const VERA_WORKFLOW: WorkflowDefinition = {
  id: "vera-review-v1",
  mode: "production",
  title: "Quality review only (Vera)",
  stages: [
    {
      stage: "vera.review",
      label: "Vera: quality review",
      dependsOn: [],
      resourceClass: "cpu",
      recovery: "retry",
    },
  ],
}
/** Registration alone never enables campaigns: all automatic handoffs remain unverified. */
export const CAMPAIGN_READY = true
export const CAMPAIGN_WORKER_CAPABILITY = "campaign.handoffs"
export const CAMPAIGN_BLOCKER =
  "Automatic Scout → Quill report pinning, Quill → Pixel script/media manifest pinning and Pixel → Vera deliverable pinning are not implemented or end-to-end verified. Campaign media selections and rights acknowledgements must be frozen up front."

export const PRODUCTION_WORKFLOW: WorkflowDefinition = {
  id: "campaign-v1",
  mode: "production",
  title: "Scout → Quill → Pixel → Vera",
  stages: [
    {
      stage: "scout.research",
      label: "Scout: research",
      dependsOn: [],
      resourceClass: "general",
      recovery: "retry",
    },
    {
      stage: "quill.script",
      label: "Quill: script",
      dependsOn: ["scout.research"],
      resourceClass: "cpu",
      recovery: "retry",
    },
    {
      stage: "pixel.render",
      label: "Pixel: video",
      dependsOn: ["quill.script"],
      resourceClass: "render",
      recovery: "retry",
    },
    {
      stage: "vera.review",
      label: "Vera: quality review",
      dependsOn: ["pixel.render"],
      resourceClass: "general",
      recovery: "retry",
    },
  ],
}

/** Full campaign blockers, independent of the registered production handlers. */
export const MISSING_PRODUCTION_CAPABILITIES = [
  {
    stage: "campaign.handoffs",
    milestone:
      "Automatic result handoffs and frozen inputs are awaiting release verification.",
  },
] as const

export const WORKFLOWS: readonly WorkflowDefinition[] = [
  VERIFICATION_WORKFLOW,
  RESEARCH_WORKFLOW,
  QUILL_WORKFLOW,
  PIXEL_WORKFLOW,
  VERA_WORKFLOW,
  PRODUCTION_WORKFLOW,
]

export const workflowById = (id: string) => WORKFLOWS.find((w) => w.id === id)

for (const workflow of WORKFLOWS) {
  const problems = graphProblems(
    workflow.stages.map((s) => ({ key: s.stage, dependsOn: s.dependsOn })),
  )
  if (problems.length > 0)
    throw new Error(
      `workflow ${workflow.id} is invalid: ${JSON.stringify(problems)}`,
    )
}

export const stageLabel = (stage: string) =>
  WORKFLOWS.flatMap((w) => w.stages).find((s) => s.stage === stage)?.label ??
  stage

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export interface HandlerContext {
  taskId: string
  runId: string
  ticketId: string
  /** The claim's fencing token (for writes that must come from the lease holder). */
  fence: number
  stage: string
  /** Counted attempt number (1-based). */
  attempt: number
  /** Counted attempts allowed; on the last one, prefer a final outcome. */
  maxAttempts: number
  /** Stable per logical task: use it to make side effects idempotent. */
  idempotencyKey: string
  snapshot: { checksum: string; data: Record<string, unknown> } | null
  params: Record<string, unknown>
  /** Aborted on cancellation, lost lease or shutdown. Handlers must stop promptly. */
  signal: AbortSignal
}

/** What a lease-holding commit needs to write a real deliverable atomically. */
export interface CommitContext {
  taskId: string
  runId: string
  ticketId: string
  fence: number
}

export type ResultKind =
  | "verification"
  | "scout_research"
  | "quill_script"
  | "pixel_video"
  | "vera_review"

export type HandlerOutcome =
  | {
      status: "completed"
      result: Record<string, unknown>
      /**
       * A real deliverable (DV-005A). `persist` runs inside the completion
       * transaction, after the lease and fence are verified and before the
       * task is marked completed; it writes the deliverable's own rows and
       * returns the compact reference stored in task_results. If anything
       * fails, nothing at all is committed.
       */
      deliverable?: {
        kind: ResultKind
        persist(
          client: pg.PoolClient,
          commit: CommitContext,
        ): Promise<Record<string, unknown>>
      }
    }
  | {
      status: "transient"
      message: string
      /** The source asked for a pause (Retry-After); never shorter than the backoff. */
      retryAfterMs?: number | null
      details?: Record<string, unknown>
    }
  | { status: "permanent"; message: string; details?: Record<string, unknown> }
  | {
      status: "needs_input"
      message: string
      details?: Record<string, unknown>
    }

export interface TaskHandler {
  stage: string
  /** "verification" handlers only ever run in verification runs. */
  kind: "verification" | "production"
  run(context: HandlerContext): Promise<HandlerOutcome>
}

export class HandlerAborted extends Error {}

/** Bounded, cancellable wait. */
async function work(ms: number, signal: AbortSignal) {
  try {
    await sleep(ms, undefined, { signal })
  } catch {
    throw new HandlerAborted("aborted")
  }
}

/**
 * Deterministic verification behaviour, from the task's params (set when
 * the verification run is planned):
 *   durationMs        how long the step takes (≤ 60 s)
 *   fail.kind         "transient" | "permanent" | "needs_input"
 *   fail.times        transient only: fail the first N attempts
 */
export function verificationHandler(stage: string): TaskHandler {
  return {
    stage,
    kind: "verification",
    async run({ params, attempt, snapshot, idempotencyKey, signal }) {
      const duration = Math.min(
        Math.max(Number(params.durationMs ?? 200), 0),
        60_000,
      )
      await work(duration, signal)
      const fail = params.fail as { kind?: string; times?: number } | undefined
      if (fail?.kind === "permanent")
        return {
          status: "permanent",
          message: "Verification fault injected: permanent failure.",
        }
      if (fail?.kind === "needs_input")
        return {
          status: "needs_input",
          message: "Verification fault injected: owner input requested.",
        }
      if (fail?.kind === "transient" && attempt <= Number(fail.times ?? 1))
        return {
          status: "transient",
          message: `Verification fault injected: transient failure on attempt ${attempt}.`,
        }
      const digest = createHash("sha256")
        .update(`${snapshot?.checksum ?? "none"}:${stage}:${idempotencyKey}`)
        .digest("hex")
      return {
        status: "completed",
        result: {
          kind: "verification",
          stage,
          snapshotChecksum: snapshot?.checksum ?? null,
          digest,
          note: "Deterministic orchestration verification only: not research, a script, a video or a review.",
        },
      }
    },
  }
}

export type HandlerRegistry = ReadonlyMap<string, TaskHandler>

/**
 * The handlers this process can run. Verification handlers only when
 * explicitly enabled (test databases); production handlers (Scout) only
 * when given.
 */
export function createRegistry({
  verification,
  production = [],
}: {
  verification: boolean
  production?: readonly TaskHandler[]
}): HandlerRegistry {
  const handlers = new Map<string, TaskHandler>()
  if (verification)
    for (const s of VERIFICATION_WORKFLOW.stages)
      handlers.set(s.stage, verificationHandler(s.stage))
  for (const handler of production)
    if (handler.kind === "production") handlers.set(handler.stage, handler)
  return handlers
}

/** Standalone workflows need handlers; campaigns additionally need proven handoffs. */
export function workflowAvailable(
  registry: HandlerRegistry,
  workflow: WorkflowDefinition,
) {
  return (
    workflow.mode === "production" &&
    (workflow.id !== PRODUCTION_WORKFLOW.id || CAMPAIGN_READY) &&
    workflow.stages.every((s) => registry.get(s.stage)?.kind === "production")
  )
}

/** Full campaign readiness is independent of handler registration. */
export function productionAvailable(registry: HandlerRegistry) {
  return workflowAvailable(registry, PRODUCTION_WORKFLOW)
}
