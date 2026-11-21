import { describe, expect, it } from "vitest"

import {
  afterFailure,
  backoffMs,
  canRunTransition,
  canTaskTransition,
  dependencyVerdict,
  findCycle,
  graphProblems,
  leaseValid,
  progressOf,
  RUN_STATUSES,
  RUN_TRANSITIONS,
  runControls,
  settledRunStatus,
  TASK_STATUSES,
  TASK_TRANSITIONS,
} from "@/lib/orchestrator/model"
import {
  readOrchestratorConfig,
  verificationAllowed,
} from "@/server/orchestrator/config"
import { canonicalJson } from "@/server/orchestrator/store"
import {
  createRegistry,
  PRODUCTION_WORKFLOW,
  productionAvailable,
  VERIFICATION_WORKFLOW,
  verificationHandler,
} from "@/server/orchestrator/workflows"

/** DV-004C unit tests: no database. */

describe("task graphs", () => {
  it("accepts the workflows and a wide DAG", () => {
    for (const wf of [VERIFICATION_WORKFLOW, PRODUCTION_WORKFLOW])
      expect(
        graphProblems(
          wf.stages.map((s) => ({ key: s.stage, dependsOn: s.dependsOn })),
        ),
      ).toEqual([])
    const nodes = Array.from({ length: 2000 }, (_, i) => ({
      key: `n${i}`,
      dependsOn: i ? [`n${i - 1}`] : [],
    }))
    expect(findCycle(nodes)).toBeNull()
  })

  it("finds cycles, self-edges, duplicates and missing nodes", () => {
    expect(
      findCycle([
        { key: "a", dependsOn: ["b"] },
        { key: "b", dependsOn: ["c"] },
        { key: "c", dependsOn: ["a"] },
      ]),
    ).toEqual(["a", "b", "c", "a"])
    expect(
      graphProblems([
        { key: "a", dependsOn: ["a", "x", "b", "b"] },
        { key: "b", dependsOn: [] },
        { key: "b", dependsOn: [] },
      ]).map((p) => p.kind),
    ).toEqual([
      "duplicate-node",
      "self-dependency",
      "missing-dependency",
      "duplicate-edge",
    ])
  })

  it("makes a task eligible only when every prerequisite completed", () => {
    expect(dependencyVerdict([])).toBe("eligible")
    expect(dependencyVerdict(["completed", "completed"])).toBe("eligible")
    expect(dependencyVerdict(["completed", "running"])).toBe("waiting")
    expect(dependencyVerdict(["completed", "retry_wait"])).toBe("waiting")
    for (const bad of [
      "failed",
      "needs_input",
      "blocked",
      "cancelled",
    ] as const)
      expect(dependencyVerdict(["completed", bad])).toBe("blocked")
  })
})

describe("state machines", () => {
  it("defines transitions for every state, into known states only", () => {
    for (const s of TASK_STATUSES)
      for (const t of TASK_TRANSITIONS[s]) expect(TASK_STATUSES).toContain(t)
    for (const s of RUN_STATUSES)
      for (const t of RUN_TRANSITIONS[s]) expect(RUN_STATUSES).toContain(t)
  })

  it("never lets a finished task change, nor a cancelled one complete", () => {
    expect(TASK_TRANSITIONS.completed).toEqual([])
    expect(TASK_TRANSITIONS.cancelled).toEqual([])
    expect(canTaskTransition("cancelled", "completed")).toBe(false)
    expect(canTaskTransition("waiting_dependencies", "running")).toBe(false)
    expect(canTaskTransition("blocked", "running")).toBe(false)
    expect(canTaskTransition("failed", "queued")).toBe(true) // manual retry
  })

  it("only allows run transitions that make sense", () => {
    expect(canRunTransition("cancelled", "running")).toBe(false)
    expect(canRunTransition("completed", "running")).toBe(false)
    expect(canRunTransition("cancelling", "running")).toBe(false)
    expect(canRunTransition("completed_with_errors", "running")).toBe(true) // manual retry
    expect(canRunTransition("paused", "running")).toBe(true)
    expect(runControls("running")).toEqual({
      pause: true,
      resume: false,
      cancel: true,
    })
    expect(runControls("paused")).toEqual({
      pause: false,
      resume: true,
      cancel: true,
    })
    expect(runControls("cancelling")).toEqual({
      pause: false,
      resume: false,
      cancel: false,
    })
    expect(runControls("completed")).toEqual({
      pause: false,
      resume: false,
      cancel: false,
    })
  })

  it("settles a run only when nothing is running or left to do", () => {
    expect(settledRunStatus("running", { running: 1, completed: 3 })).toBeNull()
    expect(settledRunStatus("running", { queued: 1 })).toBeNull()
    expect(settledRunStatus("running", { completed: 4 })).toBe("completed")
    expect(settledRunStatus("running", { completed: 3, failed: 1 })).toBe(
      "completed_with_errors",
    )
    expect(settledRunStatus("running", { failed: 1, blocked: 3 })).toBe(
      "failed",
    )
    expect(settledRunStatus("pausing", { running: 0, queued: 5 })).toBe(
      "paused",
    )
    expect(settledRunStatus("pausing", { running: 1 })).toBeNull()
    expect(settledRunStatus("cancelling", { cancelled: 3 })).toBe("cancelled")
    expect(settledRunStatus("paused", { queued: 2 })).toBeNull()
  })
})

