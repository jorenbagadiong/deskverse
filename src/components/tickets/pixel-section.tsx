"use client"

import { useEffect, useRef, useState } from "react"
import {
  Clapperboard,
  Download,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Square,
} from "lucide-react"

import { FormMessage, formatDate } from "@/components/tickets/fields"
import { Button } from "@/components/ui/button"
import {
  isActiveRun,
  RUN_STATUS_LABEL,
  type RunStatus,
} from "@/lib/orchestrator/model"
import {
  RUNS_CHANGED_EVENT,
  runEndpoint,
  runsEndpoint,
} from "@/lib/orchestrator/types"
import {
  AWAITING_QA_LABEL,
  deliverableVideoUrl,
  pixelEndpoint,
  RENDER_STATE_LABEL,
  type PixelDeliverable,
  type PixelOverview,
  type PixelRenderState,
} from "@/lib/pixel/types"
import {
  SCOUT_DIAGNOSTICS_ENDPOINT,
  type ScoutDiagnostics,
} from "@/lib/scout/types"
import { api, newRequestId } from "@/lib/tickets/client"
import type { ApiError, TicketDetail } from "@/lib/tickets/types"
import { MEDIA_LIMITS } from "@/lib/video/validation"

/**
 * Pixel Videos (DV-005C). Starts video-only runs (workflow
 * "pixel-render-v1") from a chosen Quill script and 3–6 pinned images, and
 * shows persisted render state (progress numbers come from FFmpeg via the
 * worker, never simulated), finished videos with preview and download, and
 * their technical checks. Finished videos await Vera QA (DV-006A).
 */

function progressText(r: PixelRenderState) {
  const p = r.progress
  if (!p) return null
  if (p.phase === "encoding")
    return `Encoding: ${Math.round(p.fraction * 100)}%`
  if (p.phase === "composing")
    return `Composing scenes: ${p.completedScenes} of ${p.totalScenes}`
  if (p.phase === "waiting") return "Waiting for the renderer"
  return p.phase === "verifying" ? "Verifying the video" : "Preparing files"
}

function Technical({ d }: { d: PixelDeliverable }) {
  const frames =
    (d.checks.disclosureFrames as
      { sceneId: string; iou: number }[] | undefined) ?? []
  return (
    <ul
      className="flex flex-col gap-0.5 text-xs text-muted-foreground"
      data-testid="video-technical"
    >
      <li>
        {d.width}×{d.height} · {d.fps} fps · {d.videoCodec} ({d.pixelFormat}) ·{" "}
        {(d.durationMs / 1000).toFixed(1)} s ·{" "}
        {(d.byteSize / 1024 / 1024).toFixed(1)} MB ·{" "}
        {d.audio ? "with audio" : "silent (captions only)"}
      </li>
      <li className="break-all">SHA-256 {d.sha256}</li>
      <li>
        Disclosure found in real frames of all {frames.length} scenes (glyph
        match{" "}
        {frames.length ? Math.min(...frames.map((f) => f.iou)).toFixed(2) : "–"}{" "}
        or better).
      </li>
      <li>
        From Quill script version {d.scriptVersion}. Narration isn&apos;t
        rendered (no voice-over); visual directions are guidance.
      </li>
    </ul>
  )
}

function VideoCard({ ticketId, d }: { ticketId: string; d: PixelDeliverable }) {
  return (
    <div className="flex flex-col gap-2" data-testid="pixel-video">
      <p
        className="inline-flex w-fit rounded-full px-2.5 py-0.5 text-xs font-semibold text-status-info ring-1 ring-status-info/40 ring-inset"
        data-testid="awaiting-qa"
      >
        {AWAITING_QA_LABEL}
      </p>
      <video
        controls
        preload="metadata"
        className="aspect-[9/16] w-full max-w-[240px] rounded-lg bg-black"
        src={deliverableVideoUrl(ticketId, d.id)}
        aria-label={`${d.productName}, video version ${d.version}`}
      />
      <a
        href={deliverableVideoUrl(ticketId, d.id, true)}
        className="inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-sm ring-1 ring-border outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        download
      >
        <Download aria-hidden="true" className="size-4" />
        Download MP4
      </a>
      <Technical d={d} />
    </div>
  )
}

