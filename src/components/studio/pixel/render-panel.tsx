"use client"

import { useState } from "react"
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clapperboard,
  Download,
  HardDrive,
  LoaderCircle,
} from "lucide-react"

import type { RenderView } from "@/components/studio/pixel/use-render-job"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { RenderProgress } from "@/lib/video/render-job"
import { formatBytes } from "@/lib/video/validation"

export interface RenderRequirement {
  label: string
  met: boolean
}

/** Human description of real server progress (no estimates). */
function describe(progress: RenderProgress | null, state: string) {
  if (!progress)
    return {
      text: state === "queued" ? "Waiting to start…" : "Rendering…",
      percent: null,
    }
  switch (progress.phase) {
    case "waiting":
      return {
        text:
          progress.position === 1
            ? "Waiting for the current render to finish…"
            : `Waiting: ${progress.position} videos ahead…`,
        percent: null,
      }
    case "preparing":
      return { text: "Preparing files…", percent: null }
    case "composing":
      return {
        text: `Composing scenes: ${progress.completedScenes} of ${progress.totalScenes} done`,
        percent: Math.round(
          (progress.completedScenes / progress.totalScenes) * 100,
        ),
      }
    case "encoding":
      return {
        text: `Encoding H.264: ${progress.encodedSeconds.toFixed(1)} of ${progress.totalSeconds.toFixed(1)} s`,
        percent: Math.round(progress.fraction * 100),
      }
    case "audio":
      return progress.step === "measuring" || progress.fraction === null
        ? { text: "Measuring audio loudness…", percent: null }
        : {
            text: "Mixing audio (the video stream is copied, not re-encoded)",
            percent: Math.round(progress.fraction * 100),
          }
    case "verifying":
      return { text: "Verifying the MP4 with FFprobe…", percent: null }
  }
}

function ProgressBar({
  percent,
  label,
}: {
  percent: number | null
  label: string
}) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className="h-2 overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          "h-full rounded-full bg-primary transition-[width] duration-300",
          percent === null && "w-1/3 animate-pulse motion-reduce:animate-none",
        )}
        style={percent === null ? undefined : { width: `${percent}%` }}
      />
    </div>
  )
}

