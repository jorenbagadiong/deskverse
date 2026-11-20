"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  CAPABILITIES_ENDPOINT,
  REQUIRED_FILTERS,
  type CapabilityStatus,
  type FfmpegCapabilityReport,
} from "@/lib/video/capabilities"

type ViewState =
  | { kind: "checking" }
  | { kind: "report"; report: FfmpegCapabilityReport }
  | { kind: "error"; message: string }

type Tone = "checking" | CapabilityStatus | "error"

const TONE: Record<Tone, { label: string; Icon: LucideIcon; classes: string }> =
  {
    checking: {
      label: "Checking…",
      Icon: LoaderCircle,
      classes: "text-status-idle bg-status-idle/12 ring-status-idle/30",
    },
    ready: {
      label: "Ready",
      Icon: CircleCheck,
      classes:
        "text-status-completed bg-status-completed/12 ring-status-completed/35",
    },
    missing: {
      label: "Not installed",
      Icon: CircleAlert,
      classes: "text-status-failed bg-status-failed/12 ring-status-failed/40",
    },
    unsupported: {
      label: "Unsupported build",
      Icon: TriangleAlert,
      classes:
        "text-status-waiting bg-status-waiting/12 ring-status-waiting/35",
    },
    error: {
      label: "Check failed",
      Icon: CircleAlert,
      classes: "text-status-failed bg-status-failed/12 ring-status-failed/40",
    },
  }

const HEADLINE: Record<Tone, string> = {
  checking: "Checking this computer for FFmpeg…",
  ready: "FFmpeg and FFprobe are installed and can produce H.264 MP4 video.",
  missing: "FFmpeg isn't available on this computer yet.",
  unsupported: "FFmpeg is installed, but this build can't render Pixel videos.",
  error: "Couldn't check FFmpeg.",
}

const INSTALL_COMMANDS = [
  "sudo apt update",
  "sudo apt install -y ffmpeg",
  "ffmpeg -hide_banner -version",
].join("\n")

const LICENSE: Record<FfmpegCapabilityReport["license"], string> = {
  gpl: "GPL build",
  lgpl: "LGPL build",
  nonfree: "Non-free build (not redistributable)",
  unknown: "Unknown",
}

/** Minimal shape check: the response is data, never trusted blindly. */
function isReport(value: unknown): value is FfmpegCapabilityReport {
  if (typeof value !== "object" || value === null) return false
  const report = value as Record<string, unknown>
  return (
    ["ready", "missing", "unsupported"].includes(report.status as string) &&
    typeof report.ffmpeg === "object" &&
    typeof report.ffprobe === "object" &&
    Array.isArray(report.issues) &&
    Array.isArray(report.filters) &&
    Array.isArray(report.h264Encoders)
  )
}

async function fetchReport(refresh: boolean): Promise<ViewState> {
  try {
    const response = await fetch(
      `${CAPABILITIES_ENDPOINT}${refresh ? "?refresh=1" : ""}`,
      { cache: "no-store", headers: { Accept: "application/json" } },
    )
    const body: unknown = await response.json().catch(() => null)
    if (response.ok && isReport(body)) return { kind: "report", report: body }
    const message =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : `The server answered with status ${response.status}.`
    return { kind: "error", message }
  } catch {
    return {
      kind: "error",
      message: "The Deskverse server didn't respond. Is it still running?",
    }
  }
}

