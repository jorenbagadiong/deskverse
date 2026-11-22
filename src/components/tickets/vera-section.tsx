"use client"

import { useEffect, useRef, useState } from "react"
import { FormMessage, formatDate } from "@/components/tickets/fields"
import { Button } from "@/components/ui/button"
import {
  RUNS_CHANGED_EVENT,
  runsEndpoint,
  runEndpoint,
} from "@/lib/orchestrator/types"
import { deliverableVideoUrl } from "@/lib/pixel/types"
import { reportEndpoint } from "@/lib/scout/types"
import { scriptEndpoint } from "@/lib/quill/types"
import { api, newRequestId } from "@/lib/tickets/client"
import type { TicketDetail } from "@/lib/tickets/types"
import {
  veraEndpoint,
  VERDICT_LABEL,
  type VeraOverview,
  type VeraReview,
  type CheckOutcome,
} from "@/lib/vera/types"

const OUTCOME_LABEL: Record<CheckOutcome, string> = {
  passed: "Machine verified",
  failed: "Machine flagged",
  warning: "Warning",
  manual_review_required: "Human review required",
  not_evaluated: "Not evaluated",
}
export function VeraSection({ ticket }: { ticket: TicketDetail }) {
  const [overview, setOverview] = useState<VeraOverview | null>(null)
  const [selected, setSelected] = useState("")
  const [review, setReview] = useState<VeraReview | null>(null)
  const [busy, setBusy] = useState(false)
  const [detailBusy, setDetailBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [offset, setOffset] = useState(0)
  const request = useRef<string | null>(null)
  const detailRequest = useRef(0)
  useEffect(() => {
    const changed = () => setTick((n) => n + 1)
    window.addEventListener(RUNS_CHANGED_EVENT, changed)
    return () => window.removeEventListener(RUNS_CHANGED_EVENT, changed)
  }, [])
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    void api<VeraOverview>(
      `${veraEndpoint(ticket.id)}?offset=${offset}&limit=20`,
    ).then((r) => {
      if (cancelled) return
      if (!r.ok) {
        setError(r.error.message)
        return
      }
      setOverview(r.data)
      timer = setTimeout(
        () => setTick((n) => n + 1),
        r.data.tasks.some((t) =>
          ["running", "queued", "retry_wait"].includes(t.status),
        )
          ? 1500
          : 10000,
      )
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [ticket.id, tick, offset])
  const choice = overview?.deliverables.find((d) => d.id === selected)
  const active = overview?.tasks.find((t) =>
    ["queued", "running", "retry_wait"].includes(t.status),
  )
  async function act(url: string, body: unknown) {
    setBusy(true)
    setError(null)
    const r = await api(url, { method: "POST", body })
    setBusy(false)
    if (!r.ok) setError(r.error.message)
    window.dispatchEvent(new Event(RUNS_CHANGED_EVENT))
    return r.ok
  }
  async function start() {
    if (!choice) return
    request.current ??= newRequestId()
    if (
      await act(runsEndpoint(ticket.id), {
        requestId: request.current,
        ticketVersion: ticket.version,
        mode: "production",
        workflow: "vera-review-v1",
        reviews: [{ productId: choice.productId, deliverableId: choice.id }],
      })
    )
      request.current = null
  }
  async function open(id: string) {
    const sequence = ++detailRequest.current
    setDetailBusy(true)
    setError(null)
    setReview(null)
    const r = await api<VeraReview>(`${veraEndpoint(ticket.id)}/${id}`)
    if (sequence !== detailRequest.current) return
    setDetailBusy(false)
    if (r.ok) setReview(r.data)
    else setError(r.error.message)
  }
  return (
    <section
      aria-labelledby="vera-title"
      className="flex max-w-4xl min-w-0 flex-col gap-4"
      data-testid="vera-section"
    >
      <h2 id="vera-title" className="text-title">
        Vera Quality Review
      </h2>
      <p className="text-sm text-muted-foreground">
        Review one exact completed Pixel version. Technically Verified means
        Pixel confirmed format and rendering checks. A completed review records
        its QA assessment; it does not grant human approval or publishing
        permission.
      </p>
      {!overview ? (
        <p role="status">Loading quality reviews…</p>
      ) : (
        <>
          <div className="rounded-xl bg-surface-sunken p-4 text-sm ring-1 ring-border">
            <p>
              {overview.availability.reason ??
                "Local deterministic QA is available."}
            </p>
            {!overview.workerOnline ? (
              <p className="mt-2 text-status-waiting">
                Worker offline or not seen. Start yarn worker:start to process
                reviews.
              </p>
            ) : null}
          </div>
          {overview.deliverables.length ? (
            <>
              <label htmlFor="vera-deliverable" className="text-sm font-medium">
                Pixel deliverable to review
              </label>
              <select
                id="vera-deliverable"
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value)
                  request.current = null
                }}
                className="min-h-11 w-full min-w-0 rounded-md border border-border bg-background p-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
              >
                <option value="">Choose an exact video version</option>
                {overview.deliverables.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.productName} · video v{d.version} · Quill v
                    {d.scriptVersion} ·{" "}
                    {d.current ? "Current inputs" : "Historical inputs"}
                  </option>
                ))}
              </select>
              {choice ? (
                <div className="min-w-0 text-sm break-words">
                  <p>
                    Technically Verified · video v{choice.version} · Quill
                    script v{choice.scriptVersion}
                  </p>
                  <p>
                    {choice.current
                      ? "Matches the current product input."
                      : "Historical version: this review applies only to the original frozen inputs."}
                  </p>
                  <p className="mt-1">
                    {choice.latestReview
                      ? VERDICT_LABEL[choice.latestReview.verdict]
                      : "Awaiting Vera QA"}
                  </p>
                  {choice.reviewProblem ? <p>{choice.reviewProblem}</p> : null}
                  <a
                    href={deliverableVideoUrl(ticket.id, choice.id)}
                    className="mt-2 inline-block underline underline-offset-4"
                  >
                    View selected video
                  </a>
                </div>
              ) : null}
              <Button
                type="button"
                className="w-fit"
                disabled={
                  busy ||
                  !choice ||
                  Boolean(choice.reviewProblem) ||
                  !overview.availability.available ||
                  Boolean(active) ||
                  ticket.status !== "ready"
                }
                onClick={() => void start()}
              >
                {busy ? "Starting review…" : "Start Review"}
              </Button>
              {ticket.status !== "ready" ? (
                <p className="text-sm text-muted-foreground">
                  Mark the ticket Ready before starting a review.
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm">
              No completed Pixel videos on this page. Run Scout, write a Quill
              script, then render with Pixel before starting QA.
            </p>
          )}
          {active ? (
            <div
              role="status"
              className="rounded-lg p-3 text-sm ring-1 ring-border"
            >
              <p>
                {active.status === "running"
                  ? "Review in progress: decoding video and checking pinned evidence."
                  : "Review queued: waiting for a worker."}{" "}
                Attempt {active.attempts} of {active.maxAttempts}.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                disabled={busy}
                onClick={() =>
                  void act(`${runEndpoint(ticket.id, active.runId)}/cancel`, {
                    requestId: newRequestId(),
                  })
                }
              >
                Cancel review
              </Button>
            </div>
          ) : null}
          {overview.tasks
            .filter((t) => ["failed", "needs_input"].includes(t.status))
            .slice(0, 3)
            .map((t) => (
              <p key={t.id} className="text-sm">
                Review execution {t.status.replaceAll("_", " ")}: {t.message}{" "}
                Use Workflow controls to retry after correcting the execution
                problem.
              </p>
            ))}
          <h3 className="font-semibold">Historical reviews</h3>
          {overview.history.length ? (
            <ul className="flex flex-col gap-2">
              {overview.history.map((r) => (
                <li
                  key={r.id}
                  className="rounded-lg p-3 text-sm ring-1 ring-border"
                >
                  <p>
                    {VERDICT_LABEL[r.verdict]} · video v{r.deliverableVersion} ·
                    review v{r.version} · {formatDate(r.createdAt)}
                  </p>
                  {r.verdict === "pass" ? <p>Awaiting Human Approval</p> : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => void open(r.id)}
                  >
                    Read review v{r.version}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No recorded reviews on this page.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset((n) => Math.max(0, n - 20))}
            >
              Previous
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                overview.deliverables.length < 20 &&
                overview.history.length < 20
              }
              onClick={() => setOffset((n) => n + 20)}
            >
              Next
            </Button>
          </div>
        </>
      )}
      {detailBusy ? <p role="status">Loading review evidence…</p> : null}
      {review ? (
        <article
          className="min-w-0 rounded-xl bg-card p-4 ring-1 ring-border"
          aria-label="QA review detail"
        >
          <h3 className="font-semibold">
            {VERDICT_LABEL[review.document.verdict]} · review v{review.version}
          </h3>
          <p className="mt-1 text-sm">
            Video v{review.document.pin.deliverableVersion} · Quill v
            {review.document.pin.manifest.script.version} · Scout v
            {review.document.pin.manifest.report.version} ·{" "}
            {review.document.ruleset}
          </p>
          <p className="text-sm">
            {review.current
              ? "Current product inputs"
              : "Historical product inputs"}{" "}
            · Report checksum {review.integrity}
          </p>
          {review.document.verdict === "pass" ? (
            <p className="mt-2 text-sm font-medium">Awaiting Human Approval</p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-4 text-sm">
            <a
              className="underline"
              href={scriptEndpoint(
                ticket.id,
                review.document.pin.manifest.script.runId,
                review.document.pin.manifest.script.id,
              )}
            >
              Source Quill script and evidence references
            </a>
            <a
              className="underline"
              href={reportEndpoint(
                ticket.id,
                review.document.pin.researchLocation.runId,
                review.document.pin.researchLocation.snapshotId,
              )}
            >
              Pinned Scout report and source passages
            </a>
            <a
              className="underline"
              href={deliverableVideoUrl(
                ticket.id,
                review.document.pin.deliverableId,
              )}
            >
              Exact reviewed video
            </a>
          </div>
          <p className="mt-3 text-sm">
            No automatic content revisions. Correct facts, assets, rights or
            script text through a new version. Warnings require inspection
            before human approval.
          </p>
          <ul className="mt-4 flex flex-col gap-3">
            {review.document.findings.map((f, i) => (
              <li
                key={i}
                className="min-w-0 rounded-lg p-3 text-sm ring-1 ring-border"
              >
                <p className="font-semibold">
                  {OUTCOME_LABEL[f.outcome]} · {f.ruleId}
                  {f.sceneId ? ` · ${f.sceneId}` : ""}
                </p>
                <p className="mt-1">{f.expected}</p>
                {f.remediation ? (
                  <p className="mt-1">Action: {f.remediation}</p>
                ) : null}
                <details className="mt-2">
                  <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                    Technical evidence
                  </summary>
                  <pre className="mt-2 text-xs break-all whitespace-pre-wrap">
                    {JSON.stringify(f.observed, null, 2)}
                  </pre>
                  <p className="mt-1 text-xs break-all">
                    Artifacts: {f.artifacts.join(", ")} ·{" "}
                    {formatDate(f.checkedAt)}
                  </p>
                </details>
              </li>
            ))}
          </ul>
        </article>
      ) : null}
      {error ? (
        <FormMessage>
          <p>{error}</p>
          <Button
            type="button"
            variant="outline"
            className="mt-2"
            onClick={() => {
              setError(null)
              setTick((n) => n + 1)
            }}
          >
            Try again
          </Button>
        </FormMessage>
      ) : null}
    </section>
  )
}
