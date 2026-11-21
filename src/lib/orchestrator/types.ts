import type { RunStatus, TaskStatus } from "@/lib/orchestrator/model"

/** Workflow API contract (DV-004C), shared by the browser and the server. */

export type RunMode = "production" | "verification"
export type ResourceClass = "general" | "cpu" | "render"
export type RecoveryPolicy = "retry" | "inspect"

export interface WorkflowAvailability {
  /** Real Scout → Quill → Pixel → Vera processing. False until DV-005/006. */
  production: boolean
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
  /** Whether a committed (verification) result exists. */
  hasResult: boolean
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