export function PixelSection({ ticket }: { ticket: TicketDetail }) {
  const [overview, setOverview] = useState<PixelOverview | null>(null)
  const [worker, setWorker] = useState<ScoutDiagnostics["worker"] | null>(null)
  const [loadError, setLoadError] = useState<ApiError | null>(null)
  const [actionError, setActionError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const [scriptChoice, setScriptChoice] = useState<Record<string, string>>({})
  const [imageChoice, setImageChoice] = useState<Record<string, string[]>>({})
  const [rights, setRights] = useState<Record<string, boolean>>({})
  const startRequest = useRef<string | null>(null)

  useEffect(() => {
    const onChange = () => setTick((n) => n + 1)
    window.addEventListener(RUNS_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(RUNS_CHANGED_EVENT, onChange)
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    void api<PixelOverview>(pixelEndpoint(ticket.id)).then((r) => {
      if (cancelled) return
      if (!r.ok) {
        setLoadError(r.error)
        timer = setTimeout(() => setTick((n) => n + 1), 5_000)
        return
      }
      setLoadError(null)
      setOverview(r.data)
      if (r.data.latestRun && isActiveRun(r.data.latestRun.status as RunStatus))
        timer = setTimeout(() => setTick((n) => n + 1), 1_500)
    })
    void api<ScoutDiagnostics>(SCOUT_DIAGNOSTICS_ENDPOINT).then((r) => {
      if (!cancelled && r.ok) setWorker(r.data.worker)
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [ticket.id, tick])

  const usableScript = (productId: string) => {
    const p = overview?.products.find((x) => x.productId === productId)
    const id =
      productId in scriptChoice
        ? scriptChoice[productId]
        : (p?.scripts.find((s) => s.problem === null)?.scriptId ?? "")
    return (
      p?.scripts.find((s) => s.scriptId === id && s.problem === null) ?? null
    )
  }
  const selectedImages = (productId: string) => {
    const script = usableScript(productId)
    const p = overview?.products.find((x) => x.productId === productId)
    if (!script || !p) return []
    const allowed = p.images
      .filter((i) => script.imageIds.includes(i.assetId))
      .map((i) => i.assetId)
    // Default: the first six of the script's images, in product order (explicit and editable).
    return productId in imageChoice
      ? imageChoice[productId].filter((id) => allowed.includes(id))
      : allowed.slice(0, MEDIA_LIMITS.maxCount)
  }
  const readiness = (productId: string): string | null => {
    const p = overview!.products.find((x) => x.productId === productId)!
    const script = usableScript(productId)
    if (p.scripts.length === 0)
      return "No Quill script yet: write one in Quill Scripts above."
    if (!script) return p.scripts[0].problem ?? "Choose a script."
    const n = selectedImages(productId).length
    const later = p.images.filter(
      (i) => !script.imageIds.includes(i.assetId),
    ).length
    if (n < MEDIA_LIMITS.minCount)
      return `Choose ${MEDIA_LIMITS.minCount}–${MEDIA_LIMITS.maxCount} images (${n} chosen).${later ? ` ${later} image(s) were added after this script: to use them, mark the ticket Ready, run Scout again, write a new Quill script, then render with it.` : ""}`
    if (n > MEDIA_LIMITS.maxCount)
      return `Choose at most ${MEDIA_LIMITS.maxCount} images.`
    if (p.mediaRights === "unspecified" && !rights[productId])
      return "Confirm you may use these images (media rights are unspecified)."
    return null
  }
  const included = (overview?.products ?? []).filter(
    (p) =>
      usableScript(p.productId) &&
      !(p.productId in scriptChoice && scriptChoice[p.productId] === ""),
  )
  const ready = included.filter((p) => readiness(p.productId) === null)
  const latest = overview?.latestRun ?? null
  const active = latest ? isActiveRun(latest.status as RunStatus) : false
  const ffmpegProblem = overview?.availability.ffmpeg.problem ?? null
  const blocked = ffmpegProblem
    ? ffmpegProblem
    : ticket.status !== "ready"
      ? "Mark the ticket Ready to render videos."
      : active
        ? "A run is already in progress for this ticket."
        : ready.length === 0
          ? "No product is ready to render yet (see below)."
          : null

  async function act(url: string, body: unknown) {
    setBusy(true)
    setActionError(null)
    const result = await api(url, { method: "POST", body })
    setBusy(false)
    if (!result.ok) setActionError(result.error)
    window.dispatchEvent(new Event(RUNS_CHANGED_EVENT))
    setTick((n) => n + 1)
    return result.ok
  }

  async function start() {
    startRequest.current ??= newRequestId()
    const ok = await act(runsEndpoint(ticket.id), {
      requestId: startRequest.current,
      ticketVersion: ticket.version,
      mode: "production",
      workflow: "pixel-render-v1",
      renders: ready.map((p) => ({
        productId: p.productId,
        scriptId: usableScript(p.productId)!.scriptId,
        assetIds: selectedImages(p.productId),
        ...(rights[p.productId] ? { rightsAcknowledged: true } : {}),
      })),
    })
    if (ok) startRequest.current = null
  }

  const imageUrl = (productId: string, assetId: string) =>
    ticket.products
      .find((p) => p.id === productId)
      ?.assets.find((a) => a.id === assetId)?.url ?? null
  const latestIds = new Set(
    latest?.renders.map((r) => r.deliverableId).filter(Boolean),
  )
  const earlier = (overview?.deliverables ?? []).filter(
    (d) => !latestIds.has(d.id),
  )

  return (
    <section
      aria-labelledby="pixel-title"
      className="flex max-w-4xl flex-col gap-4"
      data-testid="pixel-section"
    >
      <h2 id="pixel-title" className="text-title">
        Pixel Videos
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
          Loading videos…
        </p>
      ) : null}
      {loadError ? (
        <FormMessage>
          <p className="font-semibold">Couldn&apos;t load videos.</p>
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
            data-testid="pixel-availability"
            className="flex flex-col gap-1 rounded-xl bg-surface-sunken p-4 text-sm ring-1 ring-border"
          >
            <p className="font-semibold">
              Video only: Pixel renders a Quill script with your product images.
            </p>
            <p className="text-muted-foreground">
              Silent, captioned 1080×1920 videos with the affiliate disclosure
              on every scene, rendered one at a time (Pixel Studio waits its
              turn too). Finished videos are technically verified and wait for
              Vera&apos;s QA; nothing is published.
            </p>
            <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
              <li data-testid="pixel-ffmpeg">
                FFmpeg:{" "}
                {ffmpegProblem
                  ? `not ready — ${ffmpegProblem}`
                  : `ready (${overview.availability.ffmpeg.encoder})`}
              </li>
              <li data-testid="pixel-worker">
                Worker:{" "}
                {worker?.status === "running"
                  ? "running"
                  : worker?.status === "not_seen"
                    ? "not running. Renders wait until you start it: yarn worker:start"
                    : "unknown"}
              </li>
            </ul>
          </div>

          <div className="flex flex-col gap-3" data-testid="pixel-choices">
            {overview.products.map((p) => {
              const script = usableScript(p.productId)
              const chosen = selectedImages(p.productId)
              const problem = readiness(p.productId)
              return (
                <fieldset
                  key={p.productId}
                  className="flex flex-col gap-2 rounded-lg p-3 ring-1 ring-border"
                  data-testid="pixel-product"
                >
                  <legend className="px-1 text-sm font-semibold">
                    {p.name}
                  </legend>
                  <label className="flex flex-col gap-1 text-sm">
                    Script
                    <select
                      className="w-full max-w-xl rounded-md bg-background px-2 py-1.5 ring-1 ring-border outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      value={script?.scriptId ?? ""}
                      onChange={(e) =>
                        setScriptChoice({
                          ...scriptChoice,
                          [p.productId]: e.target.value,
                        })
                      }
                    >
                      <option value="">Don&apos;t render this product</option>
                      {p.scripts.map((s) => (
                        <option
                          key={s.scriptId}
                          value={s.scriptId}
                          disabled={s.problem !== null}
                        >
                          Script version {s.scriptVersion} · research v
                          {s.reportVersion} · {formatDate(s.createdAt)}
                          {s.problem
                            ? ` · ${s.problem}`
                            : " · checksum verified"}
                        </option>
                      ))}
                    </select>
                  </label>
                  {script ? (
                    <fieldset className="flex flex-col gap-1">
                      <legend className="text-sm">
                        Images ({chosen.length} of {MEDIA_LIMITS.minCount}–
                        {MEDIA_LIMITS.maxCount}; the first is the hero image)
                      </legend>
                      <ul className="flex flex-wrap gap-2">
                        {p.images.map((img) => {
                          const allowed = script.imageIds.includes(img.assetId)
                          const url = imageUrl(p.productId, img.assetId)
                          return (
                            <li key={img.assetId}>
                              <label
                                className={`flex w-24 flex-col items-center gap-1 text-xs ${allowed ? "" : "opacity-50"}`}
                              >
                                {url ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={url}
                                    alt=""
                                    className="size-16 rounded object-cover ring-1 ring-border"
                                  />
                                ) : null}
                                <span className="flex items-center gap-1">
                                  <input
                                    type="checkbox"
                                    disabled={!allowed}
                                    checked={chosen.includes(img.assetId)}
                                    aria-label={`Use ${img.name || "image"} (${img.width}×${img.height})${allowed ? "" : ", added after this script"}`}
                                    onChange={(e) =>
                                      setImageChoice({
                                        ...imageChoice,
                                        [p.productId]: e.target.checked
                                          ? [...chosen, img.assetId]
                                          : chosen.filter(
                                              (x) => x !== img.assetId,
                                            ),
                                      })
                                    }
                                  />
                                  {chosen.includes(img.assetId)
                                    ? `#${chosen.indexOf(img.assetId) + 1}`
                                    : allowed
                                      ? ""
                                      : "new"}
                                </span>
                              </label>
                            </li>
                          )
                        })}
                      </ul>
                    </fieldset>
                  ) : null}
                  {script ? (
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={rights[p.productId] ?? false}
                        onChange={(e) =>
                          setRights({
                            ...rights,
                            [p.productId]: e.target.checked,
                          })
                        }
                      />
                      <span>
                        I confirm I may use these images in a published video.
                        {p.mediaRights === "unspecified"
                          ? " (This records your confirmation; it doesn't prove permission.)"
                          : " The Approval Inbox requires this confirmation."}
                      </span>
                    </label>
                  ) : null}
                  {problem ? (
                    <p
                      className="text-xs break-words text-status-waiting"
                      data-testid="pixel-readiness"
                    >
                      {problem}
                    </p>
                  ) : (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="pixel-readiness"
                    >
                      Ready to render. Pixel text limits: compatible.
                    </p>
                  )}
                </fieldset>
              )
            })}
          </div>

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
                <Clapperboard aria-hidden="true" />
              )}
              Start render
              {ready.length > 1 ? ` (${ready.length} products)` : ""}
            </Button>
            {blocked ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid="pixel-blocked"
              >
                {blocked}
              </p>
            ) : null}
          </div>
          {actionError ? (
            <FormMessage>
              <p className="font-semibold">That didn&apos;t work.</p>
              <p className="mt-1">{actionError.message}</p>
            </FormMessage>
          ) : null}

          {latest ? (
            <article
              aria-labelledby="pixel-run-title"
              className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-border"
            >
              <header className="flex flex-wrap items-center gap-2">
                <h3 id="pixel-run-title" className="font-semibold">
                  Latest video run
                </h3>
                <span
                  data-testid="pixel-run-status"
                  className="rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-border ring-inset"
                >
                  {RUN_STATUS_LABEL[latest.status as RunStatus] ??
                    latest.status}
                </span>
                <span className="text-sm text-muted-foreground">
                  {formatDate(latest.createdAt)}
                </span>
                {active ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void act(`${runEndpoint(ticket.id, latest.id)}/cancel`, {
                        requestId: newRequestId(),
                      })
                    }
                  >
                    <Square aria-hidden="true" />
                    Cancel run
                  </Button>
                ) : null}
              </header>
              {active && worker && worker.status !== "running" ? (
                <p className="text-sm text-status-waiting">
                  Waiting for a worker. Start one with yarn worker:start.
                </p>
              ) : null}
              <ul
                aria-label="Videos by product"
                className="flex flex-col gap-3"
              >
                {latest.renders.map((r) => {
                  const d = overview.deliverables.find(
                    (x) => x.id === r.deliverableId,
                  )
                  const progress =
                    r.taskStatus === "running" ? progressText(r) : null
                  return (
                    <li
                      key={r.renderJobId}
                      data-pixel-task-status={r.taskStatus}
                      data-render-state={r.state}
                      className="flex flex-col gap-2 rounded-lg p-3 ring-1 ring-border"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium">{r.productName}</p>
                        <span
                          className="text-xs text-muted-foreground"
                          data-testid="pixel-render-state"
                        >
                          {r.taskStatus === "completed"
                            ? AWAITING_QA_LABEL
                            : r.taskStatus === "running"
                              ? RENDER_STATE_LABEL[r.state]
                              : r.taskStatus === "queued" ||
                                  r.taskStatus === "retry_wait"
                                ? "Waiting for a worker"
                                : r.taskStatus.replace(/_/g, " ")}
                          {r.attempts > 1 ? ` (attempt ${r.attempts})` : ""}
                        </span>
                        {(r.taskStatus === "failed" ||
                          r.taskStatus === "needs_input") &&
                        !["cancelling", "cancelled"].includes(latest.status) ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={busy}
                            aria-label={`Retry the video for ${r.productName}`}
                            onClick={() =>
                              void act(
                                `${runEndpoint(ticket.id, latest.id)}/tasks/${r.taskId}/retry`,
                                { requestId: newRequestId() },
                              )
                            }
                          >
                            <RotateCcw aria-hidden="true" />
                            Retry
                          </Button>
                        ) : null}
                      </div>
                      {progress ? (
                        <p
                          className="text-xs text-muted-foreground"
                          role="status"
                          data-testid="pixel-progress"
                        >
                          {progress}
                        </p>
                      ) : null}
                      {r.failureMessage &&
                      r.taskStatus !== "completed" &&
                      r.taskStatus !== "cancelled" ? (
                        <p
                          className="text-xs break-words"
                          data-testid="pixel-task-message"
                        >
                          {r.failureMessage}
                        </p>
                      ) : null}
                      {d ? <VideoCard ticketId={ticket.id} d={d} /> : null}
                    </li>
                  )
                })}
              </ul>
            </article>
          ) : (
            <p className="text-sm text-muted-foreground">No videos yet.</p>
          )}
          {earlier.length > 0 ? (
            <details className="text-sm" data-testid="pixel-history">
              <summary className="cursor-pointer rounded-md font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                Earlier videos ({earlier.length})
              </summary>
              <ul className="mt-2 flex flex-col gap-3">
                {earlier.map((d) => (
                  <li
                    key={d.id}
                    className="flex flex-col gap-1 rounded-lg p-2 ring-1 ring-border"
                  >
                    <p className="text-sm font-medium">
                      {d.productName} · video version {d.version} ·{" "}
                      {formatDate(d.createdAt)}
                    </p>
                    <VideoCard ticketId={ticket.id} d={d} />
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
