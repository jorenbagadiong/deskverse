"use client"

import { useEffect, useRef, useState } from "react"
import {
  ExternalLink,
  LoaderCircle,
  PenLine,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react"

import { FormMessage, formatDate } from "@/components/tickets/fields"
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
  GENERATION_MODE_LABEL,
  quillEndpoint,
  scriptEndpoint,
  type QuillOverview,
  type QuillScript,
} from "@/lib/quill/types"
import {
  SCOUT_DIAGNOSTICS_ENDPOINT,
  type ScoutDiagnostics,
} from "@/lib/scout/types"
import { api, newRequestId } from "@/lib/tickets/client"
import type { ApiError, TicketDetail } from "@/lib/tickets/types"
import { cn } from "@/lib/utils"

/**
 * Quill Scripts (DV-005B). Starts scriptwriting-only runs (workflow
 * "quill-script-v1") from Scout reports the owner chooses, and shows the
 * persisted scripts with the evidence behind every factual scene. All text
 * is rendered as plain (escaped) text. Writing happens in the worker.
 */

const KIND_LABEL = {
  hook: "Hook",
  benefit: "Benefit",
  "call-to-action": "Call to action",
} as const

function safeHref(url: string) {
  try {
    const u = new URL(url)
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null
  } catch {
    return null
  }
}

