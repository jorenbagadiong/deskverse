"use client"

import { useEffect, useRef, useState } from "react"
import {
  CirclePause,
  CirclePlay,
  FlaskConical,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Square,
} from "lucide-react"

import { FormMessage, formatDate } from "@/components/tickets/fields"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  isActiveRun,
  progressOf,
  RUN_STATUS_LABEL,
  runControls,
  TASK_STATUS_LABEL,
  type RunStatus,
  type TaskStatus,
} from "@/lib/orchestrator/model"
import {
  runEndpoint,
  runsEndpoint,
  RUNS_CHANGED_EVENT,
  runTitle,
  type RunDetail,
  type RunSummary,
  type WorkflowAvailability,
} from "@/lib/orchestrator/types"
import { api, newRequestId } from "@/lib/tickets/client"
import type { ApiError, TicketDetail } from "@/lib/tickets/types"
import { cn } from "@/lib/utils"

/**
 * The ticket's Workflow section (DV-004C). Shows only persisted state from
 * PostgreSQL; the browser never runs or simulates work. The full campaign
 * isn't available yet; research-only runs (DV-005A) are started from the
 * Scout Research section and shown here with their controls. Verification
 * runs (deterministic test steps, test environment only) are labelled as
 * such everywhere.
 */

const TASK_TONE: Record<TaskStatus, string> = {
  waiting_dependencies: "text-muted-foreground ring-border",
  queued: "text-status-idle ring-status-idle/30",
  running: "text-status-working ring-status-working/40",
  retry_wait: "text-status-waiting ring-status-waiting/40",
  completed: "text-status-completed ring-status-completed/35",
  failed: "text-status-failed ring-status-failed/40",
  needs_input: "text-status-waiting ring-status-waiting/40",
  blocked: "text-muted-foreground ring-border",
  cancelled: "text-muted-foreground ring-border",
}

const RUN_TONE = (status: RunStatus) =>
  status === "completed"
    ? "text-status-completed bg-status-completed/12 ring-status-completed/35"
    : status === "failed" || status === "completed_with_errors"
      ? "text-status-failed bg-status-failed/10 ring-status-failed/40"
      : status === "running"
        ? "text-status-working bg-status-working/12 ring-status-working/40"
        : "text-status-idle bg-status-idle/12 ring-status-idle/30"

interface State {
  availability: WorkflowAvailability
  runs: RunSummary[]
  latest: RunDetail | null
}

