/**
 * Campaign orchestration model (DV-004C). Pure and client-safe: states,
 * allowed transitions, DAG checks, retry/backoff, lease rules and progress.
 * The server enforces every rule again inside PostgreSQL transactions.
 */

// ---------------------------------------------------------------------------
// Task states
// ---------------------------------------------------------------------------

export const TASK_STATUSES = [
  /** Prerequisites haven't all completed yet. */
  "waiting_dependencies",
  /** Eligible: a worker may claim it. */
  "queued",
  /** Claimed by one worker under a lease. */
  "running",
  /** Failed transiently; claimable again after `eligible_at`. */
  "retry_wait",
  "completed",
  /** Permanent failure, or retries exhausted. */
  "failed",
  /** Can't continue without the owner (missing input, interrupted side effect). */
  "needs_input",
  /** A prerequisite failed, needs input, or is blocked itself. Never ran. */
  "blocked",
  "cancelled",
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/**
 *   waiting_dependencies ─▶ queued ─▶ running ─▶ completed
 *        │                    ▲         │ ├──▶ retry_wait ─▶ running …
 *        ▼                    │         │ ├──▶ failed / needs_input
 *      blocked ──(upstream    │         │ └──▶ queued (lease expired, retry policy)
 *       retried)──────────────┘         ▼
 *                                  cancelled (from any unfinished state)
 *   failed / needs_input ──manual retry──▶ queued
 */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  waiting_dependencies: ["queued", "blocked", "cancelled"],
  queued: ["running", "cancelled"],
  running: [
    "completed",
    "retry_wait",
    "failed",
    "needs_input",
    "cancelled",
    "queued",
  ],
  retry_wait: ["running", "cancelled"],
  completed: [],
  failed: ["queued"],
  needs_input: ["queued"],
  blocked: ["waiting_dependencies", "cancelled"],
  cancelled: [],
}

export const canTaskTransition = (from: TaskStatus, to: TaskStatus) =>
  TASK_TRANSITIONS[from].includes(to)

/** Still has work ahead of it (counts towards an unfinished run). */
export const UNFINISHED_TASK_STATUSES: readonly TaskStatus[] = [
  "waiting_dependencies",
  "queued",
  "running",
  "retry_wait",
]

/** Ended without success; descendants become blocked. */
export const UNSUCCESSFUL_TASK_STATUSES: readonly TaskStatus[] = [
  "failed",
  "needs_input",
  "blocked",
  "cancelled",
]

// ---------------------------------------------------------------------------
// Run states
// ---------------------------------------------------------------------------

export const RUN_STATUSES = [
  "queued",
  "running",
  "pausing",
  "paused",
  "cancelling",
  "cancelled",
  "completed",
  "completed_with_errors",
  "failed",
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/**
 *   queued ──first claim──▶ running ──all tasks settled──▶ completed
 *     │ │                    │  │                          completed_with_errors
 *     │ │                    │  └─pause─▶ pausing ─settled─▶ paused ─resume─▶ running/queued
 *     │ └─pause─────────────────────────────────────────────▶ paused
 *     └─cancel─▶ cancelled   └─cancel─▶ cancelling ─settled─▶ cancelled
 *                                        (pausing/paused can be cancelled too)
 *   pausing ─resume─▶ running (the pause is withdrawn)
 *   completed_with_errors / failed ─manual task retry─▶ running
 */
export const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: [
    "running",
    "paused",
    "cancelled",
    "completed",
    "completed_with_errors",
    "failed",
  ],
  running: [
    "pausing",
    "paused",
    "cancelling",
    "cancelled",
    "completed",
    "completed_with_errors",
    "failed",
  ],
  pausing: [
    "running",
    "paused",
    "cancelling",
    "cancelled",
    "completed",
    "completed_with_errors",
    "failed",
  ],
  paused: ["queued", "running", "cancelling", "cancelled"],
  cancelling: ["cancelled"],
  cancelled: [],
  completed: [],
  completed_with_errors: ["running"],
  failed: ["running"],
}

export const canRunTransition = (from: RunStatus, to: RunStatus) =>
  RUN_TRANSITIONS[from].includes(to)

/** Runs that still hold their ticket (at most one per ticket). */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "pausing",
  "paused",
  "cancelling",
]

/** Runs whose tasks may be claimed. */
export const CLAIMABLE_RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
]

export const isActiveRun = (status: RunStatus) =>
  ACTIVE_RUN_STATUSES.includes(status)

/** Which controls are valid for a run in this state. */
export function runControls(status: RunStatus) {
  return {
    pause: status === "queued" || status === "running",
    resume: status === "paused" || status === "pausing",
    cancel:
      status === "queued" ||
      status === "running" ||
      status === "pausing" ||
      status === "paused",
  }
}

/**
 * The run's state once nothing is running any more, decided from its
 * tasks. Returns null while work remains.
 */
export function settledRunStatus(
  current: RunStatus,
  counts: Partial<Record<TaskStatus, number>>,
): RunStatus | null {
  const n = (s: TaskStatus) => counts[s] ?? 0
  if (n("running") > 0) return null
  if (current === "cancelling") return "cancelled"
  if (current === "pausing") return "paused"
  if (current === "paused" || current === "cancelled") return null
  const unfinished = UNFINISHED_TASK_STATUSES.reduce((sum, s) => sum + n(s), 0)
  if (unfinished > 0) return null
  const unsuccessful = UNSUCCESSFUL_TASK_STATUSES.reduce(
    (sum, s) => sum + n(s),
    0,
  )
  if (unsuccessful === 0) return "completed"
  return n("completed") > 0 ? "completed_with_errors" : "failed"
}

