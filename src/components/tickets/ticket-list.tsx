"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import {
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react"

import {
  FormMessage,
  formatDate,
  PriorityLabel,
  StatusBadge,
} from "@/components/tickets/fields"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api } from "@/lib/tickets/client"
import {
  PLATFORM_LABEL,
  TICKETS_ENDPOINT,
  type ApiError,
  type TicketList as TicketListData,
} from "@/lib/tickets/types"

type Filter = "active" | "draft" | "ready" | "archived" | "all"

const FILTERS: Record<Filter, string> = {
  active: "Active",
  draft: "Draft",
  ready: "Ready",
  archived: "Archived",
  all: "All",
}

type View =
  | { kind: "loading" }
  | { kind: "loaded"; data: TicketListData }
  | { kind: "error"; error: ApiError; status: number }

const PAGE_SIZE = 20

/**
 * /tickets: every Affiliate Ticket, newest change first. Reads from the
 * server on each change of search, filter or page; nothing is cached in
 * the browser.
 */
export function TicketList() {
  const [filter, setFilter] = useState<Filter>("active")
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)
  const [view, setView] = useState<View>({ kind: "loading" })
  const latest = useRef(0)

  // Debounced search: wait for a pause in typing.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim())
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  const [attempt, setAttempt] = useState(0)

  // Reload whenever the filter, search or page changes. State is only set
  // in the async callback; a newer request supersedes an older one.
  useEffect(() => {
    const id = ++latest.current
    const params = new URLSearchParams({
      status: filter,
      page: String(page),
      pageSize: String(PAGE_SIZE),
    })
    if (query) params.set("q", query)
    void api<TicketListData>(`${TICKETS_ENDPOINT}?${params}`).then((result) => {
      if (id !== latest.current) return
      setView(
        result.ok
          ? { kind: "loaded", data: result.data }
          : { kind: "error", error: result.error, status: result.status },
      )
    })
  }, [filter, page, query, attempt])

  const data = view.kind === "loaded" ? view.data : null
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex min-w-0 flex-col gap-1.5 sm:w-72">
            <Label htmlFor="ticket-search">Search tickets</Label>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="ticket-search"
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Title or AFT-0001"
                className="pl-8"
                autoComplete="off"
              />
            </div>
          </div>
          <fieldset className="flex min-w-0 flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Status</legend>
            <div
              className="flex flex-wrap gap-1"
              role="radiogroup"
              aria-label="Status"
            >
              {(Object.keys(FILTERS) as Filter[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={filter === key}
                  onClick={() => {
                    setFilter(key)
                    setPage(1)
                  }}
                  className="h-7 rounded-md px-2.5 text-sm ring-1 ring-border transition-colors outline-none ring-inset hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-checked:bg-primary aria-checked:text-primary-foreground aria-checked:ring-primary"
                >
                  {FILTERS[key]}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
        <Button asChild size="lg" className="w-fit">
          <Link href="/tickets/new">
            <Plus aria-hidden="true" />
            Create Affiliate Ticket
          </Link>
        </Button>
      </div>

      <div aria-live="polite" aria-busy={view.kind === "loading"}>
        {view.kind === "loading" ? (
          <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <LoaderCircle
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
            Loading Affiliate Tickets…
          </p>
        ) : view.kind === "error" ? (
          <FormMessage>
            <p className="font-semibold">
              {view.status === 503
                ? "Affiliate Tickets are unavailable right now."
                : "Couldn't load Affiliate Tickets."}
            </p>
            <p className="mt-1">{view.error.message}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => {
                setView({ kind: "loading" })
                setAttempt((n) => n + 1)
              }}
            >
              <RefreshCw aria-hidden="true" />
              Try again
            </Button>
          </FormMessage>
        ) : data && data.tickets.length === 0 ? (
          <div className="rounded-xl bg-surface-sunken p-6 text-sm ring-1 ring-border">
            <p className="font-semibold">
              {query || filter !== "active"
                ? "No tickets match."
                : "No active Affiliate Tickets."}
            </p>
            <p className="mt-1 text-muted-foreground">
              {query || filter !== "active"
                ? "Try another search or status."
                : "Create one to collect products, affiliate links and media in one place. Archived tickets are under Archived."}
            </p>
          </div>
        ) : data ? (
          <>
            <p className="mb-2 text-sm text-muted-foreground">
              {data.total} {data.total === 1 ? "ticket" : "tickets"}
            </p>
            <ul aria-label="Affiliate Tickets" className="flex flex-col gap-2">
              {data.tickets.map((ticket) => (
                <li key={ticket.id}>
                  <Link
                    href={`/tickets/${ticket.id}`}
                    className="grid gap-2 rounded-xl bg-card p-4 ring-1 ring-border transition-colors outline-none hover:ring-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50 sm:grid-cols-[7rem_1fr_auto] sm:items-center"
                  >
                    <span className="font-mono text-sm text-muted-foreground">
                      {ticket.displayNumber}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">
                        {ticket.title}
                      </span>
                      <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
                        <span>{PLATFORM_LABEL[ticket.platform]}</span>
                        <PriorityLabel priority={ticket.priority} />
                        <span>
                          {ticket.productCount}{" "}
                          {ticket.productCount === 1 ? "product" : "products"}
                        </span>
                        <span>Updated {formatDate(ticket.updatedAt)}</span>
                        <span className="hidden md:inline">
                          Created {formatDate(ticket.createdAt)}
                        </span>
                      </span>
                    </span>
                    <StatusBadge status={ticket.status} />
                  </Link>
                </li>
              ))}
            </ul>
            {pages > 1 ? (
              <nav
                aria-label="Ticket pages"
                className="mt-4 flex items-center justify-between gap-2"
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft aria-hidden="true" />
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {page} of {pages}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page >= pages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                  <ChevronRight aria-hidden="true" />
                </Button>
              </nav>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}