export function WorkflowSection({ ticket }: { ticket: TicketDetail }) {
  const [state, setState] = useState<State | null>(null)
  const [loadError, setLoadError] = useState<ApiError | null>(null)
  const [actionError, setActionError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const startRequest = useRef<string | null>(null)

  // Load, and poll every 2 s while the latest run is unfinished.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    void (async () => {
      const list = await api<{
        availability: WorkflowAvailability
        runs: RunSummary[]
      }>(runsEndpoint(ticket.id))
      if (cancelled) return
      if (!list.ok) {
        setLoadError(list.error)
        timer = setTimeout(() => setTick((n) => n + 1), 5_000)
        return
      }
      const first = list.data.runs[0]
      let latest: RunDetail | null = null
      if (first) {
        const detail = await api<RunDetail>(runEndpoint(ticket.id, first.id))
        if (cancelled) return
        if (detail.ok) latest = detail.data
      }
      setLoadError(null)
      setState({ ...list.data, latest })
      if (first && isActiveRun(first.status))
        timer = setTimeout(() => setTick((n) => n + 1), 2_000)
    })()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [ticket.id, tick])

  const refresh = () => setTick((n) => n + 1)

  useEffect(() => {
    const onChange = () => setTick((n) => n + 1)
    window.addEventListener(RUNS_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(RUNS_CHANGED_EVENT, onChange)
  }, [])

  async function act(key: string, url: string, body: unknown) {
    setBusy(key)
    setActionError(null)
    const result = await api(url, { method: "POST", body })
    setBusy(null)
    if (!result.ok) setActionError(result.error)
    refresh()
    window.dispatchEvent(new Event(RUNS_CHANGED_EVENT))
    return result.ok
  }

  async function startVerification() {
    startRequest.current ??= newRequestId()
    const ok = await act("start", runsEndpoint(ticket.id), {
      requestId: startRequest.current,
      ticketVersion: ticket.version,
      mode: "verification",
    })
    if (ok) startRequest.current = null
  }

  const latest = state?.latest ?? null
  const run = latest?.run ?? null
  const allowed = run ? runControls(run.status) : null
  // Only when at least one control is valid (no empty group for finished runs).
  const controls =
    allowed && (allowed.pause || allowed.resume || allowed.cancel)
      ? allowed
      : null
  const active = run ? isActiveRun(run.status) : false
  const progress = latest
    ? progressOf(latest.products.flatMap((p) => p.tasks.map((t) => t.status)))
    : null

  return (
    <section
      aria-labelledby="workflow-title"
      className="flex max-w-4xl flex-col gap-4"
    >
      <h2 id="workflow-title" className="text-title">
        Workflow
      </h2>

      {!state && !loadError ? (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <LoaderCircle
            aria-hidden="true"
            className="size-4 animate-spin motion-reduce:animate-none"
          />
          Loading workflow status…
        </p>
      ) : null}
      {loadError ? (
        <FormMessage>
          <p className="font-semibold">
            Couldn&apos;t load the workflow status.
          </p>
          <p className="mt-1">{loadError.message}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={refresh}
          >
            <RefreshCw aria-hidden="true" />
            Try again
          </Button>
        </FormMessage>
      ) : null}

      {state ? (
        <>
          {!state.availability.production ? (
            <div
              data-testid="automation-unavailable"
              className="rounded-xl bg-surface-sunken p-4 text-sm ring-1 ring-border"
            >
              <p className="font-semibold">
                Full campaign automation isn&apos;t available yet.
              </p>
              <p className="mt-1 text-muted-foreground">
                A full campaign needs the rest of the AI team, which isn&apos;t
                built yet:{" "}
                {state.availability.missing
                  .map(
                    (m) =>
                      `${m.stage.split(".")[0][0].toUpperCase()}${m.stage.split(".")[0].slice(1)} (${m.milestone.split(" ")[0]})`,
                  )
                  .join(", ")}
                .{" "}
                {state.availability.research
                  ? "Scout research runs on its own: use Scout Research below."
                  : "Scout research is switched off (see Scout Research below)."}
              </p>
            </div>
          ) : null}

          {state.availability.verification ? (
            <div
              className="flex flex-col gap-2 rounded-xl p-4 ring-1 ring-status-info/35 ring-inset"
              data-testid="verification-panel"
            >
              <p className="flex items-center gap-2 text-sm font-semibold">
                <FlaskConical
                  aria-hidden="true"
                  className="size-4 text-status-info"
                />
                Test environment: orchestration verification
              </p>
              <p className="text-sm text-muted-foreground">
                Runs deterministic test steps through the real worker and
                database to check the orchestrator. They don&apos;t research,
                write, render or review anything, and their results are test
                results only.
              </p>
              <Button
                type="button"
                className="w-fit"
                onClick={() => void startVerification()}
                disabled={busy !== null || ticket.status !== "ready" || active}
              >
                {busy === "start" ? (
                  <LoaderCircle
                    aria-hidden="true"
                    className="animate-spin motion-reduce:animate-none"
                  />
                ) : (
                  <FlaskConical aria-hidden="true" />
                )}
                Start verification run (test only)
              </Button>
              {ticket.status !== "ready" ? (
                <p className="text-xs text-muted-foreground">
                  Mark the ticket Ready to start a run.
                </p>
              ) : null}
            </div>
          ) : null}

          {actionError ? (
            <FormMessage>
              <p className="font-semibold">That didn&apos;t work.</p>
              <p className="mt-1">{actionError.message}</p>
            </FormMessage>
          ) : null}

          {run && latest && progress ? (
            <article
              aria-labelledby="latest-run-title"
              className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-border"
              data-run-status={run.status}
            >
              <header className="flex flex-wrap items-center gap-2">
                <h3 id="latest-run-title" className="font-semibold">
                  {runTitle(run)}
                </h3>
                <span
                  data-testid="run-status"
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset",
                    RUN_TONE(run.status),
                  )}
                >
                  {RUN_STATUS_LABEL[run.status]}
                </span>
                <span className="text-sm text-muted-foreground">
                  Started {formatDate(run.createdAt)} · from ticket version{" "}
                  {run.ticketVersion}
                  {run.ticketVersion !== ticket.version
                    ? " (the ticket has changed since; this run uses the frozen copy)"
                    : ""}
                </span>
              </header>
              <div className="flex flex-col gap-1">
                <progress
                  max={100}
                  value={progress.percent}
                  aria-label="Run progress"
                  className="h-2 w-full accent-primary"
                />
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="run-counts"
                >
                  {progress.done} of {progress.total} steps finished ·{" "}
                  {progress.counts.completed} completed
                  {progress.counts.running
                    ? ` · ${progress.counts.running} running`
                    : ""}
                  {progress.counts.failed
                    ? ` · ${progress.counts.failed} failed`
                    : ""}
                  {progress.counts.needs_input
                    ? ` · ${progress.counts.needs_input} need input`
                    : ""}
                  {progress.counts.blocked
                    ? ` · ${progress.counts.blocked} blocked`
                    : ""}
                  {progress.counts.cancelled
                    ? ` · ${progress.counts.cancelled} cancelled`
                    : ""}
                </p>
                {run.error ? (
                  <p className="text-sm text-status-failed">{run.error}</p>
                ) : null}
                {run.status === "pausing" ? (
                  <p className="text-sm text-muted-foreground">
                    Pausing: steps already running finish first; nothing new
                    starts.
                  </p>
                ) : null}
                {run.status === "cancelling" ? (
                  <p className="text-sm text-muted-foreground">
                    Cancelling: waiting for running steps to stop.
                  </p>
                ) : null}
              </div>
              {controls ? (
                <div
                  role="group"
                  aria-label="Run controls"
                  className="flex flex-wrap gap-2"
                >
                  {controls.pause ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(
                          "pause",
                          `${runEndpoint(ticket.id, run.id)}/pause`,
                          { requestId: newRequestId() },
                        )
                      }
                    >
                      <CirclePause aria-hidden="true" />
                      Pause
                    </Button>
                  ) : null}
                  {controls.resume ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(
                          "resume",
                          `${runEndpoint(ticket.id, run.id)}/resume`,
                          { requestId: newRequestId() },
                        )
                      }
                    >
                      <CirclePlay aria-hidden="true" />
                      Resume
                    </Button>
                  ) : null}
                  {controls.cancel ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy !== null}
                        >
                          <Square aria-hidden="true" />
                          Cancel run
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Cancel this run?</AlertDialogTitle>
                          <AlertDialogDescription>
                            Steps that haven&apos;t started are cancelled now;
                            running steps stop at their next check. Completed
                            results are kept. A cancelled run can&apos;t be
                            resumed.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Keep running</AlertDialogCancel>
                          <AlertDialogAction
                            variant="destructive"
                            onClick={() =>
                              void act(
                                "cancel",
                                `${runEndpoint(ticket.id, run.id)}/cancel`,
                                { requestId: newRequestId() },
                              )
                            }
                          >
                            Cancel run
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : null}
                </div>
              ) : null}

              <ol
                aria-label="Run steps by product"
                className="flex flex-col gap-2"
              >
                {latest.products.map((product) => (
                  <li
                    key={product.snapshotId}
                    className="flex flex-col gap-1.5 rounded-lg p-2 ring-1 ring-border"
                  >
                    <p className="text-sm font-medium">
                      #{product.position + 1} {product.name}
                    </p>
                    <ul
                      aria-label={`${product.name}: steps`}
                      className="flex flex-wrap gap-1.5"
                    >
                      {product.tasks.map((task) => (
                        <li key={task.id} className="flex items-center gap-1">
                          <span
                            title={task.failureMessage ?? undefined}
                            data-task-status={task.status}
                            className={cn(
                              "rounded-full px-2 py-0.5 text-xs ring-1 ring-inset",
                              TASK_TONE[task.status],
                            )}
                          >
                            <span className="sr-only">{task.label}: </span>
                            {task.label.split(":")[0]} ·{" "}
                            {TASK_STATUS_LABEL[task.status]}
                            {task.attempts > 1
                              ? ` (attempt ${task.attempts})`
                              : ""}
                          </span>
                          {(task.status === "failed" ||
                            task.status === "needs_input") &&
                          !["cancelling", "cancelled"].includes(run.status) ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              aria-label={`Retry ${task.label} for ${product.name}`}
                              disabled={busy !== null}
                              onClick={() =>
                                void act(
                                  `retry-${task.id}`,
                                  `${runEndpoint(ticket.id, run.id)}/tasks/${task.id}/retry`,
                                  { requestId: newRequestId() },
                                )
                              }
                            >
                              <RotateCcw aria-hidden="true" />
                              Retry
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    {product.tasks
                      .filter(
                        (t) =>
                          t.failureMessage &&
                          t.status !== "blocked" &&
                          t.status !== "cancelled",
                      )
                      .map((t) => (
                        <p key={t.id} className="text-xs text-muted-foreground">
                          {t.label.split(":")[0]}: {t.failureMessage}
                        </p>
                      ))}
                  </li>
                ))}
              </ol>

              <details className="text-sm">
                <summary className="cursor-pointer rounded-md font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                  Task history ({latest.events.length})
                </summary>
                <ol
                  aria-label="Run history"
                  className="mt-2 flex flex-col gap-1"
                >
                  {latest.events.map((e) => (
                    <li
                      key={e.id}
                      className="flex justify-between gap-4 text-muted-foreground"
                    >
                      <span>{e.type.replace(/_/g, " ")}</span>
                      <time dateTime={e.createdAt}>
                        {formatDate(e.createdAt)}
                      </time>
                    </li>
                  ))}
                </ol>
              </details>
            </article>
          ) : state.runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          ) : null}

          {state.runs.length > 1 ? (
            <details className="text-sm">
              <summary className="cursor-pointer rounded-md font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                Earlier runs ({state.runs.length - 1})
              </summary>
              <ul className="mt-2 flex flex-col gap-1">
                {state.runs.slice(1).map((r) => (
                  <li
                    key={r.id}
                    className="flex justify-between gap-4 text-muted-foreground"
                  >
                    <span>
                      {runTitle(r)} · {RUN_STATUS_LABEL[r.status]}
                    </span>
                    <time dateTime={r.createdAt}>
                      {formatDate(r.createdAt)}
                    </time>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
