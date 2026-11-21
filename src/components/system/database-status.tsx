"use client"

import { useCallback, useEffect, useState } from "react"
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  LoaderCircle,
  RefreshCw,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DATABASE_HEALTH_ENDPOINT,
  DATABASE_STATUS_LABEL,
  isDatabaseHealthReport,
  type DatabaseHealthReport,
  type DatabaseHealthStatus,
} from "@/lib/system/database-health"
import { cn } from "@/lib/utils"

/**
 * "Local PostgreSQL — Ready" (DV-004A). Reads GET
 * /api/system/database/health once on mount and on "Check again". It only
 * shows a status; the database itself is never reachable from the browser.
 */

type View =
  | { kind: "checking" }
  | { kind: "report"; report: DatabaseHealthReport }
  | { kind: "unreachable" }

type Tone = "checking" | DatabaseHealthStatus

const TONE: Record<Tone, { Icon: LucideIcon; classes: string }> = {
  checking: {
    Icon: LoaderCircle,
    classes: "text-status-idle bg-status-idle/12 ring-status-idle/30",
  },
  ready: {
    Icon: CircleCheck,
    classes:
      "text-status-completed bg-status-completed/12 ring-status-completed/35",
  },
  unconfigured: {
    Icon: CircleDashed,
    classes: "text-status-idle bg-status-idle/12 ring-status-idle/30",
  },
  offline: {
    Icon: CircleAlert,
    classes: "text-status-waiting bg-status-waiting/12 ring-status-waiting/35",
  },
  error: {
    Icon: CircleAlert,
    classes: "text-status-failed bg-status-failed/12 ring-status-failed/40",
  },
}

async function fetchHealth(): Promise<View> {
  try {
    const response = await fetch(DATABASE_HEALTH_ENDPOINT, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    })
    const body: unknown = await response.json().catch(() => null)
    return response.ok && isDatabaseHealthReport(body)
      ? { kind: "report", report: body }
      : { kind: "unreachable" }
  } catch {
    return { kind: "unreachable" }
  }
}

export function DatabaseStatus() {
  const [view, setView] = useState<View>({ kind: "checking" })

  const check = useCallback(async () => {
    setView({ kind: "checking" })
    setView(await fetchHealth())
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetchHealth().then((next) => {
      if (!cancelled) setView(next)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const tone: Tone =
    view.kind === "report"
      ? view.report.status
      : view.kind === "unreachable"
        ? "error"
        : "checking"
  const { Icon, classes } = TONE[tone]
  const label = tone === "checking" ? "Checking…" : DATABASE_STATUS_LABEL[tone]
  const message =
    view.kind === "report"
      ? view.report.message
      : view.kind === "unreachable"
        ? "Couldn't ask the Deskverse server. Is it still running?"
        : "Checking local PostgreSQL…"

  return (
    <div
      className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-border sm:flex-row sm:items-start sm:justify-between"
      data-database-status={tone}
    >
      <div role="status" className="flex min-w-0 flex-col gap-1.5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          Local PostgreSQL
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset",
              classes,
            )}
          >
            <Icon
              aria-hidden="true"
              className={cn(
                "size-3.5",
                tone === "checking" &&
                  "animate-spin motion-reduce:animate-none",
              )}
            />
            {label}
          </span>
        </p>
        <p className="text-sm break-words text-muted-foreground">{message}</p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-fit shrink-0"
        onClick={() => void check()}
        disabled={tone === "checking"}
      >
        <RefreshCw aria-hidden="true" />
        Check again
      </Button>
    </div>
  )
}
