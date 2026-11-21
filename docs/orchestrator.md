# Campaign orchestrator (DV-004C)

The durable, local background engine that will run Affiliate Tickets
through Scout → Quill → Pixel → Vera.

**DV-004C builds and proves the infrastructure only.** It contains no
research, scripts, rendering, review, publishing or analytics.

- **Production runs are refused** ("automation isn't available yet") until
  real handlers exist (DV-005A, DV-005B, DV-005C, DV-006A).
- **Everything is verified with deterministic verification handlers.**
  Their results are labelled as test results everywhere, and they only run
  in isolated test environments.

## Contents

1. [Architecture](#1-architecture)
2. [Data model](#2-data-model)
3. [State machines](#3-state-machines)
4. [Claims, leases and fencing](#4-claims-leases-and-fencing)
5. [Dependencies and retries](#5-dependencies-and-retries)
6. [Pause, resume, cancel](#6-pause-resume-cancel)
7. [Recovery](#7-recovery)
8. [Resource limits and the Pixel boundary](#8-resource-limits-and-the-pixel-boundary)
9. [Frozen inputs and media retention](#9-frozen-inputs-and-media-retention)
10. [Verification handlers](#10-verification-handlers)
11. [API and UI](#11-api-and-ui)
12. [Backups](#12-backups)
13. [Commands](#13-commands)
14. [Tests and evidence](#14-tests-and-evidence)
15. [Limitations and next steps](#15-limitations-and-next-steps)

## 1. Architecture

| Part                             | Responsibility                                                                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Next.js app**                  | Plans runs (`POST …/runs`), records requested state changes (pause/resume/cancel/retry), and reads status. **It never executes tasks.** Nothing starts a worker at import, render or API time.             |
| **PostgreSQL**                   | Holds runs, frozen inputs, the task graph, attempts, leases, results and events. It coordinates claims between workers and survives restarts.                                                              |
| **Worker** (`yarn worker:start`) | A separate Node.js process. It loads `.env.local` (via `@next/env`), claims tasks it has handlers for, heartbeats, retries, records outcomes, and stops safely on SIGINT/SIGTERM. Run as many as you like. |

There is no Redis, BullMQ, Docker or cloud queue: PostgreSQL is the queue.
The code lives in:

- `src/lib/orchestrator/` (pure model and API types);
- `src/server/orchestrator/` (`store.ts` SQL, `worker.ts`, `workflows.ts`
  handlers and graphs, `config.ts`);
- `scripts/worker/`;
- `scripts/orchestrator/`.

### Worker lifecycle

The worker repeats this loop:

1. Recover expired leases.
2. Claim tasks while it has free slots.
3. Run each claimed task's handler, with a heartbeat every lease/3.
4. Commit the outcome with a compare-and-swap.
5. Sleep for the poll interval.

On **SIGTERM/SIGINT** it claims nothing more and waits up to
`DESKVERSE_WORKER_SHUTDOWN_GRACE_MS` (default 20 s) for running handlers.
Anything still running is then aborted and **handed back**: the task returns
to `queued` and the attempt is recorded as `released`, without counting
towards the retry limit. A second signal exits at once; those leases expire
and are recovered.

If PostgreSQL becomes unreachable, the worker keeps trying to renew. When it
can't renew before the lease would run out, it aborts the handler and
**commits nothing** (it fences itself). Commits are retried while the lease
is still held, then abandoned; the task is recovered by lease expiry.

## 2. Data model

Migration `drizzle/0002_campaign_orchestrator.sql`:

| Table                   | Holds                                                                                                                                                                                                | Key rules                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `campaign_runs`         | ticket, ticket_version, request_id (idempotency), mode (`production`/`verification`), workflow, status, pause/cancel request times, started/finished, summary counts, safe error                     | **one unfinished run per ticket** (partial unique index); finished_at set iff finished; status checked |
| `run_product_snapshots` | the frozen input of one product: ticket fields, product fields, references, asset IDs + SHA-256; `schema_version`, `checksum` (SHA-256 of canonical JSON)                                            | **immutable** (trigger refuses UPDATE/DELETE); FK (run, ticket); ≤ 256 KB                              |
| `worker_tasks`          | stage, status, resource class, priority, recovery policy, **idempotency_key** (unique), params, attempts/max_attempts, eligible_at, **lease_owner / lease_expires_at / fence**, failure kind/message | lease present iff running; attempts 1–10; FK (run, ticket) and (snapshot, run)                         |
| `task_dependencies`     | (task, prerequisite) within one run                                                                                                                                                                  | PK prevents duplicates; composite FKs refuse cross-run edges; **a trigger refuses cycles**; immutable  |
| `task_attempts`         | every attempt: number, worker, fence, outcome, message, timings                                                                                                                                      | unique (task, number) and (task, fence)                                                                |
| `task_results`          | **one committed result per task** (the primary key is the task); kind `verification`, versioned, ≤ 16 KB                                                                                             | immutable; only `verification` results exist in DV-004C                                                |
| `run_events`            | what happened, in the same transaction as the change                                                                                                                                                 | unique (run, request_id) makes control requests idempotent                                             |

The DV-004B owner tables are never written by workers. `app_metadata` and
the DV-004B tables are untouched by the migration, which only adds tables.

## 3. State machines

Defined in `src/lib/orchestrator/model.ts`; every transition is enforced
inside a locked transaction.

**Task:**

| From                     | To                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `waiting_dependencies`   | `queued` (every prerequisite completed), `blocked` (a prerequisite didn't succeed), `cancelled`                                         |
| `queued`                 | `running` (claimed), `cancelled`                                                                                                        |
| `running`                | `completed`, `retry_wait` (transient), `failed` (permanent / exhausted), `needs_input`, `cancelled`, `queued` (handed back on shutdown) |
| `retry_wait`             | `running` once `eligible_at` passes, `cancelled`                                                                                        |
| `failed`, `needs_input`  | `queued` (manual retry)                                                                                                                 |
| `blocked`                | `waiting_dependencies` (after an upstream manual retry), `cancelled`                                                                    |
| `completed`, `cancelled` | final                                                                                                                                   |

**Run:**

| From                              | To                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `queued`                          | `running` (first claim), `paused`, `cancelled`, or a finished state                              |
| `running`                         | `pausing` / `paused`, `cancelling` / `cancelled`, `completed`, `completed_with_errors`, `failed` |
| `pausing`                         | `paused` (running steps settled), `running` (resumed), `cancelling`/`cancelled`                  |
| `paused`                          | `running` / `queued` (resume), `cancelling` / `cancelled`                                        |
| `cancelling`                      | `cancelled` (running steps acknowledged or their leases expired)                                 |
| `completed_with_errors`, `failed` | `running` (a manual task retry reopens it)                                                       |
| `completed`, `cancelled`          | final                                                                                            |

How a run ends, once nothing is running:

- **completed:** every task completed;
- **completed_with_errors:** some tasks completed and some didn't;
- **failed:** none completed.

## 4. Claims, leases and fencing

A claim is one transaction:

1. `pg_advisory_xact_lock` serialises all claims, so per-class capacity
   counts are exact across processes.
2. Count running tasks per resource class, and keep the classes that have
   room.
3. Pick the oldest eligible task. It must satisfy all of:
   - status `queued`, or `retry_wait` with `eligible_at` passed;
   - the run is `queued`/`running`;
   - **every prerequisite completed** (re-checked here);
   - the stage has a handler in this worker;
   - the product has no other task running (fairness).

   Order is priority, then `eligible_at`, so products advance
   breadth-first and none can monopolise slots.

4. Lock the run row, then compare-and-swap the task to `running`, which:
   - increments `attempts`;
   - increments **`fence`** (the fencing token);
   - sets `lease_owner` and `lease_expires_at`;
   - inserts a `task_attempts` row.

**Compare-and-swap rules:**

- **Lock order is always run → task**, for claims, commits, recovery and
  controls, so they can't deadlock.
- **Heartbeats** extend the lease only where
  `(id, fence, lease_owner, status='running')` matches and the lease hasn't
  expired.
- **Every finalisation** (complete, fail, cancel acknowledgement, release)
  has the same condition and locks the run first.
- A worker whose lease expired, was re-claimed or was cancelled therefore
  **can't commit**. Its late result is refused and recorded as a
  `task_stale_result_refused` event.

Timings use `clock_timestamp()` (real time), not the transaction's start
time.

**Delivery guarantee:**

- **Execution is at-least-once.** A handler can run again after a crash.
- **Committed results are effectively-once.** `task_results` is keyed by
  task, results are immutable, and a completed task is final, so it never
  reruns.
- Handlers get a stable `idempotencyKey` (`<run>:<product>:<stage>`) for
  their side effects.
- Exactly-once execution of external side effects is **not** claimed. That
  is why tasks carry a recovery policy (§7).

## 5. Dependencies and retries

**Dependencies:**

- Each workflow is a validated DAG (`graphProblems` rejects cycles,
  duplicates and missing nodes). PostgreSQL also refuses cyclic or cross-run
  edges.
- A task is queued only when every prerequisite completed.
- When a task fails, needs input or is cancelled, its waiting descendants
  become `blocked` (they never run). Other products' branches continue.

**Retries:**

| Failure                                    | Result                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Transient (or an unexpected handler error) | `retry_wait` with backoff `base·2^(n−1)`, capped; after `max_attempts`, `failed` with "Gave up after N attempts. Last error: …" |
| Permanent                                  | `failed` at once                                                                                                                |
| Missing input                              | `needs_input`                                                                                                                   |

- **Defaults:** 3 attempts, 2 s base, 60 s maximum. All are configurable
  within bounds; at most 10 attempts.
- **Manual retry** (`…/tasks/:id/retry`) re-queues a failed or needs-input
  task with fresh attempts (up to the cap of 10), unblocks its descendants,
  and reopens a finished-with-errors run.

## 6. Pause, resume, cancel

- **Pause:** stops new claims at once. Running steps are allowed to finish
  and commit (`pausing`), then the run is `paused`. Completed results are
  kept. **Resume** returns it to `running` (or `queued` if nothing had
  started).
- **Cancel:**
  1. Every task that isn't running is cancelled immediately.
  2. Running tasks are signalled through their next heartbeat. The handler
     is aborted, and the worker acknowledges, which marks the task
     cancelled.
  3. If a worker is gone, lease expiry cancels its task.
  4. The run is `cancelling` until then, and `cancelled` after. A result
     arriving after cancellation is refused.
- **Idempotent controls:** each control request carries a `requestId`;
  repeating it changes nothing. Invalid transitions answer 409.

## 7. Recovery

On every poll, workers recover tasks whose lease expired (crashed, hung or
disconnected workers). An interrupted task is **never** marked successful:

| Situation                                                                          | Recovered to                                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Run is cancelling                                                                  | `cancelled`                                                   |
| Recovery policy `retry` (safe to repeat)                                           | `retry_wait` (backoff), or `failed` if attempts are exhausted |
| Recovery policy `inspect` (side effects may have happened, e.g. future publishing) | `needs_input`: the owner checks before retrying               |

- **Completed tasks are untouched by recovery.** On restart, queued and
  retry-wait tasks are simply claimed again.

## 8. Resource limits and the Pixel boundary

| Class     | Default (all workers together) | Setting                                       |
| --------- | ------------------------------ | --------------------------------------------- |
| `general` | 3                              | `DESKVERSE_ORCHESTRATOR_GENERAL_LIMIT` (1–16) |
| `cpu`     | 2                              | `DESKVERSE_ORCHESTRATOR_CPU_LIMIT` (1–8)      |
| `render`  | **1, always**                  | not configurable                              |

Per worker process: `DESKVERSE_WORKER_SLOTS` (default 3). Per product: one
running task at a time.

**Pixel Studio is unchanged.** Its in-process queue (1 active, 3 waiting,
files on disk) still works without PostgreSQL. The worker imports no render
code and starts no FFmpeg. The `render` class is tested only with the
synthetic `verify.exclusive` step: tests prove that two render-class _tasks_
never overlap. They do **not** prove machine-wide FFmpeg serialisation.

**Before any ticket-driven render handler exists (DV-005C),** a render gate
shared between Pixel Studio and the worker must be added and verified. A
PostgreSQL-only lock can't be the sole guard, because Pixel Studio must keep
working with PostgreSQL down. Until then the production `pixel.render` stage
has no handler and can't run.

## 9. Frozen inputs and media retention

**Freezing:** `planRun` runs in one transaction under the ticket's row lock
(the same lock DV-004B's edits take). It:

1. checks the ticket is Ready and at the requested `ticketVersion`, with no
   unfinished run;
2. copies every product (fields, references, asset IDs with size and
   SHA-256) into immutable snapshots;
3. creates the task graph.

A failure anywhere rolls all of it back (tested).

**Later edits:**

- Editing the ticket afterwards is allowed and changes no snapshot.
- As before, edits return a Ready ticket to Draft. The run keeps using its
  frozen copy, and the UI says so.

**Retention while a run is unfinished** (queued, running, pausing, paused,
cancelling):

- **removing a snapshotted product or attachment answers 409** ("part of a
  workflow run that hasn't finished");
- **archiving the ticket answers 409**;
- products added after the run started aren't part of it and stay
  removable.

**Finished runs** (completed, completed with errors, failed, cancelled)
release the media: files can then be removed. The snapshot keeps its
metadata and checksums, but not the bytes. A future handler that needs media
after its run ends must keep its own copy.

## 10. Verification handlers

**The `verification-v1` workflow:**

- Per product: four steps, collect → compute → exclusive → confirm, using
  the general, cpu, render and general classes.
- Each step waits a bounded time (cancellable), then returns a digest of
  its frozen input, labelled _"Deterministic orchestration verification
  only: not research, a script, a video or a review."_
- Faults can be injected per product and step: transient ×N, permanent,
  needs-input.

**Where they run:** they load only when
`DESKVERSE_ORCHESTRATOR_VERIFICATION=1` **and** the database is a guarded
test database (`deskverse_test`, `deskverse_test_*`, a test role). A worker
asked to load them on the development database refuses to start, and the
API refuses verification runs there.

## 11. API and UI

Local-only, strict JSON (unknown keys refused), no-store, ownership checked
on every nested route (run ∈ ticket, task ∈ run):

| Route                                              | Body                                                | Notes                                                   |
| -------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| `GET /api/tickets/:id/runs`                        |                                                     | `{ availability, runs }`                                |
| `POST /api/tickets/:id/runs`                       | `{ requestId, ticketVersion, mode, verification? }` | production → **503 capability-unavailable**; idempotent |
| `GET /api/tickets/:id/runs/:runId`                 |                                                     | run, products with tasks, events                        |
| `POST …/runs/:runId/pause` · `/resume` · `/cancel` | `{ requestId }`                                     | 409 when not valid in the current state                 |
| `POST …/runs/:runId/tasks/:taskId/retry`           | `{ requestId }`                                     | failed / needs-input tasks only                         |

The ticket workspace's **Workflow** section shows:

- availability, stating plainly that automation isn't available yet and
  which milestones add it;
- the latest run's persisted status, progress, steps per product, errors
  and task history, plus earlier runs;
- Pause, Resume, Cancel and Retry, only when valid;
- a **Start verification run (test only)** button, only in the test
  environment.

It refreshes every 2 s while a run is unfinished. There is no production
start button.

## 12. Backups

- **Included automatically.** All orchestrator data is in PostgreSQL, so it
  is part of the offline backup (format 2 unchanged), and no new files are
  written.
- **Leases after a restore.** `db:restore` marks every restored `running`
  lease as expired. No old worker identity can resume ownership, and new
  workers recover those tasks under the normal rules.
- **Tested:** backup → isolated restore, the old lease refused, recovery,
  the run completed, and the restored result not redone.

## 13. Commands

```bash
yarn worker:start          # run a worker (Ctrl-C stops it safely); run several for more capacity
yarn worker:check          # read-only: config, database, schema, handlers, run/task counts
yarn orchestrator:verify   # the 10-product multi-process crash verification on a scratch test database
```

| Setting (environment)                  | Range       | Default                   |
| -------------------------------------- | ----------- | ------------------------- |
| `DESKVERSE_WORKER_SLOTS`               | 1–16        | 3                         |
| `DESKVERSE_WORKER_LEASE_MS`            | 500–600 000 | 30 000                    |
| `DESKVERSE_WORKER_POLL_MS`             | 50–60 000   | 1 000                     |
| `DESKVERSE_WORKER_SHUTDOWN_GRACE_MS`   | 0–120 000   | 20 000                    |
| `DESKVERSE_ORCHESTRATOR_GENERAL_LIMIT` | 1–16        | 3                         |
| `DESKVERSE_ORCHESTRATOR_CPU_LIMIT`     | 1–8         | 2                         |
| `DESKVERSE_ORCHESTRATOR_MAX_ATTEMPTS`  | 1–10        | 3                         |
| `DESKVERSE_ORCHESTRATOR_RETRY_BASE_MS` | 10–60 000   | 2 000                     |
| `DESKVERSE_ORCHESTRATOR_RETRY_MAX_MS`  | 10–600 000  | 60 000                    |
| `DESKVERSE_ORCHESTRATOR_VERIFICATION`  | `1`         | off (test databases only) |

On the development database in DV-004C, `worker:start` has no handlers: it
recovers leases and waits.

## 14. Tests and evidence

| Suite                                               | What                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/orchestrator.test.ts`                        | DAG validation, cycles, state transitions, dependency verdicts, retry/backoff, leases/fencing, progress, handlers, config bounds, verification gate                                                                                                                                                                                                                                        |
| `tests/db/orchestrator.db.test.ts`                  | atomic planning (and rollback), idempotency, one active run under concurrency, stale versions, immutable snapshots, retention 409s, competing claims, capacity, fencing (stale worker refused), cycles and cross-run edges, 10 products with in-process workers, blocking, exhaustion, manual retry, pause/resume/cancel, graceful hand-back, cross-ticket rejection, reconnection, outage |
| `tests/db/orchestrator-crash.db.test.ts`            | the multi-process crash scenario (below)                                                                                                                                                                                                                                                                                                                                                   |
| `tests/db/backup-orchestrator.db.test.ts`           | backup/restore with runs, snapshots, tasks and results; old leases recovered, not resumed                                                                                                                                                                                                                                                                                                  |
| `e2e/tickets-workflow.spec.ts` (`yarn test:e2e:db`) | the Workflow section with a real worker process: availability, verification run, controls, failure and retry, retention, outage, 360 px                                                                                                                                                                                                                                                    |

**The crash scenario** (`yarn orchestrator:verify` and the crash test) is a
deterministic orchestration verification, not AI content:

- **Setup:** a scratch database; 10 products × 4 steps; three worker
  processes.
- **Faults:** permanent (product 3), transient ×2 (product 5), needs-input
  (product 7).
- **Interruptions:** mid-task, worker A gets **SIGTERM** (graceful, 200 ms
  grace) and worker B gets **SIGKILL**; both are restarted.

It checks:

- the run ends `completed_with_errors`;
- the 8 independent products complete;
- the failing products block only their own later steps;
- product 5 succeeds on attempt 3;
- one result per completed task (35 of 35), none duplicated, and no
  completed task runs again;
- dependents start only after prerequisites succeed;
- the SIGTERM task is `released`, then succeeds elsewhere;
- the SIGKILL task shows `lease_expired`, then succeeds elsewhere;
- render steps never overlap, general ≤ 3 and cpu ≤ 2 across processes.

## 15. Limitations and next steps

- **No production handlers.** Real runs are refused until DV-005A/B/C and
  DV-006A.
- **The real render gate isn't built.** The shared Pixel Studio + worker
  render gate is needed before DV-005C, as described in §8.
- **The Workflow section polls** (every 2 s) rather than receiving pushed
  updates.
- **Worker identities are per process** (`worker-<pid>-<random>`). There is
  no worker registry or dashboard beyond `yarn worker:check`.
- **Claims are serialised by one advisory lock.** That's ample locally, but
  not designed for hundreds of workers.