function ScriptView({
  ticketId,
  runId,
  scriptId,
}: {
  ticketId: string
  runId: string
  scriptId: string
}) {
  const [script, setScript] = useState<QuillScript | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  useEffect(() => {
    let cancelled = false
    void api<QuillScript>(scriptEndpoint(ticketId, runId, scriptId)).then(
      (r) => {
        if (cancelled) return
        if (r.ok) setScript(r.data)
        else setError(r.error)
      },
    )
    return () => {
      cancelled = true
    }
  }, [ticketId, runId, scriptId])
  if (error)
    return (
      <FormMessage>
        <p className="font-semibold">Couldn&apos;t load this script.</p>
        <p className="mt-1">{error.message}</p>
      </FormMessage>
    )
  if (!script)
    return (
      <p
        role="status"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <LoaderCircle
          aria-hidden="true"
          className="size-4 animate-spin motion-reduce:animate-none"
        />
        Loading the script…
      </p>
    )
  const d = script.document
  return (
    <div className="flex flex-col gap-3" data-testid="quill-script">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          Version {script.scriptVersion} · {formatDate(script.createdAt)} ·{" "}
          {GENERATION_MODE_LABEL[d.generation.mode]} · from research version{" "}
          {d.report.version} · about {(d.totalDurationMs / 1000).toFixed(1)} s
        </span>
        <span
          data-testid="script-integrity"
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 ring-1 ring-inset",
            script.integrity === "verified"
              ? "text-status-completed ring-status-completed/35"
              : "text-status-failed ring-status-failed/40",
          )}
        >
          {script.integrity === "verified" ? (
            <ShieldCheck aria-hidden="true" className="size-3" />
          ) : (
            <ShieldAlert aria-hidden="true" className="size-3" />
          )}
          {script.integrity === "verified"
            ? "Checksum verified"
            : "Checksum mismatch"}
        </span>
      </div>
      {d.generation.note ? (
        <p className="text-xs text-muted-foreground">{d.generation.note}</p>
      ) : null}
      <ul className="flex flex-col gap-1 text-xs" data-testid="script-pixel">
        <li>
          Pixel text limits:{" "}
          {d.pixel.textCompatible
            ? "compatible"
            : `not yet compatible (${d.pixel.textIssues.join(" ")})`}
        </li>
        <li>
          Ready to render:{" "}
          {d.pixel.renderReady
            ? `yes (${d.pixel.imageCount} images); rendering arrives with DV-005C`
            : `not yet. ${d.pixel.renderIssues.join(" ")}`}
        </li>
      </ul>
      <ol aria-label="Scenes" className="flex flex-col gap-2">
        {d.scenes.map((s) => (
          <li
            key={s.id}
            data-scene-kind={s.kind}
            className="flex flex-col gap-1 rounded-lg p-3 ring-1 ring-border"
          >
            <p className="text-xs font-semibold text-muted-foreground">
              {s.id.replace("scene-", "Scene ")} · {KIND_LABEL[s.kind]} ·{" "}
              {(s.durationMs / 1000).toFixed(1)} s
            </p>
            <p
              className="text-base font-semibold break-words"
              data-testid="scene-caption"
            >
              {s.caption}
            </p>
            {s.subtext ? (
              <p className="text-xs break-words text-muted-foreground">
                {s.subtext}
              </p>
            ) : null}
            <p className="text-sm break-words">
              <span className="sr-only">Narration: </span>“{s.narration}”
            </p>
            <p className="text-xs break-words text-muted-foreground">
              Visual: {s.visual}
            </p>
            {s.notes.map((n) => (
              <p key={n} className="text-xs break-words text-status-waiting">
                {n}
              </p>
            ))}
            {s.claims.length > 0 ? (
              <ul
                aria-label="Evidence for this scene"
                className="flex flex-col gap-1"
              >
                {s.claims.map((c) => (
                  <li
                    key={c.claimKey}
                    className="rounded-md bg-surface-sunken p-2 text-xs"
                    data-claim-key={c.claimKey}
                  >
                    <p className="font-medium break-words">
                      {c.claimKey}: {c.statement}
                    </p>
                    <ul className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
                      {c.evidence.map((e) => {
                        const href = safeHref(e.sourceUrl)
                        const host = href
                          ? new URL(href).hostname
                          : e.sourceUrl.slice(0, 60)
                        return (
                          <li key={e.key} data-evidence-key={e.key}>
                            {e.key} · {e.sourceKey}{" "}
                            {href ? (
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer nofollow"
                                referrerPolicy="no-referrer"
                                className="inline-flex items-center gap-1 underline decoration-border underline-offset-2"
                              >
                                {host}
                                <ExternalLink
                                  aria-hidden="true"
                                  className="size-3"
                                />
                                <span className="sr-only">
                                  (opens in a new tab)
                                </span>
                              </a>
                            ) : (
                              host
                            )}
                            {e.retrievedAt
                              ? ` · retrieved ${formatDate(e.retrievedAt)}`
                              : ""}
                          </li>
                        )
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">
                No product facts in this scene.
              </p>
            )}
          </li>
        ))}
      </ol>
      <p
        className="rounded-md p-2 text-xs ring-1 ring-status-info/35"
        data-testid="script-disclosure"
      >
        Disclosure on every scene: {d.disclosure.text}
      </p>
      {d.findings.length > 0 ? (
        <section aria-label="Validation notes" className="text-xs">
          <h5 className="font-semibold">Validation notes</h5>
          <ul className="list-disc pl-5 text-muted-foreground">
            {d.findings.map((f, i) => (
              <li key={i} className="break-words">
                {f.sceneId ? `${f.sceneId}: ` : ""}
                {f.message}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-xs text-muted-foreground">
          Validation: no problems found.
        </p>
      )}
      {d.excludedClaims.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer rounded-md font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            Not used in the script ({d.excludedClaims.length})
          </summary>
          <ul
            className="mt-1 list-disc pl-5 text-muted-foreground"
            data-testid="script-excluded"
          >
            {d.excludedClaims.map((e) => (
              <li key={e.claimKey} className="break-words">
                {e.statement}: {e.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}

export function QuillSection({ ticket }: { ticket: TicketDetail }) {
  const [overview, setOverview] = useState<QuillOverview | null>(null)
  const [worker, setWorker] = useState<ScoutDiagnostics["worker"] | null>(null)
  const [loadError, setLoadError] = useState<ApiError | null>(null)
  const [actionError, setActionError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [open, setOpen] = useState<string | null>(null)
  const startRequest = useRef<string | null>(null)

  useEffect(() => {
    const onChange = () => setTick((n) => n + 1)
    window.addEventListener(RUNS_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(RUNS_CHANGED_EVENT, onChange)
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    void api<QuillOverview>(quillEndpoint(ticket.id)).then((r) => {
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
    void api<ScoutDiagnostics>(SCOUT_DIAGNOSTICS_ENDPOINT).then((r) => {
      if (!cancelled && r.ok) setWorker(r.data.worker)
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [ticket.id, tick])

  // Default choice: the newest report that is current, verified and usable.
  const selected = (productId: string) => {
    if (productId in choice) return choice[productId]
    const p = overview?.products.find((x) => x.productId === productId)
    return p?.reports.find((r) => r.problem === null)?.reportId ?? ""
  }
  const selections = (overview?.products ?? [])
    .map((p) => ({ productId: p.productId, reportId: selected(p.productId) }))
    .filter((s) => s.reportId)
  const latest = overview?.latestRun ?? null
  const active = latest ? isActiveRun(latest.status as RunStatus) : false
  const blocked =
    ticket.status !== "ready"
      ? "Mark the ticket Ready to write scripts."
      : selections.length === 0
        ? "Choose a usable Scout report for at least one product (run Scout research first)."
        : active
          ? "Scriptwriting is already running for this ticket."
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
        workflow: "quill-script-v1",
        scripts: selections,
      },
    })
    setBusy(false)
    if (result.ok) startRequest.current = null
    else setActionError(result.error)
    window.dispatchEvent(new Event(RUNS_CHANGED_EVENT))
    setTick((n) => n + 1)
  }

  const latestScripts = new Set(
    latest?.tasks.map((t) => t.scriptId).filter(Boolean),
  )
  const earlier = (overview?.scripts ?? []).filter(
    (s) => !latestScripts.has(s.id),
  )

  return (
    <section
      aria-labelledby="quill-title"
      className="flex max-w-4xl flex-col gap-4"
      data-testid="quill-section"
    >
      <h2 id="quill-title" className="text-title">
        Quill Scripts
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
          Loading scripts…
        </p>
      ) : null}
      {loadError ? (
        <FormMessage>
          <p className="font-semibold">Couldn&apos;t load scripts.</p>
          <p className="mt-1">{loadError.message}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => setTick((n) => n + 1)}
          >
            <RefreshCw aria-hidden="true" />
            Try again
          </Button>
        </FormMessage>
      ) : null}
      {overview ? (
        <>
          <div
            data-testid="quill-availability"
            className="flex flex-col gap-1 rounded-xl bg-surface-sunken p-4 text-sm ring-1 ring-border"
          >
            <p className="font-semibold">
              Scriptwriting only: Quill writes from a Scout report you choose.
            </p>
            <p className="text-muted-foreground">
              Only facts Scout found supported by a source become copy; prices,
              ratings, stock, health, warranty and &quot;best&quot; claims never
              do. Every factual scene links to its evidence, and the affiliate
              disclosure is on every scene. Nothing is rendered or published.
            </p>
            <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
              <li data-testid="quill-mode">
                Writing:{" "}
                {overview.availability.mode === "ollama"
                  ? (overview.availability.reason ??
                    "templates + local AI wording (Ollama), every proposal validated")
                  : "templates (no AI model)"}
              </li>
              <li data-testid="quill-worker">
                Worker:{" "}
                {worker?.status === "running"
                  ? "running"
                  : worker?.status === "not_seen"
                    ? "not running. Scripts wait until you start it: yarn worker:start"
                    : "unknown"}
              </li>
            </ul>
          </div>

          <fieldset className="flex flex-col gap-3" data-testid="quill-choices">
            <legend className="mb-1 text-sm font-semibold">
              Research to write from
            </legend>
            {overview.products.map((p) => (
              <div key={p.productId} className="flex flex-col gap-1">
                <label
                  htmlFor={`quill-report-${p.productId}`}
                  className="text-sm font-medium"
                >
                  {p.name}
                </label>
                <select
                  id={`quill-report-${p.productId}`}
                  className="w-full max-w-xl rounded-md bg-background px-2 py-1.5 text-sm ring-1 ring-border outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  value={selected(p.productId)}
                  onChange={(e) =>
                    setChoice({ ...choice, [p.productId]: e.target.value })
                  }
                >
                  <option value="">
                    Don&apos;t write a script for this product
                  </option>
                  {p.reports.map((r) => (
                    <option
                      key={r.reportId}
                      value={r.reportId}
                      disabled={r.problem !== null}
                    >
                      Research version {r.reportVersion} ·{" "}
                      {formatDate(r.createdAt)} · {r.eligibleFacts} usable facts
                      {r.problem
                        ? ` · ${r.problem}`
                        : r.current
                          ? " · matches the current product"
                          : ""}
                    </option>
                  ))}
                </select>
                {p.reports.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No Scout research yet. Run it in Scout Research above.
                  </p>
                ) : !p.reports.some((r) => r.problem === null) ? (
                  <p
                    className="text-xs text-status-waiting"
                    data-testid="quill-no-usable"
                  >
                    {p.reports[0].problem}
                  </p>
                ) : null}
              </div>
            ))}
          </fieldset>

          <div className="flex flex-col gap-1">
            <Button
              type="button"
              className="w-fit"
              disabled={busy || blocked !== null}
              onClick={() => void start()}
            >
              {busy ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="animate-spin motion-reduce:animate-none"
                />
              ) : (
                <PenLine aria-hidden="true" />
              )}
              Start scriptwriting
            </Button>
            {blocked ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid="quill-blocked"
              >
                {blocked}
              </p>
            ) : null}
          </div>
          {actionError ? (
            <FormMessage>
              <p className="font-semibold">Scriptwriting didn&apos;t start.</p>
              <p className="mt-1">{actionError.message}</p>
            </FormMessage>
          ) : null}

          {latest ? (
            <article
              aria-labelledby="quill-run-title"
              className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-border"
            >
              <header className="flex flex-wrap items-center gap-2">
                <h3 id="quill-run-title" className="font-semibold">
                  Latest scriptwriting run
                </h3>
                <span
                  data-testid="quill-run-status"
                  className="rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-border ring-inset"
                >
                  {RUN_STATUS_LABEL[latest.status as RunStatus] ??
                    latest.status}
                </span>
                <span className="text-sm text-muted-foreground">
                  {formatDate(latest.createdAt)}
                </span>
              </header>
              {active && worker && worker.status !== "running" ? (
                <p className="text-sm text-status-waiting">
                  Waiting for a worker. Start one with yarn worker:start.
                </p>
              ) : null}
              <ul
                aria-label="Scripts by product"
                className="flex flex-col gap-2"
              >
                {latest.tasks.map((t) => (
                  <li
                    key={t.taskId}
                    data-quill-task-status={t.status}
                    className="flex flex-col gap-1.5 rounded-lg p-3 ring-1 ring-border"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{t.productName}</p>
                      <span className="text-xs text-muted-foreground">
                        Quill ·{" "}
                        {TASK_STATUS_LABEL[t.status as TaskStatus] ?? t.status}
                        {t.reportVersion
                          ? ` · research version ${t.reportVersion}`
                          : ""}
                      </span>
                    </div>
                    {t.failureMessage && t.status !== "cancelled" ? (
                      <p
                        className="text-xs break-words"
                        data-testid="quill-task-message"
                      >
                        {t.failureMessage}
                      </p>
                    ) : null}
                    {t.scriptId ? (
                      <details
                        open={open === t.scriptId}
                        onToggle={(e) =>
                          setOpen(
                            (e.target as HTMLDetailsElement).open
                              ? t.scriptId
                              : open === t.scriptId
                                ? null
                                : open,
                          )
                        }
                      >
                        <summary className="cursor-pointer rounded-md text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                          Script
                        </summary>
                        {open === t.scriptId ? (
                          <div className="mt-2">
                            <ScriptView
                              ticketId={ticket.id}
                              runId={latest.id}
                              scriptId={t.scriptId}
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
            <p className="text-sm text-muted-foreground">No scripts yet.</p>
          )}

          {earlier.length > 0 ? (
            <details className="text-sm" data-testid="quill-history">
              <summary className="cursor-pointer rounded-md font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                Earlier scripts ({earlier.length})
              </summary>
              <ul className="mt-2 flex flex-col gap-2">
                {earlier.map((s) => (
                  <li
                    key={s.id}
                    className="flex flex-col gap-1 rounded-lg p-2 ring-1 ring-border"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        {s.productName} · script version {s.scriptVersion} ·
                        research version {s.reportVersion} ·{" "}
                        {formatDate(s.createdAt)}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        aria-expanded={open === s.id}
                        onClick={() => setOpen(open === s.id ? null : s.id)}
                      >
                        {open === s.id ? "Hide" : "View"}
                      </Button>
                    </div>
                    {open === s.id ? (
                      <ScriptView
                        ticketId={ticket.id}
                        runId={s.runId}
                        scriptId={s.id}
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
