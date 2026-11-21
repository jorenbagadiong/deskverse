import { createHash } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"

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
 * DV-004C ships NO production handlers. The production workflow below is
 * declared so its shape is fixed and validated, but every stage is marked
 * unavailable, so production runs are refused ("capability not available
 * yet"). Only the deterministic verification handlers exist; they prove the
 * orchestration infrastructure and produce results explicitly labelled as
 * verification results, never research, scripts, videos or reviews.
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
 * The future production chain. Not runnable in DV-004C: no handler exists
 * for any stage. Publishing (Relay) will use recovery "inspect": a crashed
 * attempt might already have published, so it is never retried blindly.
 */
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

/** Milestones that will provide the production handlers. */
export const MISSING_PRODUCTION_CAPABILITIES = [
  { stage: "scout.research", milestone: "DV-005A" },
  { stage: "quill.script", milestone: "DV-005B" },
  {
    stage: "pixel.render",
    milestone: "DV-005C (needs a render gate shared with Pixel Studio)",
  },
  { stage: "vera.review", milestone: "DV-006A" },
] as const

for (const workflow of [VERIFICATION_WORKFLOW, PRODUCTION_WORKFLOW]) {
  const problems = graphProblems(
    workflow.stages.map((s) => ({ key: s.stage, dependsOn: s.dependsOn })),
  )
  if (problems.length > 0)
    throw new Error(
      `workflow ${workflow.id} is invalid: ${JSON.stringify(problems)}`,
    )
}

export const stageLabel = (stage: string) =>
  [...VERIFICATION_WORKFLOW.stages, ...PRODUCTION_WORKFLOW.stages].find(
    (s) => s.stage === stage,
  )?.label ?? stage

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export interface HandlerContext {
  taskId: string
  runId: string
  stage: string
  /** Counted attempt number (1-based). */
  attempt: number
  /** Stable per logical task: use it to make side effects idempotent. */
  idempotencyKey: string
  snapshot: { checksum: string; data: Record<string, unknown> } | null
  params: Record<string, unknown>
  /** Aborted on cancellation, lost lease or shutdown. Handlers must stop promptly. */
  signal: AbortSignal
}

export type HandlerOutcome =
  | { status: "completed"; result: Record<string, unknown> }
  | { status: "transient"; message: string }
  | { status: "permanent"; message: string }
  | { status: "needs_input"; message: string }

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
 * The handlers this process can run. Production: none in DV-004C.
 * Verification handlers are included only when explicitly enabled.
 */
export function createRegistry({
  verification,
}: {
  verification: boolean
}): HandlerRegistry {
  const handlers = new Map<string, TaskHandler>()
  if (verification)
    for (const s of VERIFICATION_WORKFLOW.stages)
      handlers.set(s.stage, verificationHandler(s.stage))
  return handlers
}

/** Production runs need a handler for every production stage. */
export function productionAvailable(registry: HandlerRegistry) {
  return PRODUCTION_WORKFLOW.stages.every(
    (s) => registry.get(s.stage)?.kind === "production",
  )
}