// ---------------------------------------------------------------------------
// Graphs
// ---------------------------------------------------------------------------

export interface GraphNode {
  key: string
  dependsOn: readonly string[]
}

export type GraphProblem =
  | { kind: "duplicate-node"; key: string }
  | { kind: "missing-dependency"; key: string; dependsOn: string }
  | { kind: "self-dependency"; key: string }
  | { kind: "duplicate-edge"; key: string; dependsOn: string }
  | { kind: "cycle"; keys: string[] }

/** Every structural problem in a task graph (empty means a valid DAG). */
export function graphProblems(nodes: readonly GraphNode[]): GraphProblem[] {
  const problems: GraphProblem[] = []
  const keys = new Set<string>()
  for (const node of nodes) {
    if (keys.has(node.key))
      problems.push({ kind: "duplicate-node", key: node.key })
    keys.add(node.key)
  }
  for (const node of nodes) {
    const seen = new Set<string>()
    for (const dep of node.dependsOn) {
      if (dep === node.key)
        problems.push({ kind: "self-dependency", key: node.key })
      else if (!keys.has(dep))
        problems.push({
          kind: "missing-dependency",
          key: node.key,
          dependsOn: dep,
        })
      if (seen.has(dep))
        problems.push({ kind: "duplicate-edge", key: node.key, dependsOn: dep })
      seen.add(dep)
    }
  }
  const cycle = findCycle(nodes)
  if (cycle) problems.push({ kind: "cycle", keys: cycle })
  return problems
}

/** One cycle (as a key path), or null. Iterative DFS, safe for large graphs. */
export function findCycle(nodes: readonly GraphNode[]): string[] | null {
  const edges = new Map(
    nodes.map((n) => [n.key, n.dependsOn.filter((d) => d !== n.key)]),
  )
  const state = new Map<string, "visiting" | "done">()
  for (const start of edges.keys()) {
    if (state.get(start)) continue
    const stack: { key: string; next: number }[] = [{ key: start, next: 0 }]
    const path: string[] = [start]
    state.set(start, "visiting")
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      const deps = edges.get(top.key) ?? []
      if (top.next < deps.length) {
        const dep = deps[top.next++]
        if (!edges.has(dep)) continue
        const s = state.get(dep)
        if (s === "visiting") return [...path.slice(path.indexOf(dep)), dep]
        if (!s) {
          state.set(dep, "visiting")
          stack.push({ key: dep, next: 0 })
          path.push(dep)
        }
      } else {
        state.set(top.key, "done")
        stack.pop()
        path.pop()
      }
    }
  }
  return null
}

/** A task's eligibility from its prerequisites' states. */
export function dependencyVerdict(
  prerequisites: readonly TaskStatus[],
): "eligible" | "waiting" | "blocked" {
  if (prerequisites.some((s) => UNSUCCESSFUL_TASK_STATUSES.includes(s)))
    return "blocked"
  return prerequisites.every((s) => s === "completed") ? "eligible" : "waiting"
}

// ---------------------------------------------------------------------------
// Retries and leases
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  /** Counted attempts allowed (1–10). */
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
}

export const MAX_ATTEMPTS_LIMIT = 10

/** Delay before retry after `attempt` counted attempts: base·2^(n−1), capped. */
export function backoffMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
) {
  const exponent = Math.max(0, Math.min(attempt - 1, 30))
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent)
}

export type FailureKind =
  "transient" | "permanent" | "needs_input" | "lease_expired"

/**
 * Where a failed or interrupted attempt leads.
 * - `transient` and `lease_expired` retry while attempts remain, then fail
 *   as exhausted. A lease expiry on a task whose side effects are unsafe
 *   to repeat (`recovery: "inspect"`) is never retried automatically.
 * - `permanent` fails at once; `needs_input` waits for the owner.
 */
export function afterFailure(
  kind: FailureKind,
  attempts: number,
  policy: { maxAttempts: number },
  recovery: "retry" | "inspect" = "retry",
): "retry_wait" | "failed" | "needs_input" {
  if (kind === "permanent") return "failed"
  if (kind === "needs_input") return "needs_input"
  if (kind === "lease_expired" && recovery === "inspect") return "needs_input"
  return attempts < policy.maxAttempts ? "retry_wait" : "failed"
}

/** A lease is valid only for its holder, its fencing token, and until it expires. */
export function leaseValid(
  lease: { owner: string | null; fence: number; expiresAt: Date | null },
  claim: { owner: string; fence: number },
  now: Date,
) {
  return (
    lease.owner === claim.owner &&
    lease.fence === claim.fence &&
    lease.expiresAt !== null &&
    lease.expiresAt.getTime() > now.getTime()
  )
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export interface Progress {
  total: number
  done: number
  /** 0–100, from tasks that reached a final state. */
  percent: number
  counts: Record<TaskStatus, number>
}

export function progressOf(statuses: readonly TaskStatus[]): Progress {
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<
    TaskStatus,
    number
  >
  for (const s of statuses) counts[s]++
  const unfinished = UNFINISHED_TASK_STATUSES.reduce(
    (sum, s) => sum + counts[s],
    0,
  )
  const done = statuses.length - unfinished
  return {
    total: statuses.length,
    done,
    percent:
      statuses.length === 0 ? 0 : Math.round((done / statuses.length) * 100),
    counts,
  }
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  waiting_dependencies: "Waiting for earlier steps",
  queued: "Queued",
  running: "Running",
  retry_wait: "Will retry",
  completed: "Completed",
  failed: "Failed",
  needs_input: "Needs your input",
  blocked: "Blocked by an earlier step",
  cancelled: "Cancelled",
}

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  pausing: "Pausing",
  paused: "Paused",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
}
