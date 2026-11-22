"use client"

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  CircleCheck,
  CircleDashed,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Undo2,
} from "lucide-react"

import {
  FormMessage,
  formatDate,
  PriorityLabel,
  StatusBadge,
} from "@/components/tickets/fields"
import { ProductEditor } from "@/components/tickets/product-editor"
import { QuillSection } from "@/components/tickets/quill-section"
import { ResearchSection } from "@/components/tickets/research-section"
import { WorkflowSection } from "@/components/tickets/workflow-section"
import {
  draftFromTicket,
  fieldsFromDraft,
  TicketFields,
  type TicketDraft,
} from "@/components/tickets/ticket-form"
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
import { api, issuesByPath, newRequestId } from "@/lib/tickets/client"
import {
  PLATFORM_LABEL,
  ticketEndpoint,
  type ApiError,
  type TicketDetail,
  type TicketEvent,
  type TicketStatus,
} from "@/lib/tickets/types"
import { readinessIssues, validateTicketPatch } from "@/lib/tickets/validation"

type Load =
  | { kind: "loading" }
  | { kind: "loaded"; ticket: TicketDetail; events: TicketEvent[] }
  | { kind: "error"; error: ApiError; status: number }

/** /tickets/[ticketId]: everything about one Affiliate Ticket, saved to PostgreSQL. */
export function TicketWorkspace({ ticketId }: { ticketId: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" })
  const [actionError, setActionError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState<null | TicketStatus | "details" | "add">(
    null,
  )
  const [details, setDetails] = useState<TicketDraft | null>(null)
  const [savedDetails, setSavedDetails] = useState<TicketDraft | null>(null)
  const [detailsError, setDetailsError] = useState<ApiError | null>(null)
  const [dirtyProducts, setDirtyProducts] = useState<Set<string>>(new Set())
  const [openProduct, setOpenProduct] = useState<string | null>(null)
  const addRequest = useRef<string | null>(null)
  /** Bumped by "Try again" to repeat the first load. */
  const [attempt, setAttempt] = useState(0)

  const fetchTicket = useCallback(async () => {
    const result = await api<{ ticket: TicketDetail; events: TicketEvent[] }>(
      ticketEndpoint(ticketId),
    )
    if (!result.ok) {
      setLoad((current) =>
        current.kind === "loaded"
          ? current // keep showing what we have; report the failure instead
          : { kind: "error", error: result.error, status: result.status },
      )
      if (result.status !== 404) setActionError(result.error)
      return null
    }
    setLoad({ kind: "loaded", ...result.data })
    return result.data.ticket
  }, [ticketId])

  // First load: state is only set in the async callback.
  useEffect(() => {
    let cancelled = false
    void api<{ ticket: TicketDetail; events: TicketEvent[] }>(
      ticketEndpoint(ticketId),
    ).then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setLoad({ kind: "error", error: result.error, status: result.status })
        return
      }
      const { ticket } = result.data
      setLoad({ kind: "loaded", ...result.data })
      setDetails(draftFromTicket(ticket))
      setSavedDetails(draftFromTicket(ticket))
      if (ticket.products.length === 1) setOpenProduct(ticket.products[0].id)
    })
    return () => {
      cancelled = true
    }
  }, [ticketId, attempt])

  const reload = useCallback(async () => {
    await fetchTicket()
  }, [fetchTicket])

  /** A mutation returned the whole ticket: show it, and refresh the history. */
  const applyTicket = useCallback(
    (ticket: TicketDetail) => {
      setLoad((current) =>
        current.kind === "loaded" ? { ...current, ticket } : current,
      )
      setActionError(null)
      void fetchTicket()
    },
    [fetchTicket],
  )

  const onDirty = useCallback((productId: string, dirty: boolean) => {
    setDirtyProducts((set) => {
      if (set.has(productId) === dirty) return set
      const next = new Set(set)
      if (dirty) next.add(productId)
      else next.delete(productId)
      return next
    })
  }, [])

  const detailsDirty =
    details !== null &&
    savedDetails !== null &&
    JSON.stringify(details) !== JSON.stringify(savedDetails)
  const anyDirty = detailsDirty || dirtyProducts.size > 0

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!anyDirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [anyDirty])

  if (load.kind === "loading")
    return (
      <p
        role="status"
        className="flex items-center gap-2 py-10 text-sm text-muted-foreground"
      >
        <LoaderCircle
          aria-hidden="true"
          className="size-4 animate-spin motion-reduce:animate-none"
        />
        Loading the Affiliate Ticket…
      </p>
    )
  if (load.kind === "error")
    return (
      <div className="flex max-w-2xl flex-col gap-4 py-6">
        <FormMessage>
          <p className="font-semibold">
            {load.status === 404
              ? "This Affiliate Ticket doesn't exist."
              : "Couldn't open this Affiliate Ticket."}
          </p>
          <p className="mt-1">{load.error.message}</p>
        </FormMessage>
        <div className="flex gap-2">
          {load.status !== 404 ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setLoad({ kind: "loading" })
                setAttempt((n) => n + 1)
              }}
            >
              <RefreshCw aria-hidden="true" />
              Try again
            </Button>
          ) : null}
          <Button asChild variant="ghost">
            <Link href="/tickets">
              <ArrowLeft aria-hidden="true" />
              All tickets
            </Link>
          </Button>
        </div>
      </div>
    )

  const { ticket, events } = load
  const archived = ticket.status === "archived"
  const readiness = readinessIssues({
    title: ticket.title,
    products: ticket.products,
  })

  async function setStatus(status: TicketStatus) {
    setBusy(status)
    setActionError(null)
    const result = await api<{ ticket: TicketDetail }>(
      ticketEndpoint(ticketId),
      {
        method: "PATCH",
        body: { version: ticket.version, status },
      },
    )
    setBusy(null)
    if (result.ok) applyTicket(result.data.ticket)
    else setActionError(result.error)
  }

  async function saveDetails() {
    if (!details) return
    const local = validateTicketPatch(fieldsFromDraft(details))
    if (!local.ok) {
      setDetailsError({
        error: "invalid",
        message: "Some fields need attention.",
        issues: local.issues,
      })
      return
    }
    setBusy("details")
    setDetailsError(null)
    const result = await api<{ ticket: TicketDetail }>(
      ticketEndpoint(ticketId),
      {
        method: "PATCH",
        body: { version: ticket.version, fields: fieldsFromDraft(details) },
      },
    )
    setBusy(null)
    if (!result.ok) {
      setDetailsError(result.error) // keep the edits
      return
    }
    setDetails(draftFromTicket(result.data.ticket))
    setSavedDetails(draftFromTicket(result.data.ticket))
    applyTicket(result.data.ticket)
  }

  async function addProduct() {
    setBusy("add")
    setActionError(null)
    // Reused if this click is retried, so a slow response can't add two.
    addRequest.current ??= newRequestId()
    const result = await api<{ ticket: TicketDetail; productId: string }>(
      `${ticketEndpoint(ticketId)}/products`,
      {
        method: "POST",
        body: { requestId: addRequest.current },
      },
    )
    setBusy(null)
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    addRequest.current = null
    setOpenProduct(result.data.productId)
    applyTicket(result.data.ticket)
  }

  const productName = (id: string | null) => {
    const product = ticket.products.find((p) => p.id === id)
    return product
      ? product.name || `product #${product.position + 1}`
      : "a removed product"
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4">
        <Link
          href="/tickets"
          className="flex w-fit items-center gap-1 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          All Affiliate Tickets
        </Link>
        <div className="flex flex-col gap-2">
          <p className="flex flex-wrap items-center gap-2 font-mono text-sm text-muted-foreground">
            {ticket.displayNumber}
            <StatusBadge status={ticket.status} />
          </p>
          <h1 className="text-headline break-words">{ticket.title}</h1>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>{PLATFORM_LABEL[ticket.platform]}</span>
            <span>
              Priority: <PriorityLabel priority={ticket.priority} />
            </span>
            <span>
              {ticket.products.length}{" "}
              {ticket.products.length === 1 ? "product" : "products"}
            </span>
            <span>Created {formatDate(ticket.createdAt)}</span>
            <span>Updated {formatDate(ticket.updatedAt)}</span>
          </p>
        </div>

        <div
          className="flex flex-wrap gap-2"
          aria-label="Ticket actions"
          role="group"
        >
          {ticket.status === "draft" ? (
            <Button
              type="button"
              onClick={() => void setStatus("ready")}
              disabled={busy !== null || anyDirty || readiness.length > 0}
              aria-describedby="ready-help"
            >
              {busy === "ready" ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="animate-spin motion-reduce:animate-none"
                />
              ) : (
                <CircleCheck aria-hidden="true" />
              )}
              Mark Ready
            </Button>
          ) : null}
          {ticket.status === "ready" ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void setStatus("draft")}
              disabled={busy !== null}
            >
              <Undo2 aria-hidden="true" />
              Return to Draft
            </Button>
          ) : null}
          {!archived ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy !== null}
                >
                  <Archive aria-hidden="true" />
                  Archive
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Archive {ticket.displayNumber}?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    It leaves the active list and becomes read-only. Nothing is
                    deleted; you can restore it to Draft at any time.
                    {anyDirty
                      ? " Unsaved changes on this page won't be saved."
                      : ""}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void setStatus("archived")}>
                    Archive ticket
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <Button
              type="button"
              onClick={() => void setStatus("draft")}
              disabled={busy !== null}
            >
              <ArchiveRestore aria-hidden="true" />
              Restore to Draft
            </Button>
          )}
        </div>
        <p id="ready-help" className="text-sm text-muted-foreground">
          {archived
            ? "Archived: read-only. Restore it to make changes."
            : ticket.status === "ready"
              ? "Ready means eligible for future processing. Nothing runs yet, and any change returns it to Draft."
              : anyDirty
                ? "Save your changes before marking the ticket Ready."
                : readiness.length > 0
                  ? `To mark it Ready: ${readiness.map((i) => i.message).join(" ")}`
                  : "Ready to mark Ready. Nothing will start processing yet."}
        </p>
        {actionError ? (
          <FormMessage>
            <p className="font-semibold">That didn&apos;t work.</p>
            <p className="mt-1">{actionError.message}</p>
            {actionError.issues?.length ? (
              <ul className="mt-1 list-disc pl-5">
                {actionError.issues.map((issue) => (
                  <li key={issue.path}>{issue.message}</li>
                ))}
              </ul>
            ) : null}
            {actionError.error === "conflict" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void reload()}
              >
                <RefreshCw aria-hidden="true" />
                Reload ticket
              </Button>
            ) : null}
          </FormMessage>
        ) : null}
      </header>

      <section
        aria-labelledby="details-title"
        className="flex max-w-3xl flex-col gap-4"
      >
        <h2 id="details-title" className="text-title">
          Ticket details
        </h2>
        {details ? (
          <TicketFields
            idPrefix="ticket"
            draft={details}
            onChange={setDetails}
            errors={issuesByPath(detailsError)}
            disabled={archived || busy === "details"}
          />
        ) : null}
        {detailsError ? (
          <FormMessage>
            <p className="font-semibold">The details weren&apos;t saved.</p>
            <p className="mt-1">
              {detailsError.issues?.length
                ? "Fix the highlighted fields, then save again."
                : detailsError.message}
            </p>
          </FormMessage>
        ) : null}
        {!archived ? (
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={() => void saveDetails()}
              disabled={!detailsDirty || busy !== null}
            >
              {busy === "details" ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="animate-spin motion-reduce:animate-none"
                />
              ) : (
                <Save aria-hidden="true" />
              )}
              Save details
            </Button>
            {detailsDirty ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setDetails(savedDetails)
                  setDetailsError(null)
                }}
              >
                Discard changes
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="products-title" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="products-title" className="text-title">
            Products{" "}
            <span className="text-muted-foreground">
              ({ticket.products.length})
            </span>
          </h2>
          {!archived ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void addProduct()}
              disabled={busy !== null}
            >
              {busy === "add" ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="animate-spin motion-reduce:animate-none"
                />
              ) : (
                <Plus aria-hidden="true" />
              )}
              Add product
            </Button>
          ) : null}
        </div>
        <ReadinessChecklist ticket={ticket} />
        {ticket.products.length === 0 ? (
          <p className="rounded-xl bg-surface-sunken p-5 text-sm ring-1 ring-border">
            No products yet. Add one for each item you want a video for.
          </p>
        ) : (
          <ol aria-label="Products" className="flex flex-col gap-3">
            {ticket.products.map((product, index) => (
              <li key={product.id}>
                <ProductEditor
                  ticketId={ticket.id}
                  product={product}
                  index={index}
                  total={ticket.products.length}
                  readOnly={archived}
                  defaultOpen={openProduct === product.id}
                  onTicket={applyTicket}
                  onReload={reload}
                  onDirty={onDirty}
                />
              </li>
            ))}
          </ol>
        )}
      </section>

      <WorkflowSection ticket={ticket} />

      <ResearchSection ticket={ticket} />

      <QuillSection ticket={ticket} />

      <section
        aria-labelledby="activity-title"
        className="flex max-w-3xl flex-col gap-3"
      >
        <h2 id="activity-title" className="text-title">
          Activity
        </h2>
        <p className="text-sm text-muted-foreground">
          Every saved change, newest first. Only real changes appear here.
        </p>
        <ol
          aria-label="Activity history"
          className="flex flex-col divide-y divide-border rounded-xl ring-1 ring-border"
        >
          {events.map((event) => (
            <li
              key={event.id}
              className="flex flex-col gap-0.5 px-4 py-2.5 text-sm sm:flex-row sm:justify-between sm:gap-4"
            >
              <span>{describe(event, productName)}</span>
              <time
                dateTime={event.createdAt}
                className="shrink-0 text-muted-foreground"
              >
                {formatDate(event.createdAt)}
              </time>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

function ReadinessChecklist({ ticket }: { ticket: TicketDetail }) {
  const products = ticket.products
  const linked = products.filter(
    (p) =>
      p.name.trim() &&
      readinessIssues({ title: ticket.title, products: [p] }).length === 0,
  ).length
  const withImages = products.filter(
    (p) => p.assets.filter((a) => a.kind === "image").length >= 3,
  ).length
  const items = [
    {
      ok: products.length > 0,
      text: `${products.length} ${products.length === 1 ? "product" : "products"} added`,
    },
    {
      ok: linked > 0,
      text: `${linked} with a name and a valid affiliate link (at least 1 needed for Ready)`,
    },
    {
      ok: products.length > 0 && withImages === products.length,
      text: `${withImages} of ${products.length} with 3+ images (Pixel will need these later; not required for Ready)`,
      optional: true,
    },
  ]
  return (
    <ul aria-label="Readiness" className="flex flex-col gap-1 text-sm">
      {items.map((item) => (
        <li key={item.text} className="flex items-start gap-2">
          {item.ok ? (
            <CircleCheck
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-status-completed"
            />
          ) : (
            <CircleDashed
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
          )}
          <span>
            <span className="sr-only">
              {item.ok
                ? "Done: "
                : item.optional
                  ? "Optional, not yet: "
                  : "Not yet: "}
            </span>
            {item.text}
          </span>
        </li>
      ))}
    </ul>
  )
}

const FIELD_NAMES: Record<string, string> = {
  title: "title",
  description: "description",
  instructions: "instructions",
  priority: "priority",
  platform: "platform",
  publishingPreferences: "publishing preferences",
  name: "name",
  affiliateUrl: "affiliate link",
  specifications: "specifications",
  notes: "notes",
  source: "source",
  mediaRights: "media rights",
  mediaRightsNote: "rights note",
  references: "reference links",
}

function fieldList(details: Record<string, unknown>) {
  const fields = Array.isArray(details.fields)
    ? (details.fields as string[])
    : []
  return fields.map((f) => FIELD_NAMES[f] ?? f).join(", ")
}

function describe(
  event: TicketEvent,
  productName: (id: string | null) => string,
) {
  const d = event.details
  switch (event.type) {
    case "ticket_created":
      return "Ticket created as a Draft"
    case "ticket_edited":
      return `Ticket details edited: ${fieldList(d)}`
    case "product_added":
      return `Product added (#${String(d.position)})`
    case "product_updated":
      return `${capitalize(productName(event.productId))} updated: ${fieldList(d)}`
    case "product_moved":
      return `${capitalize(productName(event.productId))} moved from #${String(d.from)} to #${String(d.to)}`
    case "product_removed":
      return `A product was removed${Number(d.assets) > 0 ? `, with ${String(d.assets)} media ${Number(d.assets) === 1 ? "file" : "files"}` : ""}`
    case "asset_uploaded":
      return `${d.kind === "video" ? "Video clip" : "Image"} uploaded to ${productName(event.productId)}`
    case "asset_removed":
      return `${d.kind === "video" ? "Video clip" : "Image"} removed from ${productName(event.productId)}`
    case "marked_ready":
      return "Marked Ready"
    case "returned_to_draft":
      return d.reason === "edited"
        ? "Returned to Draft because its content changed"
        : "Returned to Draft"
    case "archived":
      return "Archived"
    case "restored":
      return "Restored to Draft"
  }
}

const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1)
