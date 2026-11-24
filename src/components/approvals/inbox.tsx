"use client"

import {
  Fragment,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  CHECKLIST,
  DECISION_LABEL,
  REVISION_CATEGORIES,
  decisionTransition,
  hasChecklist,
  safeExternalUrl,
  type ChecklistKey,
  type DecisionInput,
  type DecisionKind,
} from "@/lib/approvals/policy"
import {
  formatTicketNumber,
  TICKET_PLATFORMS,
  PLATFORM_LABEL,
} from "@/lib/tickets/types"
import { VERDICT_LABEL } from "@/lib/vera/types"
import type {
  approvalEligibility,
  approvalHistory,
  listApprovals,
} from "@/server/approvals/store"

type InboxPage = Awaited<ReturnType<typeof listApprovals>>
type Detail = Awaited<ReturnType<typeof approvalEligibility>>
type Event = Omit<
  Awaited<ReturnType<typeof approvalHistory>>[number],
  "created_at"
> & { created_at: string }
type Queued = {
  deliverableId: string
  name: string
  version: number
  decision: DecisionInput
}
const panel =
  "min-w-0 space-y-4 rounded-xl border bg-card p-4 text-card-foreground"
const control =
  "w-full rounded-md border bg-background px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-ring"
const labelClass = "grid gap-1 text-sm"

