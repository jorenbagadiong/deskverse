"use client"

import { useState } from "react"
import {
  FileAudio,
  Music,
  Mic,
  Scale,
  Scissors,
  Trash2,
  TriangleAlert,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { AUDIO_OUTPUT } from "@/lib/video/format"
import {
  AUDIO_MODES,
  MUSIC_LEVELS,
  type AudioContainer,
  type AudioMode,
  type AudioRole,
  type MusicLevel,
} from "@/lib/video/types"
import {
  formatTime,
  narrationWindow,
  samplesToSeconds,
} from "@/lib/video/audio-timing"
import type { NarrationSummary } from "@/lib/video/render-api"
import {
  AUDIO_EXTENSIONS,
  AUDIO_LIMITS,
  DEFAULT_TIMING_FIELDS,
  formatBytes,
  MODE_NEEDS,
  sanitizeDisplayName,
  timingFromFields,
  validateAudioFile,
  type TimingFields,
} from "@/lib/video/validation"

/** An audio file chosen in the browser; uploaded (real bytes) when rendering. */
export interface StudioAudioFile {
  file: File
  /** blob: URL for the preview player; revoked when replaced or removed. */
  url: string
  name: string
  container: AudioContainer
  sizeBytes: number
  /** From the browser's player, for guidance only; null if it can't decode it. */
  durationSeconds: number | null
}

export interface StudioAudio {
  mode: AudioMode
  voiceover: StudioAudioFile | null
  music: StudioAudioFile | null
  musicLevel: MusicLevel
  /** Voiceover trim and start (DV-003D3), in seconds as typed. */
  timing: TimingFields
}

export const NO_AUDIO: StudioAudio = {
  mode: "none",
  voiceover: null,
  music: null,
  musicLevel: "low",
  timing: DEFAULT_TIMING_FIELDS,
}

const MODE_LABEL: Record<AudioMode, { label: string; hint: string }> = {
  none: { label: "No audio", hint: "A silent video, as before." },
  voiceover: {
    label: "Voiceover",
    hint: "Your narration, trimmed and started when you choose.",
  },
  music: {
    label: "Background music",
    hint: "A track that loops and fades out.",
  },
  "voiceover-and-music": {
    label: "Voiceover + music",
    hint: "Music lowered under your voice.",
  },
}

const LEVEL_LABEL: Record<MusicLevel, string> = {
  low: "Low (recommended)",
  medium: "Medium",
  high: "High",
}

const ACCEPT = [
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
  ...Object.values(AUDIO_EXTENSIONS).flatMap((list) =>
    list.map((e) => `.${e}`),
  ),
].join(",")

/** Reads a duration hint with the browser's own player (not trusted). */
function readDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const audio = new Audio()
    const done = (value: number | null) => {
      audio.removeAttribute("src")
      resolve(value)
    }
    audio.preload = "metadata"
    audio.onloadedmetadata = () =>
      done(Number.isFinite(audio.duration) ? audio.duration : null)
    audio.onerror = () => done(null)
    audio.src = url
  })
}

export async function inspectAudioFile(
  file: File,
  role: AudioRole,
): Promise<
  { ok: true; file: StudioAudioFile } | { ok: false; message: string }
> {
  const checked = validateAudioFile(file, role)
  if (!checked.ok) return { ok: false, message: checked.issues[0].message }
  const url = URL.createObjectURL(file)
  return {
    ok: true,
    file: {
      file,
      url,
      name: sanitizeDisplayName(file.name),
      container: checked.value.container,
      sizeBytes: file.size,
      durationSeconds: await readDuration(url),
    },
  }
}

function formatSeconds(value: number) {
  return `${value.toFixed(1)} s`
}

