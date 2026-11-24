import { CAMPAIGN_WORKER_CAPABILITY } from "@/server/orchestrator/workflows"
import { randomBytes } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"

import type pg from "pg"

import {
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
} from "@/lib/orchestrator/model"
import {
  acknowledgeCancel,
  checkInWorker,
  checkOutWorker,
  claimTask,
  completeTask,
  DEFAULT_LIMITS,
  failTask,
  recoverExpiredLeases,
  releaseTask,
  renewLease,
  type Claim,
  type ResourceLimits,
} from "@/server/orchestrator/store"
import {
  HandlerAborted,
  type HandlerRegistry,
} from "@/server/orchestrator/workflows"

/**
 * The dedicated local worker (DV-004C). Runs outside Next.js
 * (`yarn worker:start`); the web app never executes tasks.
 *
 * Loop: recover expired leases → claim while this process has free slots →
 * run each claim's handler with a heartbeat that renews the lease every
 * leaseMs/3. The handler is aborted when:
 *   - the run is being cancelled (seen on a heartbeat) → acknowledged as cancelled;
 *   - the lease can't be renewed before it runs out (e.g. PostgreSQL is
 *     down) → the worker fences itself and commits nothing; the task is
 *     recovered by lease expiry;
 *   - shutdown's grace period ends → the task is handed back (not counted).
 */

export interface WorkerOptions {
  campaignCapable?: boolean
  pool: pg.Pool
  registry: HandlerRegistry
  /** Concurrent tasks in this process. */
  slots?: number
  limits?: ResourceLimits
  leaseMs?: number
  pollMs?: number
  /** How long shutdown waits for running handlers before handing tasks back. */
  shutdownGraceMs?: number
  retry?: RetryPolicy
  log?: (line: string) => void
}

export function newWorkerId() {
  return `worker-${process.pid}-${randomBytes(4).toString("hex")}`
}

interface Active {
  claim: Claim
  controller: AbortController
  reason: "cancel" | "lost" | "shutdown" | null
  done: Promise<void>
}

export class Worker {
  readonly id = newWorkerId()
  private readonly campaignCapable: boolean
  private readonly pool: pg.Pool
  private readonly registry: HandlerRegistry
  private readonly slots: number
  private readonly limits: ResourceLimits
  private readonly leaseMs: number
  private readonly pollMs: number
  private readonly graceMs: number
  private readonly retry: RetryPolicy
  private readonly log: (line: string) => void
  private readonly active = new Map<string, Active>()
  private stopping = false
  private lastCheckIn = 0
  private loop: Promise<void> | null = null
  private wake: (() => void) | null = null

  constructor(options: WorkerOptions) {
    this.campaignCapable = options.campaignCapable === true
    this.pool = options.pool
    this.registry = options.registry
    this.slots = Math.max(1, Math.min(options.slots ?? 3, 16))
    this.limits = options.limits ?? DEFAULT_LIMITS
    this.leaseMs = Math.max(500, options.leaseMs ?? 30_000)
    this.pollMs = Math.max(50, options.pollMs ?? 1_000)
    this.graceMs = options.shutdownGraceMs ?? 20_000
    this.retry = options.retry ?? DEFAULT_RETRY_POLICY
    this.log = options.log ?? ((line) => console.log(line))
  }

  start() {
    this.loop ??= this.run()
    return this
  }

  get busy() {
    return this.active.size
  }

