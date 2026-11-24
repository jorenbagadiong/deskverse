import type { RunStatus, TaskStatus } from "@/lib/orchestrator/model"

/** Workflow API contract (DV-004C), shared by the browser and the server. */

export type RunMode = "production" | "verification"
export type ResourceClass = "general" | "cpu" | "render"
export type RecoveryPolicy = "retry" | "inspect"

export interface CampaignSelection {
  productId: string
  assetIds: string[]
  rightsAcknowledged: true
}

export interface WorkflowAvailability {
  /** The full Scout → Quill → Pixel → Vera campaign. False until automatic pinned result handoffs are verified. */
  production: boolean
  /** Explicit opt-in on a guarded scratch installation. */
  campaignTesting?: boolean
  /** Research-only runs (DV-005A, workflow "scout-research-v1"). */
  research: boolean
  /** What's missing, for the explanation shown to the owner. */
  missing: { stage: string; milestone: string }[]
  /**
   * Deterministic test runs. Only on an isolated test environment (the
   * database-writing E2E suite or `yarn orchestrator:verify`).
   */
  verification: boolean
}

export interface RunSummary {
  id: string
  ticketId: string
  ticketVersion: number
  mode: RunMode
  workflow: string
  status: RunStatus
  counts: Partial<Record<TaskStatus, number>>
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface RunTask {
  id: string
  stage: string
  label: string
  status: TaskStatus
  resourceClass: ResourceClass
  attempts: number
  maxAttempts: number
  failureKind: string | null
  failureMessage: string | null
  eligibleAt: string
  startedAt: string | null
  finishedAt: string | null
  /** Whether a committed result exists (verification result or Scout report). */
  hasResult: boolean
  retryAllowed?: boolean
  result?: { artifactId: string; verdict?: string }
}

export interface RunProduct {
  snapshotId: string
  productId: string
  position: number
  name: string
  checksum: string
  tasks: RunTask[]
}

export interface RunEvent {
  id: number
  type: string
  taskId: string | null
  details: Record<string, unknown>
  createdAt: string
}

export interface RunDetail {
  run: RunSummary
  products: RunProduct[]
  events: RunEvent[]
}

export const runsEndpoint = (ticketId: string) =>
  `/api/tickets/${encodeURIComponent(ticketId)}/runs`
export const runEndpoint = (ticketId: string, runId: string) =>
  `${runsEndpoint(ticketId)}/${encodeURIComponent(runId)}`

/** Fired in the browser after a run is started or controlled, so every section refreshes. */
export const RUNS_CHANGED_EVENT = "deskverse:runs-changed"

/** How a run is described to the owner. */
export function runTitle(run: { mode: RunMode; workflow: string }) {
  if (run.workflow === "campaign-v1") return "Automatic campaign"
  if (run.mode === "verification") return "Verification run (test only)"
  if (run.workflow === "scout-research-v1") return "Research run (Scout only)"
  if (run.workflow === "vera-review-v1") return "Quality review run (Vera only)"
  if (run.workflow === "pixel-render-v1") return "Video run (Pixel only)"
  if (run.workflow === "quill-script-v1")
    return "Scriptwriting run (Quill only)"
  return "Workflow run"
}