async function api<T>(
  path: string,
  signal?: AbortSignal,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/approvals${path}`, {
    signal,
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  })
  const result = await response.json()
  if (!response.ok)
    throw Error(result.message ?? "The approval request failed.")
  return result
}

function useApprovalQuery<T>(path: string, refresh: number) {
  const [result, setResult] = useState<{ data?: T; error?: string } | null>(
    null,
  )
  useEffect(() => {
    const controller = new AbortController()
    api<T>(path, controller.signal).then(
      (data) => setResult({ data }),
      (error: Error) => {
        if (!controller.signal.aborted) setResult({ error: error.message })
      },
    )
    return () => controller.abort()
  }, [path, refresh])
  return result
}

function Confirmation({
  children,
  title,
  description,
  run,
  disabled,
}: {
  children: ReactNode
  title: string
  description: ReactNode
  run: () => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button disabled={disabled}>{children}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-h-[85dvh] overflow-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            onClick={() => {
              setOpen(false)
              run()
            }}
          >
            Confirm decision
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function ApprovalInbox() {
  const [id, setId] = useState("")
  const [offset, setOffset] = useState(0)
  const [filters, setFilters] = useState({
    status: "",
    platform: "",
    search: "",
  })
  const [refresh, setRefresh] = useState(0)
  const [queue, setQueue] = useState<Queued[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const query = new URLSearchParams({
    ...filters,
    offset: String(offset),
  }).toString()
  const reload = () => setRefresh((value) => value + 1)
  function filter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const values = new FormData(e.currentTarget)
    setFilters({
      status: String(values.get("status")),
      platform: String(values.get("platform")),
      search: String(values.get("search")),
    })
    setOffset(0)
  }
  function add(item: Queued) {
    if (
      queue.length >= 10 &&
      !queue.some((other) => other.deliverableId === item.deliverableId)
    )
      return
    setQueue((items) => [
      ...items.filter((other) => other.deliverableId !== item.deliverableId),
      item,
    ])
    setMessage(`${item.name} v${item.version} added to the batch.`)
  }
  async function submitBulk() {
    setBusy(true)
    try {
      const { results } = await api<{
        results: { deliverableId: string; ok: boolean; message?: string }[]
      }>("/bulk", undefined, {
        items: queue.map(({ deliverableId, decision }) => ({
          deliverableId,
          decision,
        })),
      })
      setMessage(
        results
          .map((result) => {
            const item = queue.find(
              (entry) => entry.deliverableId === result.deliverableId,
            )
            return `${item?.name} v${item?.version} — ${result.ok ? DECISION_LABEL.approved : result.message}`
          })
          .join("\n"),
      )
      setQueue((items) =>
        items.filter(
          (item) =>
            !results.some(
              (result) =>
                result.ok && result.deliverableId === item.deliverableId,
            ),
        ),
      )
      reload()
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Bulk approval failed.",
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <p role="status" className="text-sm wrap-anywhere whitespace-pre-line">
        {message}
      </p>
      {queue.length > 0 && (
        <section className={panel} aria-label="Approval batch">
          <h2 className="font-semibold">
            Selected for bulk approval ({queue.length}/10)
          </h2>
          <ul className="space-y-1">
            {queue.map((item) => (
              <li
                key={item.deliverableId}
                className="flex flex-wrap items-center gap-2"
              >
                <span>
                  {item.name} · Pixel v{item.version}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    setQueue((items) =>
                      items.filter(
                        (entry) => entry.deliverableId !== item.deliverableId,
                      ),
                    )
                  }
                >
                  Remove {item.name}
                </Button>
              </li>
            ))}
          </ul>
          <Confirmation
            title="Approve selected videos?"
            disabled={busy}
            run={submitBulk}
            description={
              <>
                <p>Each video is checked and recorded independently.</p>
                <ul className="mt-2 space-y-1">
                  {queue.map((item) => (
                    <li key={item.deliverableId}>
                      {item.name} · Pixel v{item.version}
                    </li>
                  ))}
                </ul>
              </>
            }
          >
            Review bulk approval
          </Confirmation>
        </section>
      )}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(15rem,1fr)_minmax(0,3fr)]">
        <section className={panel} aria-label="Candidates">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Candidates</h2>
            <Button variant="ghost" size="sm" onClick={reload} disabled={busy}>
              Refresh
            </Button>
          </div>
          <form className="space-y-3" onSubmit={filter}>
            <label className={labelClass}>
              Ticket or product <Input name="search" maxLength={120} />
            </label>
            <label className={labelClass}>
              Status
              <select name="status" className={control}>
                <option value="">All statuses</option>
                <option value="pending">Pending approval</option>
                <option value="approved">Approved</option>
                <option value="revision_requested">Revision requested</option>
                <option value="rejected">Rejected</option>
                <option value="withdrawn">Withdrawn</option>
                <option value="needs_owner_input">Needs owner input</option>
                <option value="failed">Failed QA</option>
                <option value="historical">Archived or superseded</option>
              </select>
            </label>
            <label className={labelClass}>
              Platform
              <select name="platform" className={control}>
                <option value="">All platforms</option>
                {TICKET_PLATFORMS.map((platform) => (
                  <option key={platform} value={platform}>
                    {PLATFORM_LABEL[platform]}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" variant="secondary">
              Apply filters
            </Button>
          </form>
          <CandidateList
            key={query}
            query={query}
            refresh={refresh}
            selected={id}
            select={setId}
            offset={offset}
            paginate={setOffset}
          />
        </section>
        {id && (
          <Review
            key={`${id}:${refresh}`}
            id={id}
            add={add}
            busy={busy}
            setBusy={setBusy}
            message={setMessage}
            canQueue={
              queue.length < 10 ||
              queue.some((item) => item.deliverableId === id)
            }
            recorded={() => {
              setQueue((items) =>
                items.filter((item) => item.deliverableId !== id),
              )
              reload()
            }}
          />
        )}
      </div>
    </div>
  )
}

function CandidateList({
  query,
  refresh,
  selected,
  select,
  offset,
  paginate,
}: {
  query: string
  refresh: number
  selected: string
  select: (id: string) => void
  offset: number
  paginate: (offset: number) => void
}) {
  const result = useApprovalQuery<InboxPage>(`?${query}`, refresh)
  if (result?.error) return <p role="alert">{result.error}</p>
  if (!result?.data) return <p role="status">Loading candidates…</p>
  const { items, hasMore } = result.data
  return (
    <>
      {items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No videos match these filters.
        </p>
      )}
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              aria-pressed={selected === item.id}
              onClick={() => select(item.id)}
              className="grid w-full gap-1 rounded-lg border p-3 text-left text-sm wrap-anywhere hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring aria-pressed:border-primary aria-pressed:bg-muted"
            >
              <strong>
                {formatTicketNumber(item.ticket_number)} · {item.product_name}
              </strong>
              <span>
                {PLATFORM_LABEL[item.platform as keyof typeof PLATFORM_LABEL]} ·{" "}
                {item.historical ? "Historical" : "Latest video"}
              </span>
              <span>
                Pixel v{item.deliverable_version} · Quill v{item.script_version}
                {item.review_version ? ` · Vera v${item.review_version}` : ""}
              </span>
              <span>
                {item.verdict
                  ? VERDICT_LABEL[item.verdict]
                  : "Awaiting Vera QA"}
              </span>
              <span>
                {DECISION_LABEL[item.decision]}
                {item.decision === "approved" &&
                (!item.same_review || item.historical)
                  ? " · No longer current"
                  : ""}
              </span>
              <time
                className="text-muted-foreground"
                dateTime={item.updated_at}
              >
                {item.updated_at.slice(0, 16).replace("T", " ")} UTC
              </time>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!offset}
          onClick={() => paginate(offset - 20)}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          disabled={!hasMore || offset >= 10000}
          onClick={() => paginate(offset + 20)}
        >
          Next
        </Button>
      </div>
    </>
  )
}

function Review({
  id,
  ...actions
}: {
  id: string
  add: (item: Queued) => void
  canQueue: boolean
  busy: boolean
  setBusy: (value: boolean) => void
  message: (value: string) => void
  recorded: () => void
}) {
  const result = useApprovalQuery<Detail>(`/${id}`, 0)
  const [videoError, setVideoError] = useState(false)
  if (result?.error) return <p role="alert">{result.error}</p>
  if (!result?.data) return <p role="status">Loading review…</p>
  const detail = result.data
  const { candidate, decision, eligibility, review, script, sources } = detail
  const { ticket, product } = candidate.snapshot
  const file = `/api/tickets/${candidate.ticketId}/videos/${id}/file`
  const affiliate = safeExternalUrl(product.affiliateUrl)
  return (
    <article
      className="grid min-w-0 items-start gap-4 xl:grid-cols-2"
      aria-label="Selected video review"
    >
      <div className={panel}>
        <h2 className="text-xl font-semibold wrap-anywhere">{product.name}</h2>
        <p className="text-sm wrap-anywhere">
          {formatTicketNumber(candidate.ticketNumber)} · {ticket.title} · Pixel
          v{candidate.version}
        </p>
        <video
          aria-label={`${product.name} video preview`}
          className="mx-auto max-h-[60dvh] w-full rounded-lg bg-black"
          controls
          playsInline
          preload="metadata"
          src={file}
          onError={() => setVideoError(true)}
        />
        {videoError && (
          <p role="status">
            Preview failed. Download the MP4 and open it in a compatible player.
          </p>
        )}
        <a
          className="font-medium text-primary underline"
          href={`${file}?download=1`}
        >
          Download MP4
        </a>
        <details open className="space-y-2">
          <summary className="cursor-pointer font-medium">
            Product and campaign
          </summary>
          <p className="wrap-anywhere">{product.description}</p>
          <p className="wrap-anywhere">{ticket.instructions}</p>
          <dl className="space-y-1 text-sm">
            <dt className="font-medium">Pinned affiliate URL</dt>
            <dd className="wrap-anywhere">
              {affiliate ? (
                <a
                  className="text-primary underline"
                  href={affiliate}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                >
                  {product.affiliateUrl}
                </a>
              ) : (
                product.affiliateUrl
              )}
            </dd>
            <dt className="font-medium">Media rights</dt>
            <dd className="wrap-anywhere">
              {product.mediaRights.replaceAll("_", " ")} ·{" "}
              {product.mediaRightsNote || "No supporting note"}
            </dd>
            <dt className="font-medium">Disclosure</dt>
            <dd>
              {script?.disclosure.text ?? "Unavailable"}
              {script && " · Every scene"}
            </dd>
          </dl>
        </details>
        <details className="space-y-2">
          <summary className="cursor-pointer font-medium">
            Quill script v{candidate.scriptVersion}
          </summary>
          {script ? (
            <ol className="space-y-2">
              {script.scenes.map((scene) => (
                <li
                  key={scene.id}
                  className="rounded-lg border p-3 text-sm wrap-anywhere"
                >
                  <strong>
                    {scene.id} · {scene.kind}
                  </strong>
                  <p>Caption — {scene.caption}</p>
                  {scene.subtext && <p>{scene.subtext}</p>}
                  <p>Narration — {scene.narration}</p>
                  <p>Visual — {scene.visual}</p>
                  {scene.claims?.map((claim) => (
                    <div key={claim.claimKey} className="mt-2 border-t pt-2">
                      <p>{claim.statement}</p>
                      <ul className="flex flex-wrap gap-2">
                        {claim.evidence.map((evidence) => {
                          const href = safeExternalUrl(evidence.sourceUrl)
                          return (
                            href && (
                              <li key={evidence.key}>
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer nofollow"
                                  className="text-primary underline"
                                >
                                  Evidence {evidence.key}
                                </a>
                              </li>
                            )
                          )
                        })}
                      </ul>
                    </div>
                  ))}
                </li>
              ))}
            </ol>
          ) : (
            <p>Script integrity could not be verified.</p>
          )}
        </details>
        <details className="space-y-2">
          <summary className="cursor-pointer font-medium">
            Scout sources
          </summary>
          <ul className="space-y-1 text-sm wrap-anywhere">
            {sources.map((source) => {
              const href = safeExternalUrl(
                source.finalUrl ?? source.requestedUrl,
              )
              const title = source.title ?? source.label ?? source.requestedUrl
              return (
                <li key={source.key}>
                  {href ? (
                    <a
                      href={href}
                      className="text-primary underline"
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                    >
                      {title}
                    </a>
                  ) : (
                    title
                  )}
                </li>
              )
            })}
          </ul>
        </details>
      </div>
      <div className={panel}>
        <h2 className="font-semibold">Vera assessment</h2>
        <p>
          {review
            ? `v${review.version} · ${VERDICT_LABEL[review.document.verdict]}`
            : "Awaiting Vera QA"}
        </p>
        {review && (
          <details className="space-y-2">
            <summary className="cursor-pointer">
              Findings ({review.document.findings.length})
            </summary>
            <ul className="space-y-2 text-sm">
              {review.document.findings.map((finding, index) => (
                <li
                  className="rounded-lg border p-2 wrap-anywhere"
                  key={`${finding.ruleId}:${index}`}
                >
                  <strong>
                    {finding.category.replaceAll("_", " ")} ·{" "}
                    {finding.outcome.replaceAll("_", " ")}
                  </strong>
                  <p>
                    {finding.sceneId && `${finding.sceneId} · `}
                    {finding.expected}
                  </p>
                  {finding.remediation && <p>{finding.remediation}</p>}
                  <details className="mt-1">
                    <summary className="cursor-pointer">
                      Observed evidence
                    </summary>
                    <pre className="mt-1 max-h-48 overflow-y-auto text-xs wrap-anywhere whitespace-pre-wrap">
                      {JSON.stringify(finding.observed, null, 2)}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
          </details>
        )}
        <p className="font-medium">
          {decision ? DECISION_LABEL[decision.kind] : "Pending"}
          {decision?.kind === "approved" &&
            !eligibility.eligible &&
            " · No longer current"}
        </p>
        {eligibility.historical && (
          <p className="text-sm text-muted-foreground">
            Historical video version
          </p>
        )}
        <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
          {eligibility.requiredOwnerActions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ul>
        {review && <DecisionForm detail={detail} {...actions} />}
        <History id={id} />
      </div>
    </article>
  )
}

function History({ id }: { id: string }) {
  const [offset, setOffset] = useState(0)
  return (
    <details className="space-y-2">
      <summary className="cursor-pointer font-semibold">
        Decision history
      </summary>
      <HistoryPage key={offset} id={id} offset={offset} paginate={setOffset} />
    </details>
  )
}

function HistoryPage({
  id,
  offset,
  paginate,
}: {
  id: string
  offset: number
  paginate: (value: number) => void
}) {
  const result = useApprovalQuery<{ items: Event[]; hasMore: boolean }>(
    `/${id}/history?offset=${offset}`,
    0,
  )
  if (result?.error) return <p role="alert">{result.error}</p>
  if (!result?.data) return <p role="status">Loading history…</p>
  return (
    <>
      {!result.data.items.length && (
        <p className="text-sm">No decisions recorded.</p>
      )}
      <ol className="space-y-2 text-sm">
        {result.data.items.map((event) => (
          <li
            key={event.id}
            className="space-y-1 rounded-lg border p-2 wrap-anywhere"
          >
            <strong>{DECISION_LABEL[event.kind]}</strong>
            <p>
              Pixel v{event.deliverable_version} · Vera v{event.review_version}
            </p>
            <time dateTime={event.created_at}>
              {new Date(event.created_at).toLocaleString()}
            </time>
            {event.reason && <p>{event.reason}</p>}
            {event.notes && <p>{event.notes}</p>}
            {event.revision && (
              <p>
                {event.revision.categories.join(", ")} ·{" "}
                {event.revision.correction} {event.revision.sceneIds.join(", ")}
              </p>
            )}
            {hasChecklist(event.checklist) && (
              <details>
                <summary>Confirmed checklist</summary>
                <ul>
                  {Object.values(CHECKLIST).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!offset}
          onClick={() => paginate(offset - 20)}
        >
          Earlier page
        </Button>
        <Button
          variant="outline"
          disabled={!result.data.hasMore || offset >= 10000}
          onClick={() => paginate(offset + 20)}
        >
          Older events
        </Button>
      </div>
    </>
  )
}

function DecisionForm({
  detail,
  add,
  busy,
  setBusy,
  message,
  recorded,
  canQueue,
}: {
  detail: Detail
  add: (item: Queued) => void
  busy: boolean
  canQueue: boolean
  setBusy: (value: boolean) => void
  message: (value: string) => void
  recorded: () => void
}) {
  const [checks, setChecks] = useState<Partial<Record<ChecklistKey, boolean>>>(
    {},
  )
  const [kind, setKind] = useState<DecisionKind | "">("")
  const [notes, setNotes] = useState("")
  const [reason, setReason] = useState("")
  const [categories, setCategories] = useState<string[]>([])
  const [scenes, setScenes] = useState<string[]>([])
  const [correction, setCorrection] = useState("")
  const [attempt, setAttempt] = useState<{
    key: string
    input: DecisionInput
  }>()
  const { review, decision, eligibility, candidate } = detail
  if (!review) return null
  const options = (
    Object.keys(DECISION_LABEL) as (DecisionKind | "pending")[]
  ).filter(
    (value): value is DecisionKind =>
      value !== "pending" &&
      (value === "approved"
        ? eligibility.canApprove
        : decisionTransition(
            decision?.kind ?? null,
            value,
            decision?.review_id === review.id,
          )),
  )
  if (!options.length) return null

  function buildInput() {
    if (!kind || !review) return
    const data = {
      expectedDecisionId: decision?.id ?? null,
      reviewId:
        kind === "withdrawn" && decision ? decision.review_id : review.id,
      kind,
      notes,
      reason: kind === "approved" ? "" : reason,
      checklist: kind === "approved" && hasChecklist(checks) ? checks : null,
      revision:
        kind === "revision_requested"
          ? { categories, sceneIds: scenes, correction }
          : null,
    }
    const key = JSON.stringify(data)
    if (attempt?.key === key) return attempt.input
    const input = { ...data, requestId: crypto.randomUUID() }
    setAttempt({ key, input })
    return input
  }

  async function submit() {
    const input = buildInput()
    if (!input) return
    setBusy(true)
    try {
      await api(`/${candidate.id}/decisions`, undefined, input)
      message(DECISION_LABEL[input.kind])
      recorded()
    } catch (error) {
      message(error instanceof Error ? error.message : "Decision failed.")
    } finally {
      setBusy(false)
    }
  }

  function queue() {
    const input = buildInput()
    if (input)
      add({
        deliverableId: candidate.id,
        name: candidate.snapshot.product.name,
        version: candidate.version,
        decision: input,
      })
  }

  const invalid =
    !kind ||
    (kind === "approved" ? !hasChecklist(checks) : !reason.trim()) ||
    (kind === "revision_requested" &&
      (!categories.length || !correction.trim()))
  return (
    <section aria-label="Record a decision" className="space-y-3 border-t pt-4">
      <label className={labelClass}>
        Decision
        <select
          value={kind}
          className={control}
          onChange={(e) => {
            setKind(e.target.value as typeof kind)
            setChecks({})
          }}
        >
          <option value="">Select a decision</option>
          {options.map((value) => (
            <option key={value} value={value}>
              {value === "approved" ? "Approve" : DECISION_LABEL[value]}
            </option>
          ))}
        </select>
      </label>
      {kind === "approved" && (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-semibold">
            Human checklist
          </legend>
          {(Object.keys(CHECKLIST) as ChecklistKey[]).map((key) => (
            <label key={key} className="flex items-start gap-2 text-sm">
              <input
                className="mt-1 size-4 shrink-0 accent-primary"
                type="checkbox"
                checked={Boolean(checks[key])}
                onChange={(e) =>
                  setChecks({ ...checks, [key]: e.target.checked })
                }
              />
              {CHECKLIST[key]}
            </label>
          ))}
        </fieldset>
      )}
      {kind && kind !== "approved" && (
        <label className={labelClass}>
          Reason
          <textarea
            className={control}
            value={reason}
            maxLength={2000}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      )}
      {kind === "revision_requested" && (
        <Fragment>
          <fieldset className="space-y-1 text-sm">
            <legend className="font-medium">Revision categories</legend>
            {REVISION_CATEGORIES.map((category) => (
              <label key={category} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={categories.includes(category)}
                  onChange={(e) =>
                    setCategories((values) =>
                      e.target.checked
                        ? [...values, category]
                        : values.filter((item) => item !== category),
                    )
                  }
                />
                {category}
              </label>
            ))}
          </fieldset>
          {!!detail.script?.scenes.length && (
            <fieldset className="space-y-1 text-sm">
              <legend>Affected scenes (optional)</legend>
              {detail.script.scenes.map((scene) => (
                <label key={scene.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={scenes.includes(scene.id)}
                    onChange={(e) =>
                      setScenes((values) =>
                        e.target.checked
                          ? [...values, scene.id]
                          : values.filter((item) => item !== scene.id),
                      )
                    }
                  />
                  {scene.id}
                </label>
              ))}
            </fieldset>
          )}
          <label className={labelClass}>
            Expected correction
            <textarea
              className={control}
              value={correction}
              maxLength={2000}
              onChange={(e) => setCorrection(e.target.value)}
            />
          </label>
        </Fragment>
      )}
      {kind && (
        <label className={labelClass}>
          Owner notes (optional)
          <textarea
            className={control}
            value={notes}
            maxLength={2000}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
      )}
      {kind && (
        <div className="flex flex-wrap gap-2">
          <Confirmation
            title="Record this decision?"
            disabled={busy || invalid}
            run={submit}
            description={`${kind === "approved" ? "Approve" : DECISION_LABEL[kind]} · ${candidate.snapshot.product.name} · Pixel v${candidate.version}.`}
          >
            Review decision
          </Confirmation>
          {kind === "approved" && (
            <Button
              variant="secondary"
              disabled={busy || invalid || !canQueue}
              onClick={queue}
            >
              Add to bulk review
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
