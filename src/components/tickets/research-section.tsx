"use client"

import { useEffect, useRef, useState } from "react"
import { LoaderCircle, RefreshCw, Search } from "lucide-react"

import { FormMessage, formatDate } from "@/components/tickets/fields"
import { ResearchReportView } from "@/components/tickets/research-report"
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
  RUN_STATUS_LABEL,
  TASK_STATUS_LABEL,
  type RunStatus,
  type TaskStatus,
} from "@/lib/orchestrator/model"
import { RUNS_CHANGED_EVENT, runsEndpoint } from "@/lib/orchestrator/types"
import {
  researchEndpoint,
  SCOUT_DIAGNOSTICS_ENDPOINT,
  SOURCE_OUTCOME_LABEL,
  type ResearchOverview,
  type ScoutDiagnostics,
} from "@/lib/scout/types"
import { api, newRequestId } from "@/lib/tickets/client"
import type { ApiError, TicketDetail } from "@/lib/tickets/types"

/**
 * Scout Research (DV-005A). Starts research-only runs (workflow
 * "scout-research-v1") and shows persisted results: per-product task
 * state, needs-input reasons with each source's problem, and every
 * research brief version. Research runs in the worker process
 * (yarn worker:start), never in the browser or the web server.
 */

const sameLink = (a: string, b: string) =>
  a.trim().replace(/\/+$/, "").toLowerCase() ===
  b.trim().replace(/\/+$/, "").toLowerCase()

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return url.slice(0, 60)
  }
}

