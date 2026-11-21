"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Ban,
  Download,
  HardDrive,
  History,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
} from "lucide-react"

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
import { cn } from "@/lib/utils"
import {
  cancelEndpoint,
  CLEANUP_ENDPOINT,
  historyEndpoint,
  jobEndpoint,
  retryEndpoint,
  STORAGE_ENDPOINT,
  type ApiError,
  type CleanupSummary,
  type JobHistory,
  type JobSummary,
  type StorageSummary,
} from "@/lib/video/render-api"
import { formatTime } from "@/lib/video/audio-timing"
import { describeEffects } from "@/lib/video/effects"
import type { RenderProgress } from "@/lib/video/render-job"
import type { AudioMode } from "@/lib/video/types"
import { formatBytes } from "@/lib/video/validation"

/** Poll while something is queued or rendering; otherwise stay quiet. */
const ACTIVE_POLL_MS = 1500

const STATE_STYLE: Record<
  JobSummary["state"],
  { label: string; classes: string }
> = {
  draft: {
    label: "Draft",
    classes: "text-status-idle bg-status-idle/12 ring-status-idle/30",
  },
  queued: {
    label: "Queued",
    classes: "text-status-waiting bg-status-waiting/12 ring-status-waiting/35",
  },
  rendering: {
    label: "Rendering",
    classes: "text-status-working bg-status-working/12 ring-status-working/35",
  },
  completed: {
    label: "Completed",
    classes:
      "text-status-completed bg-status-completed/12 ring-status-completed/35",
  },
  failed: {
    label: "Failed",
    classes: "text-status-failed bg-status-failed/12 ring-status-failed/40",
  },
  cancelled: {
    label: "Cancelled",
    classes: "text-status-idle bg-status-idle/12 ring-status-idle/30",
  },
}

const AUDIO_LABEL: Record<AudioMode, string> = {
  none: "No audio",
  voiceover: "Voiceover",
  music: "Music",
  "voiceover-and-music": "Voiceover + music",
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { cache: "no-store", ...init })
  } catch {
    throw new Error("The Deskverse server didn't respond. Is it still running?")
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok)
    throw new Error(
      typeof body === "object" && body && "message" in body
        ? String((body as ApiError).message)
        : `The server answered with status ${response.status}.`,
    )
  return body as T
}

function progressText(progress: RenderProgress | null, state: string) {
  if (!progress) return state === "queued" ? "Waiting…" : "Rendering…"
  switch (progress.phase) {
    case "waiting":
      return `Waiting (position ${progress.position})`
    case "preparing":
      return "Preparing…"
    case "composing":
      return `Composing scenes ${progress.completedScenes}/${progress.totalScenes}`
    case "encoding":
      return `Encoding ${Math.round(progress.fraction * 100)}%`
    case "audio":
      return progress.fraction === null
        ? "Measuring audio…"
        : `Mixing audio ${Math.round(progress.fraction * 100)}%`
    case "verifying":
      return "Verifying…"
  }
}

function progressPercent(progress: RenderProgress | null) {
  if (progress?.phase === "encoding") return Math.round(progress.fraction * 100)
  if (progress?.phase === "audio" && progress.fraction !== null)
    return Math.round(progress.fraction * 100)
  if (progress?.phase === "composing")
    return Math.round((progress.completedScenes / progress.totalScenes) * 100)
  return null
}

/**
 * Server-backed history and storage summary. Polls only while a job is
 * active (or right after `refreshKey` changes) and stops on unmount.
 */
function useJobHistory(refreshKey: unknown) {
  const [history, setHistory] = useState<JobHistory | null>(null)
  const [storage, setStorage] = useState<StorageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bumped by the poll timer while a job is active; re-runs the load effect.
  const [tick, setTick] = useState(0)
  const alive = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    try {
      const [jobs, usage] = await Promise.all([
        call<JobHistory>(historyEndpoint()),
        call<StorageSummary>(STORAGE_ENDPOINT),
      ])
      if (!alive.current) return
      // Never trust the shape blindly: a malformed answer is an error state.
      if (!Array.isArray(jobs?.jobs) || typeof usage?.totalBytes !== "number")
        throw new Error("The server sent an unexpected answer.")
      setHistory(jobs)
      setStorage(usage)
      setError(null)
      if (
        jobs.jobs.some((j) => j.state === "queued" || j.state === "rendering")
      )
        timer.current = setTimeout(() => setTick((t) => t + 1), ACTIVE_POLL_MS)
    } catch (e) {
      if (alive.current) setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) void load()
    })
    return () => {
      cancelled = true
    }
  }, [load, refreshKey, tick])

  useEffect(
    () => () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  return { history, storage, error, reload: load }
}