export function RenderPanel({
  requirements,
  canRender,
  busy,
  view,
  onRender,
  canCancel = false,
  onCancel,
}: {
  requirements: readonly RenderRequirement[]
  canRender: boolean
  busy: boolean
  view: RenderView
  onRender: () => void
  /** True while the tracked render is queued or rendering. */
  canCancel?: boolean
  onCancel?: () => void
}) {
  const [cancelling, setCancelling] = useState(false)
  const status = view.kind === "tracking" ? view.status : null
  const completed =
    status?.state === "completed" && status.output && status.videoUrl
  const failed = view.kind === "error" || status?.state === "failed"
  const failureMessage =
    view.kind === "error" ? view.message : status?.error?.message

  let activity: { text: string; percent: number | null } | null = null
  if (view.kind === "uploading")
    activity = {
      text:
        view.what === "audio"
          ? `Uploading audio: ${view.uploaded} of ${view.total} checked`
          : `Uploading images: ${view.uploaded} of ${view.total}`,
      percent: Math.round((view.uploaded / view.total) * 100),
    }
  else if (view.kind === "starting")
    activity = { text: "Building the storyboard on the server…", percent: null }
  else if (
    status &&
    (status.state === "queued" || status.state === "rendering")
  )
    activity = describe(status.progress, status.state)

  return (
    <div className="flex flex-col gap-4">
      <ul
        aria-label="Render requirements"
        className="flex flex-col gap-1.5 text-sm"
      >
        {requirements.map(({ label, met }) => (
          <li key={label} className="flex items-center gap-2">
            {met ? (
              <CircleCheck
                aria-hidden="true"
                className="size-4 text-status-completed"
              />
            ) : (
              <CircleDashed
                aria-hidden="true"
                className="size-4 text-muted-foreground"
              />
            )}
            <span className={cn(!met && "text-muted-foreground")}>
              {label}
              <span className="sr-only">{met ? ": done" : ": not yet"}</span>
            </span>
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2">
        <Button
          type="button"
          size="lg"
          disabled={!canRender || busy}
          aria-describedby="render-help"
          className="self-start"
          onClick={onRender}
        >
          {busy ? (
            <LoaderCircle
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
          ) : (
            <Clapperboard aria-hidden="true" />
          )}
          {busy ? "Rendering…" : completed ? "Render again" : "Render MP4"}
        </Button>
        {canCancel && onCancel ? (
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={cancelling}
            onClick={() => {
              setCancelling(true)
              Promise.resolve(onCancel()).finally(() => setCancelling(false))
            }}
          >
            <Ban aria-hidden="true" />
            {cancelling ? "Cancelling…" : "Cancel render"}
          </Button>
        ) : null}
        <p id="render-help" className="text-sm text-muted-foreground">
          {canRender
            ? "Renders a 1080 × 1920 H.264 MP4 with FFmpeg on this computer. Nothing is sent to the internet."
            : "Complete the checklist above to render."}
        </p>
      </div>

      <div
        role="status"
        aria-live="polite"
        className="flex flex-col gap-2 empty:hidden"
      >
        {activity ? (
          <>
            <p className="text-sm font-medium">{activity.text}</p>
            <ProgressBar percent={activity.percent} label="Render progress" />
          </>
        ) : null}
        {completed ? (
          <p className="flex items-center gap-2 text-sm font-medium text-status-completed">
            <CircleCheck aria-hidden="true" className="size-4" />
            Video ready and verified by FFprobe.
          </p>
        ) : null}
      </div>

      {status?.state === "cancelled" ? (
        <p role="status" className="text-sm text-muted-foreground">
          Render cancelled. Nothing was saved as a video; your uploads are kept
          in the history until you delete them.
        </p>
      ) : null}

      {failed && failureMessage ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm ring-1 ring-destructive/40 ring-inset"
        >
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-destructive"
          />
          <p>
            <strong className="font-semibold">Render failed.</strong>{" "}
            {failureMessage}
          </p>
        </div>
      ) : null}

      {completed && status?.output && status.videoUrl && status.downloadUrl ? (
        <div className="flex flex-col gap-3">
          <video
            key={status.videoUrl}
            src={status.videoUrl}
            controls
            playsInline
            preload="metadata"
            aria-label="Rendered video preview"
            className="aspect-9/16 max-h-[70vh] w-full max-w-xs self-center rounded-lg bg-black ring-1 ring-border sm:self-start"
          />
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Format</dt>
            <dd className="font-medium">
              {status.output.width} × {status.output.height}, H.264,{" "}
              {status.output.fps} fps, {status.output.pixelFormat}
            </dd>
            <dt className="text-muted-foreground">Length</dt>
            <dd className="font-medium">
              {status.output.durationSeconds.toFixed(1)} s
            </dd>
            <dt className="text-muted-foreground">File size</dt>
            <dd className="font-medium">
              {formatBytes(status.output.sizeBytes)}
            </dd>
            <dt className="text-muted-foreground">Audio</dt>
            <dd className="font-medium">
              {status.output.audio
                ? `AAC-${status.output.audio.profile}, ${status.output.audio.sampleRate / 1000} kHz, ${status.output.audio.channels === 2 ? "stereo" : `${status.output.audio.channels} ch`}${status.output.audio.bitRate ? `, ${Math.round(status.output.audio.bitRate / 1000)} kb/s` : ""}`
                : "None (silent)"}
            </dd>
            <dt className="text-muted-foreground">Encoder</dt>
            <dd className="font-medium">
              {status.output.encoder}{" "}
              <span className="font-normal text-muted-foreground">
                (rendered in {status.output.renderSeconds.toFixed(1)} s)
              </span>
            </dd>
          </dl>
          <Button asChild variant="outline" className="self-start">
            <a href={status.downloadUrl} download>
              <Download aria-hidden="true" />
              Download MP4
            </a>
          </Button>
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <HardDrive
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0"
            />
            <span>
              Stored only on this computer, in Deskverse&apos;s private data
              folder (on Linux/WSL: ~/.local/share/deskverse). Nothing was
              uploaded to the internet.
            </span>
          </p>
        </div>
      ) : null}
    </div>
  )
}