function AudioFilePicker({
  id,
  role,
  value,
  error,
  onChange,
}: {
  id: string
  role: AudioRole
  value: StudioAudioFile | null
  error?: string
  onChange: (file: StudioAudioFile | null) => void
}) {
  const [rejection, setRejection] = useState<string | null>(null)
  const label =
    role === "voiceover" ? "Voiceover file" : "Background music file"
  const Icon = role === "voiceover" ? Mic : Music
  const describedBy = [
    `${id}-hint`,
    error ? `${id}-error` : null,
    rejection ? `${id}-rejection` : null,
  ]
    .filter(Boolean)
    .join(" ")

  async function choose(list: FileList | null) {
    const file = list?.[0]
    if (!file) return
    const result = await inspectAudioFile(file, role)
    if (!result.ok) {
      setRejection(result.message)
      return
    }
    setRejection(null)
    if (value) URL.revokeObjectURL(value.url)
    onChange(result.file)
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-surface-sunken p-3 ring-1 ring-border">
      <div className="flex items-center gap-2">
        <Icon aria-hidden="true" className="size-4 text-primary" />
        <span id={`${id}-label`} className="text-sm font-medium">
          {label}
        </span>
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {role === "voiceover"
          ? `MP3, WAV or M4A, up to ${formatBytes(AUDIO_LIMITS.maxBytes)} and ${AUDIO_LIMITS.maxVoiceoverSeconds / 60} minutes. Choose the part to use and when it starts below; the file itself is never changed.`
          : `MP3 (cover art is fine), WAV or M4A, up to ${formatBytes(AUDIO_LIMITS.maxBytes)}. Loops with a short crossfade if shorter than the video, and fades out at the end.`}
      </p>

      {value ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <FileAudio
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 truncate font-medium" title={value.name}>
              {value.name}
            </span>
            <span className="text-xs text-muted-foreground">
              {value.durationSeconds === null
                ? "duration checked on render"
                : formatSeconds(value.durationSeconds)}{" "}
              · {formatBytes(value.sizeBytes)}
            </span>
          </div>
          {/* Local blob: preview with the browser's native player. */}
          <audio
            controls
            preload="metadata"
            src={value.url}
            aria-label={`Preview ${label.toLowerCase()}`}
            className="h-9 w-full"
          />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <input
          id={id}
          type="file"
          accept={ACCEPT}
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy}
          aria-invalid={error || rejection ? true : undefined}
          className="peer sr-only"
          onChange={(event) => {
            void choose(event.target.files)
            event.target.value = ""
          }}
        />
        <label
          htmlFor={id}
          aria-hidden="true"
          className={cn(
            "inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-2.5 text-sm font-medium transition-colors select-none peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50 hover:bg-muted dark:bg-input/30",
            (error || rejection) && "border-destructive",
          )}
        >
          {value ? "Replace file" : "Choose file"}
        </label>
        {value ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove ${label.toLowerCase()}`}
            onClick={() => {
              URL.revokeObjectURL(value.url)
              onChange(null)
            }}
          >
            <Trash2 aria-hidden="true" />
            Remove
          </Button>
        ) : null}
      </div>

      {rejection ? (
        <p
          id={`${id}-rejection`}
          role="alert"
          className="text-xs font-medium text-destructive"
        >
          {rejection}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

const TIMING_INPUTS = [
  {
    key: "trimStart",
    path: "audio.voiceoverTiming.trimStartMs",
    id: "voiceover-trim-start",
    label: "Trim start",
    hint: "Where the selection starts in your recording.",
    placeholder: "0",
  },
  {
    key: "trimEnd",
    path: "audio.voiceoverTiming.trimEndMs",
    id: "voiceover-trim-end",
    label: "Trim end",
    hint: "Leave empty for the end of the recording.",
    placeholder: "end",
  },
  {
    key: "offset",
    path: "audio.voiceoverTiming.offsetMs",
    id: "voiceover-offset",
    label: "Narration starts at",
    hint: "Seconds into the video; silence before it.",
    placeholder: "0",
  },
] as const

/**
 * Trim start/end and start offset for the voiceover (DV-003D3), with the
 * resulting selection length, finish time and a timeline. The numbers use
 * the same rules as the server; the server re-checks them against FFprobe's
 * duration when you render, and its approved timing is shown afterwards.
 */
function VoiceoverTimingControls({
  audio,
  onChange,
  videoSeconds,
  errorFor,
  approved,
}: {
  audio: StudioAudio
  onChange: (audio: StudioAudio) => void
  videoSeconds: number
  errorFor: (path: string) => string | undefined
  approved: NarrationSummary | null
}) {
  const parsed = timingFromFields(audio.timing)
  const duration = audio.voiceover?.durationSeconds ?? null
  const window =
    parsed.ok && duration !== null
      ? narrationWindow(parsed.value, duration, Math.round(videoSeconds * 30))
      : null
  const valid =
    window !== null && window.lengthSamples > 0 && window.trimStartSample >= 0
  const start = window ? samplesToSeconds(window.startSample) : 0
  const end = window ? samplesToSeconds(window.endSample) : 0
  const pct = (seconds: number) =>
    `${Math.min(Math.max((seconds / videoSeconds) * 100, 0), 100)}%`
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg bg-surface-sunken p-3 ring-1 ring-border">
      <legend className="sr-only">Voiceover timing</legend>
      <p
        className="flex items-center gap-2 text-sm font-medium"
        aria-hidden="true"
      >
        <Scissors className="size-4 text-primary" />
        Voiceover timing
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {TIMING_INPUTS.map((input) => {
          const error = errorFor(input.path)
          return (
            <div key={input.key} className="flex min-w-0 flex-col gap-1">
              <label htmlFor={input.id} className="text-xs font-medium">
                {input.label} (s)
              </label>
              <input
                id={input.id}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder={input.placeholder}
                value={audio.timing[input.key]}
                aria-describedby={`${input.id}-hint${error ? ` ${input.id}-error` : ""}`}
                aria-invalid={error ? true : undefined}
                onChange={(event) =>
                  onChange({
                    ...audio,
                    timing: {
                      ...audio.timing,
                      [input.key]: event.target.value,
                    },
                  })
                }
                className={cn(
                  "h-8 w-full min-w-0 rounded-lg border border-border bg-background px-2.5 text-sm tabular-nums outline-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30",
                  error && "border-destructive",
                )}
              />
              <span
                id={`${input.id}-hint`}
                className="text-[0.6875rem] text-muted-foreground"
              >
                {input.hint}
              </span>
              {error ? (
                <span
                  id={`${input.id}-error`}
                  className="text-xs font-medium text-destructive"
                >
                  {error}
                </span>
              ) : null}
            </div>
          )
        })}
      </div>

      <p className="text-xs" data-testid="narration-summary" aria-live="polite">
        {duration === null ? (
          <>The recording&apos;s length is checked when you render.</>
        ) : valid ? (
          <>
            <span className="font-medium">
              Selected {formatTime(samplesToSeconds(window!.lengthSamples))}
            </span>{" "}
            (from {formatTime(samplesToSeconds(window!.trimStartSample))} to{" "}
            {formatTime(samplesToSeconds(window!.trimEndSample))} of the{" "}
            {formatTime(duration)} recording). Narration plays from{" "}
            {formatTime(start)} and finishes at{" "}
            <span className="font-medium">{formatTime(end)}</span> of the{" "}
            {formatTime(videoSeconds)} video.
          </>
        ) : (
          <>Fix the timing above to see where the narration plays.</>
        )}
      </p>

      <div className="flex flex-col gap-1" data-testid="narration-timeline">
        <div
          role="img"
          aria-label={
            valid
              ? `Timeline: narration from ${formatTime(start)} to ${formatTime(end)} of a ${formatTime(videoSeconds)} video${audio.mode === "voiceover-and-music" ? ", music throughout" : ""}.`
              : "Timeline: narration timing not set yet."
          }
          className="relative h-7 overflow-hidden rounded-md bg-muted ring-1 ring-border"
        >
          {audio.mode === "voiceover-and-music" ? (
            <span className="absolute inset-x-0 bottom-0 h-2 bg-secondary/50" />
          ) : null}
          {valid ? (
            <span
              className={cn(
                "absolute top-0 bottom-2 rounded-sm bg-primary/80",
                end > videoSeconds + 1e-9 && "bg-destructive/80",
              )}
              style={{
                left: pct(start),
                width: `calc(${pct(Math.min(end, videoSeconds))} - ${pct(start)})`,
              }}
            />
          ) : null}
        </div>
        <div className="flex justify-between text-[0.6875rem] text-muted-foreground tabular-nums">
          <span>0 s</span>
          <span>
            {audio.mode === "voiceover-and-music"
              ? "Narration (top) · music (bottom)"
              : "Narration"}
          </span>
          <span>{formatTime(videoSeconds)}</span>
        </div>
      </div>

      {approved ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="narration-approved"
        >
          <span className="font-medium text-foreground">
            Approved by the server for the latest render:
          </span>{" "}
          narration {formatTime(approved.startSeconds)} –{" "}
          {formatTime(approved.endSeconds)} of{" "}
          {formatTime(approved.videoSeconds)} (recording{" "}
          {formatTime(approved.trimStartSeconds)} –{" "}
          {formatTime(approved.trimEndSeconds)}).
        </p>
      ) : null}
    </fieldset>
  )
}

export function audioSummary(audio: StudioAudio) {
  if (audio.mode === "none") return "No audio (silent video)."
  const format = `AAC-LC, ${AUDIO_OUTPUT.sampleRate / 1000} kHz stereo, ${AUDIO_OUTPUT.bitrate / 1000} kb/s target`
  const parts = {
    voiceover:
      "Voiceover (your selection, at your start time), loudness-normalized, silence around it",
    music:
      "Background music, looped with short crossfades to fit, fading out at the end",
    "voiceover-and-music": `Voiceover over background music (music ${audio.musicLevel}, lowered further while you speak)`,
  }
  return `${parts[audio.mode]}. ${format}.`
}

export function AudioSection({
  audio,
  onChange,
  available,
  unavailableReason,
  videoSeconds,
  errorFor,
  approved = null,
}: {
  audio: StudioAudio
  onChange: (audio: StudioAudio) => void
  /** Whether this computer's FFmpeg can render audio (from the capability check). */
  available: boolean
  unavailableReason: string | null
  videoSeconds: number
  errorFor: (path: string) => string | undefined
  /** Narration timing the server approved for the latest render, if any. */
  approved?: NarrationSummary | null
}) {
  const needs = MODE_NEEDS[audio.mode]

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Audio</legend>
        <div
          id="audio-mode"
          tabIndex={-1}
          className="grid gap-2 sm:grid-cols-2"
        >
          {AUDIO_MODES.map((mode) => {
            const disabled = mode !== "none" && !available
            const checked = audio.mode === mode
            return (
              <label
                key={mode}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-lg p-2.5 text-sm ring-1 ring-border transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring",
                  checked ? "bg-primary/10 ring-primary/50" : "hover:bg-muted",
                  disabled && "cursor-not-allowed opacity-60",
                )}
              >
                <input
                  type="radio"
                  name="audio-mode"
                  value={mode}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onChange({ ...audio, mode })}
                  className="mt-0.5 accent-(--primary)"
                />
                <span>
                  <span className="block font-medium">
                    {MODE_LABEL[mode].label}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {MODE_LABEL[mode].hint}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
        {!available ? (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-status-waiting"
            />
            <span>
              {unavailableReason ??
                "Checking whether this computer can add audio…"}
            </span>
          </p>
        ) : null}
        {errorFor("audio.mode") ? (
          <p className="text-xs font-medium text-destructive">
            {errorFor("audio.mode")}
          </p>
        ) : null}
      </fieldset>

      {needs.voiceover ? (
        <AudioFilePicker
          id="audio-voiceover"
          role="voiceover"
          value={audio.voiceover}
          error={errorFor("audio.voiceover")}
          onChange={(voiceover) => onChange({ ...audio, voiceover })}
        />
      ) : null}
      {needs.voiceover ? (
        <VoiceoverTimingControls
          audio={audio}
          onChange={onChange}
          videoSeconds={videoSeconds}
          errorFor={errorFor}
          approved={approved}
        />
      ) : null}
      {needs.music ? (
        <AudioFilePicker
          id="audio-music"
          role="music"
          value={audio.music}
          error={errorFor("audio.music")}
          onChange={(music) => onChange({ ...audio, music })}
        />
      ) : null}

      {audio.mode === "voiceover-and-music" ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 flex items-center gap-2 text-sm font-medium">
            <Scale aria-hidden="true" className="size-4 text-primary" />
            Music level under the voiceover
          </legend>
          <div className="flex flex-wrap gap-2">
            {MUSIC_LEVELS.map((level) => (
              <label
                key={level}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ring-1 ring-border has-focus-visible:ring-2 has-focus-visible:ring-ring",
                  audio.musicLevel === level
                    ? "bg-primary/10 ring-primary/50"
                    : "hover:bg-muted",
                )}
              >
                <input
                  type="radio"
                  name="music-level"
                  value={level}
                  checked={audio.musicLevel === level}
                  onChange={() => onChange({ ...audio, musicLevel: level })}
                  className="accent-(--primary)"
                />
                {LEVEL_LABEL[level]}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      {audio.mode !== "none" ? (
        <>
          <p className="text-xs text-muted-foreground">
            The video is {formatSeconds(videoSeconds)} long. Narration must end
            by then: it&apos;s refused rather than cut off. Music that&apos;s
            shorter than the video repeats with short crossfades; that smooths
            the seams but can&apos;t line up unrelated beats.
          </p>
          <p className="flex items-start gap-2 rounded-lg bg-accent/10 p-3 text-xs ring-1 ring-accent/40 ring-inset">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-accent"
            />
            <span>
              <strong className="font-semibold">
                Use only audio you have the rights to.
              </strong>{" "}
              Commercial affiliate videos need music and voice recordings you
              own or are licensed to use commercially. Deskverse doesn&apos;t
              check copyright, and files stay on this computer.
            </span>
          </p>
        </>
      ) : null}

      <p className="text-xs text-muted-foreground" data-testid="audio-summary">
        <span className="font-medium text-foreground">Audio: </span>
        {audioSummary(audio)}
      </p>
    </div>
  )
}