describe("retries and leases", () => {
  it("backs off exponentially up to the maximum", () => {
    const policy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 }
    expect([1, 2, 3, 4, 50].map((n) => backoffMs(n, policy))).toEqual([
      1000, 2000, 4000, 5000, 5000,
    ])
  })

  it("retries transient failures finitely and never retries permanent ones", () => {
    const p = { maxAttempts: 3 }
    expect(afterFailure("transient", 1, p)).toBe("retry_wait")
    expect(afterFailure("transient", 2, p)).toBe("retry_wait")
    expect(afterFailure("transient", 3, p)).toBe("failed")
    expect(afterFailure("permanent", 1, p)).toBe("failed")
    expect(afterFailure("needs_input", 1, p)).toBe("needs_input")
    expect(afterFailure("lease_expired", 1, p, "retry")).toBe("retry_wait")
    // A crashed attempt of a step with unsafe side effects is never retried blindly.
    expect(afterFailure("lease_expired", 1, p, "inspect")).toBe("needs_input")
  })

  it("accepts a lease only for its holder, fencing token and lifetime", () => {
    const now = new Date("2026-11-22T10:00:00Z")
    const lease = {
      owner: "w1",
      fence: 4,
      expiresAt: new Date("2026-11-22T10:00:30Z"),
    }
    expect(leaseValid(lease, { owner: "w1", fence: 4 }, now)).toBe(true)
    expect(leaseValid(lease, { owner: "w2", fence: 4 }, now)).toBe(false)
    expect(leaseValid(lease, { owner: "w1", fence: 3 }, now)).toBe(false)
    expect(
      leaseValid(
        lease,
        { owner: "w1", fence: 4 },
        new Date("2026-11-22T10:01:00Z"),
      ),
    ).toBe(false)
  })

  it("computes progress from final states", () => {
    const p = progressOf([
      "completed",
      "completed",
      "running",
      "failed",
      "blocked",
      "queued",
      "waiting_dependencies",
      "retry_wait",
    ])
    expect(p).toMatchObject({ total: 8, done: 4, percent: 50 })
    expect(p.counts.running).toBe(1)
    expect(progressOf([]).percent).toBe(0)
  })
})

describe("handlers and configuration", () => {
  it("has no production handlers in DV-004C, and verification only when enabled", () => {
    expect(productionAvailable(createRegistry({ verification: true }))).toBe(
      false,
    )
    expect(createRegistry({ verification: false }).size).toBe(0)
    expect(
      [...createRegistry({ verification: true }).values()].every(
        (h) => h.kind === "verification",
      ),
    ).toBe(true)
  })

  it("verification handlers are deterministic, labelled, and honour faults and aborts", async () => {
    const handler = verificationHandler("verify.collect")
    const ctx = {
      taskId: "t",
      runId: "r",
      stage: "verify.collect",
      attempt: 1,
      idempotencyKey: "k",
      snapshot: { checksum: "c".repeat(64), data: {} },
      params: { durationMs: 0 },
      signal: new AbortController().signal,
    }
    const a = await handler.run(ctx)
    const b = await handler.run(ctx)
    expect(a).toEqual(b)
    expect(a.status === "completed" && a.result.note).toMatch(
      /not research, a script, a video or a review/,
    )
    expect(
      (
        await handler.run({
          ...ctx,
          params: { durationMs: 0, fail: { kind: "transient", times: 2 } },
          attempt: 2,
        })
      ).status,
    ).toBe("transient")
    expect(
      (
        await handler.run({
          ...ctx,
          params: { durationMs: 0, fail: { kind: "transient", times: 2 } },
          attempt: 3,
        })
      ).status,
    ).toBe("completed")
    expect(
      (
        await handler.run({
          ...ctx,
          params: { durationMs: 0, fail: { kind: "permanent" } },
        })
      ).status,
    ).toBe("permanent")
    const controller = new AbortController()
    const pending = handler.run({
      ...ctx,
      params: { durationMs: 10_000 },
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toThrow("aborted")
  })

  it("bounds every setting and keeps one render task at a time", () => {
    const c = readOrchestratorConfig({
      DESKVERSE_ORCHESTRATOR_GENERAL_LIMIT: "999",
      DESKVERSE_ORCHESTRATOR_CPU_LIMIT: "4",
      DESKVERSE_ORCHESTRATOR_MAX_ATTEMPTS: "50",
      DESKVERSE_WORKER_LEASE_MS: "abc",
    })
    expect(c.limits).toEqual({ general: 3, cpu: 4, render: 1, perProduct: 1 })
    expect(c.retry.maxAttempts).toBe(3)
    expect(c.leaseMs).toBe(30_000)
  })

  it("allows verification only when enabled AND on a test database", () => {
    const db = (database: string, user: string) => ({
      variable: "DATABASE_URL" as const,
      host: "127.0.0.1",
      port: 5432,
      password: "p",
      database,
      user,
    })
    const on = { DESKVERSE_ORCHESTRATOR_VERIFICATION: "1" }
    expect(
      verificationAllowed(on, db("deskverse_test_e2e_1_ab", "deskverse_test")),
    ).toBe(true)
    expect(verificationAllowed(on, db("deskverse", "deskverse_app"))).toBe(
      false,
    )
    expect(verificationAllowed(on, db("deskverse_test", "deskverse_app"))).toBe(
      false,
    )
    expect(
      verificationAllowed({}, db("deskverse_test", "deskverse_test")),
    ).toBe(false)
    expect(verificationAllowed(on, null)).toBe(false)
  })

  it("checksums inputs canonically (key order doesn't matter)", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }),
    )
  })
})