  private async run() {
    const stages = [...this.registry.keys()]
    while (!this.stopping) {
      // Check in at most every 5 s so the UI can tell whether a worker runs.
      if (Date.now() - this.lastCheckIn >= 5_000)
        await checkInWorker(this.pool, {
          workerId: this.id,
          pid: process.pid,
          stages: this.campaignCapable
            ? [...stages, CAMPAIGN_WORKER_CAPABILITY]
            : stages,
        }).then(
          () => (this.lastCheckIn = Date.now()),
          () => {},
        )
      try {
        await recoverExpiredLeases(this.pool, this.retry)
        while (!this.stopping && this.active.size < this.slots) {
          const claim = await claimTask(this.pool, {
            workerId: this.id,
            stages,
            campaignCapable: this.campaignCapable,
            leaseMs: this.leaseMs,
            limits: this.limits,
          })
          if (!claim) break
          this.execute(claim)
        }
      } catch {
        this.log(`[worker ${this.id}] database unavailable; retrying`)
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
        // Not unref()'d: the poll timer keeps an idle worker process alive.
        setTimeout(resolve, this.pollMs)
      })
      this.wake = null
    }
  }

  private execute(claim: Claim) {
    const controller = new AbortController()
    const entry: Active = {
      claim,
      controller,
      reason: null,
      done: Promise.resolve(),
    }
    this.active.set(claim.taskId, entry)
    entry.done = this.runClaim(entry).finally(() => {
      this.active.delete(claim.taskId)
      this.wake?.() // a slot is free
    })
  }

  private async runClaim(entry: Active) {
    const { claim, controller } = entry
    const handler = this.registry.get(claim.stage)
    let leaseDeadline = Date.now() + this.leaseMs
    const abort = (reason: Active["reason"]) => {
      if (entry.reason) return
      entry.reason = reason
      controller.abort()
    }
    const heartbeat = setInterval(
      () => {
        void renewLease(this.pool, claim).then(
          (lease) => {
            if (!lease) return abort("lost")
            leaseDeadline = Date.now() + this.leaseMs
            if (
              lease.runStatus === "cancelling" ||
              lease.runStatus === "cancelled"
            )
              abort("cancel")
          },
          () => {
            // Can't reach PostgreSQL: stop before the lease could pass to someone else.
            if (Date.now() > leaseDeadline - this.leaseMs / 3) abort("lost")
          },
        )
      },
      Math.max(100, Math.floor(this.leaseMs / 3)),
    )
    heartbeat.unref()

    try {
      if (!handler) throw new Error("no handler")
      const outcome = await handler.run({
        taskId: claim.taskId,
        runId: claim.runId,
        ticketId: claim.ticketId,
        fence: claim.fence,
        stage: claim.stage,
        attempt: claim.attempt,
        maxAttempts: claim.maxAttempts,
        idempotencyKey: claim.idempotencyKey,
        snapshot: claim.snapshot,
        params: claim.params,
        signal: controller.signal,
      })
      if (entry.reason) throw new HandlerAborted(entry.reason)
      const commit = () =>
        outcome.status === "completed"
          ? completeTask(this.pool, claim, outcome.result, outcome.deliverable)
          : failTask(
              this.pool,
              claim,
              {
                kind: outcome.status,
                message: outcome.message,
                retryAfterMs:
                  outcome.status === "transient" ? outcome.retryAfterMs : null,
                details: outcome.details,
              },
              this.retry,
            )
      let result = await this.persist(commit, () => leaseDeadline)
      if (result === "rejected")
        // Deterministic refusal (e.g. a deliverable failed a database check):
        // retrying the same commit can't help, so record a permanent failure.
        result = await this.persist(
          () =>
            failTask(
              this.pool,
              claim,
              {
                kind: "permanent",
                message:
                  "The result was refused by a database check and wasn't saved.",
              },
              this.retry,
            ),
          () => leaseDeadline,
        )
      this.log(
        `[worker ${this.id}] ${claim.stage} ${claim.taskId.slice(0, 8)} attempt ${claim.attempt}: ${outcome.status} (${result})`,
      )
    } catch (error) {
      const reason =
        entry.reason ?? (error instanceof HandlerAborted ? "lost" : null)
      if (reason === "cancel")
        await this.persist(
          () => acknowledgeCancel(this.pool, claim),
          () => leaseDeadline,
        )
      else if (reason === "shutdown")
        await this.persist(
          () => releaseTask(this.pool, claim),
          () => leaseDeadline,
        )
      else if (reason === "lost")
        this.log(
          `[worker ${this.id}] lost the lease on ${claim.taskId.slice(0, 8)}; nothing committed`,
        )
      else {
        // An unexpected handler error is a transient failure (bounded retries).
        await this.persist(
          () =>
            failTask(
              this.pool,
              claim,
              { kind: "transient", message: "The step failed unexpectedly." },
              this.retry,
            ),
          () => leaseDeadline,
        )
      }
    } finally {
      clearInterval(heartbeat)
    }
  }

  /**
   * Retries a commit while this worker still holds the lease; then gives up
   * (fenced). Only connection-type errors are retried: a commit the
   * database refuses (constraint, data or SQL error) returns "rejected".
   */
  private async persist(
    commit: () => Promise<unknown>,
    deadline: () => number,
  ) {
    for (;;) {
      try {
        return await commit()
      } catch (error) {
        if (!retryableDatabaseError(error)) {
          this.log(
            `[worker ${this.id}] the database refused a commit (${String((error as { code?: unknown }).code ?? "error")}); not retrying it`,
          )
          return "rejected"
        }
        if (Date.now() >= deadline()) {
          this.log(
            `[worker ${this.id}] couldn't record the outcome before the lease ran out; the task will be recovered`,
          )
          return "unrecorded"
        }
        await sleep(Math.min(500, this.leaseMs / 4))
      }
    }
  }

  /**
   * Graceful stop: claim nothing more, let running handlers finish within
   * the grace period, then abort the rest and hand their tasks back.
   */
  async stop() {
    this.stopping = true
    this.wake?.()
    await this.loop
    const all = () => Promise.all([...this.active.values()].map((a) => a.done))
    const finished = await Promise.race([
      all().then(() => true),
      sleep(this.graceMs).then(() => false),
    ])
    if (!finished) {
      for (const entry of this.active.values()) {
        if (!entry.reason) {
          entry.reason = "shutdown"
          entry.controller.abort()
        }
      }
      await all()
    }
    await checkOutWorker(this.pool, this.id).catch(() => {})
  }
}

/** Connection loss, shutdown, overload, deadlock: worth retrying. Anything else isn't. */
export function retryableDatabaseError(error: unknown) {
  const e = error as { code?: unknown; message?: unknown } | null
  const code = typeof e?.code === "string" ? e.code : null
  if (code === null)
    return /connect|terminat|timeout|closed|ECONN|socket/i.test(
      String(e?.message ?? ""),
    )
  return /^(08|53|57|40)/.test(code) || /^E[A-Z]+$/.test(code)
}