export function FfmpegStatus({
  onStatus,
}: {
  /** Reports the detected status upward (e.g. for the render panel). */
  onStatus?: (status: Tone) => void
}) {
  const [state, setState] = useState<ViewState>({ kind: "checking" })
  // Latest callback without re-running the fetch effect when it changes.
  const onStatusRef = useRef(onStatus)
  useEffect(() => {
    onStatusRef.current = onStatus
  })

  const apply = useCallback((next: ViewState) => {
    setState(next)
    onStatusRef.current?.(next.kind === "report" ? next.report.status : "error")
  }, [])

  // Check once on mount; ignore the answer if the page has moved on.
  useEffect(() => {
    let cancelled = false
    void fetchReport(false).then((next) => {
      if (!cancelled) apply(next)
    })
    return () => {
      cancelled = true
    }
  }, [apply])

  async function recheck() {
    setState({ kind: "checking" })
    apply(await fetchReport(true))
  }

  const tone: Tone =
    state.kind === "report"
      ? state.report.status
      : state.kind === "error"
        ? "error"
        : "checking"
  const { label, Icon, classes } = TONE[tone]
  const report = state.kind === "report" ? state.report : null
  const errors = report?.issues.filter((i) => i.severity === "error") ?? []
  const warnings = report?.issues.filter((i) => i.severity === "warning") ?? []

  return (
    <div className="flex flex-col gap-4" data-ffmpeg-status={tone}>
      <div role="status" className="flex flex-col gap-2">
        <span
          className={cn(
            "inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset",
            classes,
          )}
        >
          <Icon
            aria-hidden="true"
            className={cn(
              "size-3.5",
              tone === "checking" && "animate-spin motion-reduce:animate-none",
            )}
          />
          {label}
        </span>
        <p className="text-sm font-medium">{HEADLINE[tone]}</p>
      </div>

      {state.kind === "error" ? (
        <p className="text-sm text-muted-foreground">{state.message}</p>
      ) : null}

      {errors.length > 0 ? (
        <ul className="flex flex-col gap-2 text-sm">
          {errors.map((issue) => (
            <li key={issue.code} className="flex gap-2">
              <CircleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-status-failed"
              />
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {tone === "missing" || tone === "unsupported" ? (
        <div className="flex flex-col gap-2 rounded-lg bg-surface-sunken p-3 text-sm ring-1 ring-border">
          <p className="font-medium">
            Install FFmpeg (Windows 11 + WSL2 Ubuntu)
          </p>
          <p className="text-muted-foreground">
            Run these in the Ubuntu terminal where Deskverse runs, not in
            Windows PowerShell:
          </p>
          <pre className="overflow-x-auto rounded-md bg-background p-2 font-mono text-xs ring-1 ring-border">
            <code>{INSTALL_COMMANDS}</code>
          </pre>
          <p className="text-muted-foreground">
            Then select <strong className="text-foreground">Check again</strong>
            . No restart needed. Details are in{" "}
            <code className="font-mono text-xs">
              docs/video-architecture.md
            </code>
            .
          </p>
        </div>
      ) : null}

      {report && report.ffmpeg.available ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">FFmpeg</dt>
          <dd className="font-mono text-xs leading-5 break-all">
            {report.ffmpeg.version}
          </dd>
          <dt className="text-muted-foreground">FFprobe</dt>
          <dd className="font-mono text-xs leading-5 break-all">
            {report.ffprobe.version ?? "Not found"}
          </dd>
          <dt className="text-muted-foreground">H.264 encoder</dt>
          <dd className="font-medium">
            {report.selectedH264Encoder ?? "None found"}
            {report.h264Encoders.length > 1 ? (
              <span className="font-normal text-muted-foreground">
                {" "}
                (of {report.h264Encoders.map((e) => e.name).join(", ")})
              </span>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">AAC encoder</dt>
          <dd className="font-medium">
            {report.aacEncoder ?? "None"}{" "}
            <span className="font-normal text-muted-foreground">
              (audio in DV-003C)
            </span>
          </dd>
          <dt className="text-muted-foreground">Filters</dt>
          <dd className="font-medium">
            {report.filters.filter((f) => f.required && f.available).length}/
            {REQUIRED_FILTERS.length} required
          </dd>
          <dt className="text-muted-foreground">License</dt>
          <dd className="font-medium">{LICENSE[report.license]}</dd>
        </dl>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="flex flex-col gap-2 text-sm">
          {warnings.map((issue) => (
            <li key={issue.code} className="flex gap-2">
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-status-waiting"
              />
              <span className="text-muted-foreground">{issue.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={state.kind === "checking"}
        onClick={() => void recheck()}
      >
        <RefreshCw aria-hidden="true" />
        Check again
      </Button>
    </div>
  )
}