function JobRow({
  job,
  onChanged,
}: {
  job: JobSummary
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState<"cancel" | "retry" | "delete" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const style = STATE_STYLE[job.state]
  const interrupted = job.error?.code === "interrupted"
  const title = job.productName ?? "Untitled draft"
  const active = job.state === "queued" || job.state === "rendering"
  const percent = progressPercent(job.progress)

  async function act(kind: "cancel" | "retry" | "delete") {
    setBusy(kind)
    setError(null)
    try {
      if (kind === "cancel")
        await call(cancelEndpoint(job.jobId), { method: "POST" })
      if (kind === "retry")
        await call(retryEndpoint(job.jobId), { method: "POST" })
      if (kind === "delete")
        await call(jobEndpoint(job.jobId), { method: "DELETE" })
      await onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const details = [
    dateFormat.format(new Date(job.createdAt)),
    job.audioMode ? AUDIO_LABEL[job.audioMode] : null,
    job.effects ? describeEffects(job.effects) : null,
    job.narration
      ? `Narration ${formatTime(job.narration.startSeconds)}–${formatTime(job.narration.endSeconds)}`
      : null,
    job.imageCount ? `${job.imageCount} images` : null,
    job.durationSeconds !== null ? `${job.durationSeconds.toFixed(1)} s` : null,
    job.sizeBytes !== null ? formatBytes(job.sizeBytes) : null,
  ].filter(Boolean)

  return (
    <li
      className="flex flex-col gap-2 rounded-lg bg-surface-sunken p-3 ring-1 ring-border"
      aria-label={`${title}, ${interrupted ? "interrupted" : style.label.toLowerCase()}`}
      data-job-state={job.state}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold" title={title}>
            {title}
          </p>
          <p className="text-xs text-muted-foreground">{details.join(" · ")}</p>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset",
            style.classes,
          )}
        >
          {job.state === "rendering" ? (
            <LoaderCircle
              aria-hidden="true"
              className="size-3 animate-spin motion-reduce:animate-none"
            />
          ) : null}
          {interrupted ? "Interrupted" : style.label}
        </span>
      </div>

      {active ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            {progressText(job.progress, job.state)}
          </p>
          <div
            role="progressbar"
            aria-label={`Progress of ${title}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={cn(
                "h-full rounded-full bg-primary transition-[width] duration-300",
                percent === null &&
                  "w-1/3 animate-pulse motion-reduce:animate-none",
              )}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
        </div>
      ) : null}

      {job.state === "failed" && job.error ? (
        <p className="text-xs text-status-failed">{job.error.message}</p>
      ) : null}

      {previewing && job.videoUrl ? (
        <video
          src={job.videoUrl}
          controls
          playsInline
          preload="metadata"
          aria-label={`Preview of ${title}`}
          className="aspect-9/16 max-h-[60vh] w-full max-w-[14rem] self-center rounded-md bg-black ring-1 ring-border sm:self-start"
        />
      ) : null}

      <div className="flex flex-wrap gap-2">
        {job.actions.preview && job.videoUrl ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={previewing}
            aria-label={`${previewing ? "Hide preview of" : "Preview"} ${title}`}
            onClick={() => setPreviewing((v) => !v)}
          >
            <Play aria-hidden="true" />
            {previewing ? "Hide" : "Preview"}
          </Button>
        ) : null}
        {job.actions.preview && job.downloadUrl ? (
          <Button asChild variant="outline" size="sm">
            <a href={job.downloadUrl} download aria-label={`Download ${title}`}>
              <Download aria-hidden="true" />
              Download
            </a>
          </Button>
        ) : null}
        {job.actions.retry ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy !== null}
            aria-label={`Retry ${title}`}
            onClick={() => void act("retry")}
          >
            <RotateCcw aria-hidden="true" />
            {busy === "retry" ? "Retrying…" : "Retry"}
          </Button>
        ) : null}
        {job.actions.cancel ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy !== null}
            aria-label={`Cancel ${title}`}
            onClick={() => void act("cancel")}
          >
            <Ban aria-hidden="true" />
            {busy === "cancel" ? "Cancelling…" : "Cancel"}
          </Button>
        ) : null}
        {job.actions.delete ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                aria-label={`Delete ${title}`}
              >
                <Trash2 aria-hidden="true" />
                {busy === "delete" ? "Deleting…" : "Delete"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete “{title}”?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently removes the job from this computer: its
                  uploaded images and audio
                  {job.actions.preview ? ", and the rendered video" : ""}. It
                  can&apos;t be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => void act("delete")}
                >
                  Delete permanently
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  )
}

function StorageSummaryView({
  storage,
  onChanged,
}: {
  storage: StorageSummary
  onChanged: () => Promise<void>
}) {
  const [cleaning, setCleaning] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function cleanup() {
    setCleaning(true)
    try {
      const result = await call<CleanupSummary>(CLEANUP_ENDPOINT, {
        method: "POST",
      })
      setMessage(
        result.freedBytes === 0 && result.removedDrafts === 0
          ? "Nothing to clean up."
          : `Freed ${formatBytes(result.freedBytes)}: ${result.removedDrafts} abandoned draft${result.removedDrafts === 1 ? "" : "s"}, ${result.clearedWorkDirs} scratch folder${result.clearedWorkDirs === 1 ? "" : "s"}, ${result.removedTempFiles} temp file${result.removedTempFiles === 1 ? "" : "s"}.`,
      )
      await onChanged()
    } catch (e) {
      setMessage((e as Error).message)
    } finally {
      setCleaning(false)
    }
  }

  const counts = [
    `${storage.jobs} job${storage.jobs === 1 ? "" : "s"}`,
    `${storage.completed} video${storage.completed === 1 ? "" : "s"}`,
    `${storage.failed} failed${storage.interrupted ? ` (${storage.interrupted} interrupted)` : ""}`,
    `${storage.cancelled} cancelled`,
    `${storage.drafts} draft${storage.drafts === 1 ? "" : "s"}`,
  ]

  return (
    <section
      aria-labelledby="storage-title"
      className="flex flex-col gap-2 rounded-lg p-3 ring-1 ring-border"
    >
      <h3
        id="storage-title"
        className="flex items-center gap-2 text-sm font-semibold"
      >
        <HardDrive aria-hidden="true" className="size-4 text-primary" />
        Storage on this computer
      </h3>
      <p className="text-sm" data-testid="storage-total">
        <span className="font-semibold">{formatBytes(storage.totalBytes)}</span>{" "}
        <span className="text-muted-foreground">
          (videos {formatBytes(storage.outputBytes)} · uploads{" "}
          {formatBytes(storage.uploadBytes)} · temporary{" "}
          {formatBytes(storage.workBytes)})
        </span>
      </p>
      <p className="text-xs text-muted-foreground" data-testid="storage-counts">
        {counts.join(" · ")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={cleaning}
          onClick={() => void cleanup()}
        >
          <Sparkles aria-hidden="true" />
          {cleaning ? "Cleaning up…" : "Clean up temporary files"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Removes scratch files and drafts untouched for an hour. Videos and
          failed jobs are kept.
        </span>
      </div>
      {message ? (
        <p role="status" className="text-xs">
          {message}
        </p>
      ) : null}
    </section>
  )
}

export function RenderHistory({ refreshKey }: { refreshKey: unknown }) {
  const { history, storage, error, reload } = useJobHistory(refreshKey)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {history
            ? history.total > history.jobs.length
              ? `Newest ${history.jobs.length} of ${history.total} jobs.`
              : `${history.total} job${history.total === 1 ? "" : "s"} saved on this computer.`
            : "Loading your render history…"}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void reload()}
          aria-label="Refresh render history"
        >
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn&apos;t load the history: {error}
        </p>
      ) : null}

      {history && history.jobs.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg bg-surface-sunken p-6 text-center ring-1 ring-border">
          <History
            aria-hidden="true"
            className="size-6 text-muted-foreground"
          />
          <p className="text-sm font-medium">No renders yet</p>
          <p className="text-xs text-muted-foreground">
            Videos you render appear here, so you can preview, download, retry
            or delete them later, even after reloading the page.
          </p>
        </div>
      ) : null}

      {history && history.jobs.length > 0 ? (
        <ul aria-label="Render history" className="flex flex-col gap-2">
          {history.jobs.map((job) => (
            <JobRow key={job.jobId} job={job} onChanged={reload} />
          ))}
        </ul>
      ) : null}

      {storage ? (
        <StorageSummaryView storage={storage} onChanged={reload} />
      ) : null}
    </div>
  )
}