export function ResearchSection({ ticket }: { ticket: TicketDetail }) {
  const [overview, setOverview] = useState<ResearchOverview | null>(null)
  const [diagnostics, setDiagnostics] = useState<ScoutDiagnostics | null>(null)
  const [loadError, setLoadError] = useState<ApiError | null>(null)
  const [actionError, setActionError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const startRequest = useRef<string | null>(null)

  useEffect(() => {
    const onChange = () => setTick((n) => n + 1)
    window.addEventListener(RUNS_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(RUNS_CHANGED_EVENT, onChange)
  }, [])

  useEffect(() => {
    let cancelled = false
    void api<ScoutDiagnostics>(SCOUT_DIAGNOSTICS_ENDPOINT).then((r) => {
      if (!cancelled && r.ok) setDiagnostics(r.data)
    })
    return () => {
      cancelled = true
    }
  }, [tick])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    void api<ResearchOverview>(researchEndpoint(ticket.id)).then((r) => {
      if (cancelled) return
      if (!r.ok) {
        setLoadError(r.error)
        timer = setTimeout(() => setTick((n) => n + 1), 5_000)
        return
      }
      setLoadError(null)
      setOverview(r.data)
      if (r.data.latestRun && isActiveRun(r.data.latestRun.status as RunStatus))
        timer = setTimeout(() => setTick((n) => n + 1), 2_000)
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [ticket.id, tick])

  const refresh = () => setTick((n) => n + 1)

  const researchable = ticket.products.filter(
    (p) =>
      p.name.trim() !== "" &&
      p.references.some((r) => !sameLink(r.url, p.affiliateUrl)),
  )
  const missing = ticket.products.filter((p) => !researchable.includes(p))
  const hosts = [
    ...new Set(
      researchable.flatMap((p) =>
        p.references
          .filter((r) => !sameLink(r.url, p.affiliateUrl))
          .map((r) => hostOf(r.url)),
      ),
    ),
  ]
  const latest = overview?.latestRun ?? null
  const active = latest ? isActiveRun(latest.status as RunStatus) : false
  const available = overview?.availability.available ?? false
  const blocked = !available
    ? (overview?.availability.reason ?? "Research isn't available.")
    : ticket.status !== "ready"
      ? "Mark the ticket Ready to start research."
      : researchable.length === 0
        ? "Add a reference URL (a public product page, ideally the manufacturer's) to at least one product."
        : active
          ? "Research is already running for this ticket."
          : null

  async function start() {
    startRequest.current ??= newRequestId()
    setBusy(true)
    setActionError(null)
    const result = await api(runsEndpoint(ticket.id), {
      method: "POST",
      body: {
        requestId: startRequest.current,
        ticketVersion: ticket.version,
        mode: "production",
        workflow: "scout-research-v1",
      },
    })
    setBusy(false)
    if (result.ok) startRequest.current = null
    else setActionError(result.error)
    window.dispatchEvent(new Event(RUNS_CHANGED_EVENT))
    refresh()
  }

  const latestReportIds = new Set(
    latest?.tasks.map((t) => t.reportId).filter(Boolean),
  )
  const earlier = (overview?.reports ?? []).filter(
    (r) => !latestReportIds.has(r.id),
  )

  return (
    <section
      aria-labelledby="research-title"
      className="flex max-w-4xl flex-col gap-4"
      data-testid="research-section"
    >
      <h2 id="research-title" className="text-title">
        Scout Research
      </h2>

      {!overview && !loadError ? (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <LoaderCircle
            aria-hidden="true"
            className="size-4 animate-spin motion-reduce:animate-none"
          />
          Loading research…
        </p>
      ) : null}
      {loadError ? (
        <FormMessage>
          <p className="font-semibold">Couldn&apos;t load research.</p>
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

      {overview ? (
        <>
          <div
            data-testid="research-availability"
            className="flex flex-col gap-1 rounded-xl bg-surface-sunken p-4 text-sm ring-1 ring-border"
          >
            <p className="font-semibold">
              {available
                ? "Research only: Scout checks your product facts against your reference pages."
                : "Research is switched off."}
            </p>
            <p className="text-muted-foreground">
              {available
                ? `Scout reads the reference URLs you added to each product (manufacturer pages first, up to ${diagnostics?.retrieval.maxSources ?? 5}), honours robots.txt, never signs in or bypasses blocks, and never visits affiliate links. It doesn't search the web, write scripts or make videos.`
                : overview.availability.reason}
            </p>
            {diagnostics ? (
              <ul
                className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground"
                data-testid="research-diagnostics"
              >
                <li data-testid="worker-status">
                  Worker:{" "}
                  {diagnostics.worker.status === "running"
                    ? diagnostics.worker.handlesResearch
                      ? `running (checked in ${diagnostics.worker.lastSeenSecondsAgo ?? 0}s ago)`
                      : "running, but it can't do research (restart it after turning research on)"
                    : diagnostics.worker.status === "not_seen"
                      ? "not running. Research waits until you start it: yarn worker:start"
                      : "unknown (the database isn't reachable)"}
                </li>
                <li data-testid="extraction-status">
                  Extraction:{" "}
                  {diagnostics.extraction.mode === "deterministic"
                    ? "deterministic (structured data and page text; no AI model)"
                    : diagnostics.extraction.ollama.configured
                      ? `local model ${diagnostics.extraction.ollama.model} via Ollama: ${diagnostics.extraction.ollama.modelAvailable ? "available" : (diagnostics.extraction.ollama.problem ?? "unavailable")}`
                      : `local model not usable (${diagnostics.extraction.ollama.problem ?? "not configured"}); deterministic extraction is used`}
                </li>
                <li>
                  Full campaign automation: not available yet (
                  {diagnostics.fullCampaign.missing.join(", ")}).
                </li>
              </ul>
            ) : null}
          </div>

          {missing.length > 0 ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="research-missing-references"
            >
              No research reference yet:{" "}
              {missing
                .map((p) => p.name || `Product #${p.position + 1}`)
                .join(", ")}
              . Scout will ask for one (the affiliate link isn&apos;t evidence).
            </p>
          ) : null}

          <div className="flex flex-col gap-1">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  className="w-fit"
                  disabled={busy || blocked !== null}
                >
                  {busy ? (
                    <LoaderCircle
                      aria-hidden="true"
                      className="animate-spin motion-reduce:animate-none"
                    />
                  ) : (
                    <Search aria-hidden="true" />
                  )}
                  Start research
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Start Scout research?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Scout will read {researchable.length} product
                    {researchable.length === 1 ? "" : "s"}&apos; reference pages
                    from: {hosts.slice(0, 8).join(", ")}
                    {hosts.length > 8 ? ` and ${hosts.length - 8} more` : ""}.
                    It uses a frozen copy of the ticket as it is now; later
                    edits need a new run.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Not now</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void start()}>
                    Start research
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            {blocked ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid="research-blocked"
              >
                {blocked}
              </p>
            ) : null}
          </div>

          {actionError ? (
            <FormMessage>
              <p className="font-semibold">Research didn&apos;t start.</p>
              <p className="mt-1">{actionError.message}</p>
            </FormMessage>
          ) : null}

          {latest ? (
            <article
              aria-labelledby="research-run-title"
              className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-border"
              data-research-run-status={latest.status}
            >
              <header className="flex flex-wrap items-center gap-2">
                <h3 id="research-run-title" className="font-semibold">
                  Latest research run
                </h3>
                <span
                  data-testid="research-run-status"
                  className="rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-border ring-inset"
                >
                  {RUN_STATUS_LABEL[latest.status as RunStatus] ??
                    latest.status}
                </span>
                <span className="text-sm text-muted-foreground">
                  {formatDate(latest.createdAt)} · ticket version{" "}
                  {latest.ticketVersion}
                  {latest.ticketVersion !== ticket.version
                    ? " (the ticket changed since; start a new run to research the changes)"
                    : ""}
                </span>
              </header>
              {active &&
              diagnostics &&
              diagnostics.worker.status !== "running" ? (
                <p
                  className="text-sm text-status-waiting"
                  data-testid="research-needs-worker"
                >
                  Waiting for a worker. Start one with yarn worker:start.
                </p>
              ) : null}
              <ul
                aria-label="Research by product"
                className="flex flex-col gap-2"
              >
                {latest.tasks.map((t) => (
                  <li
                    key={t.taskId}
                    data-research-task-status={t.status}
                    className="flex flex-col gap-1.5 rounded-lg p-3 ring-1 ring-border"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{t.productName}</p>
                      <span className="text-xs text-muted-foreground">
                        Scout ·{" "}
                        {TASK_STATUS_LABEL[t.status as TaskStatus] ?? t.status}
                        {t.attempts > 1 ? ` (attempt ${t.attempts})` : ""}
                      </span>
                    </div>
                    {t.failureMessage && t.status !== "cancelled" ? (
                      <p
                        className="text-xs break-words"
                        data-testid="research-task-message"
                      >
                        {t.failureMessage}
                      </p>
                    ) : null}
                    {t.sourceProblems.length > 0 && t.status !== "completed" ? (
                      <ul
                        aria-label={`${t.productName}: source problems`}
                        className="list-disc pl-5 text-xs text-muted-foreground"
                      >
                        {t.sourceProblems.map((p) => (
                          <li key={`${p.host}-${p.outcome}`}>
                            {p.host}:{" "}
                            {SOURCE_OUTCOME_LABEL[p.outcome] ?? p.outcome}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {t.reportId ? (
                      <details
                        open={open === t.reportId}
                        onToggle={(e) =>
                          setOpen(
                            (e.target as HTMLDetailsElement).open
                              ? t.reportId
                              : open === t.reportId
                                ? null
                                : open,
                          )
                        }
                      >
                        <summary className="cursor-pointer rounded-md text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                          Research brief
                        </summary>
                        {open === t.reportId ? (
                          <div className="mt-2">
                            <ResearchReportView
                              ticketId={ticket.id}
                              runId={latest.id}
                              snapshotId={t.snapshotId}
                            />
                          </div>
                        ) : null}
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            </article>
          ) : (
            <p className="text-sm text-muted-foreground">No research yet.</p>
          )}

          {earlier.length > 0 ? (
            <details className="text-sm" data-testid="research-history">
              <summary className="cursor-pointer rounded-md font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                Earlier research ({earlier.length})
              </summary>
              <ul className="mt-2 flex flex-col gap-2">
                {earlier.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-col gap-1 rounded-lg p-2 ring-1 ring-border"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        {r.productName} · version {r.reportVersion} ·{" "}
                        {formatDate(r.createdAt)} · {r.counts.supported}{" "}
                        supported, {r.counts.conflicting} conflicting,{" "}
                        {r.counts.unverified} unverified
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        aria-expanded={open === r.id}
                        onClick={() => setOpen(open === r.id ? null : r.id)}
                      >
                        {open === r.id ? "Hide" : "View"}
                      </Button>
                    </div>
                    {open === r.id ? (
                      <ResearchReportView
                        ticketId={ticket.id}
                        runId={r.runId}
                        snapshotId={r.snapshotId}
                      />
                    ) : null}
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
