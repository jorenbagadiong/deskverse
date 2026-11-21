"use client"

import { TriangleAlert } from "lucide-react"

import { cn } from "@/lib/utils"
import { MOTION_LABELS, TRANSITION_LABELS } from "@/lib/video/effects"
import {
  MOTION_STYLES,
  TRANSITION_STYLES,
  type VisualEffects,
} from "@/lib/video/types"

/** Whether this computer's FFmpeg has each effect's filters; null = not checked yet. */
export interface EffectAvailability {
  gentleZoom: boolean
  crossfade: boolean
}

function Choice({
  name,
  value,
  checked,
  disabled,
  label,
  hint,
  onSelect,
}: {
  name: string
  value: string
  checked: boolean
  disabled: boolean
  label: string
  hint: string
  onSelect: () => void
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded-lg p-2.5 text-sm ring-1 ring-border has-focus-visible:ring-2 has-focus-visible:ring-ring motion-safe:transition-colors",
        checked ? "bg-primary/10 ring-primary/50" : "hover:bg-muted",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="mt-0.5 accent-(--primary)"
      />
      <span>
        <span className="block font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
}

/**
 * Two named choices (DV-003D2). The browser sends only these names; the
 * zoom amount, crossfade length and FFmpeg filters are fixed on the server.
 */
export function EffectsSection({
  effects,
  onChange,
  availability,
  errorFor,
}: {
  effects: VisualEffects
  onChange: (next: VisualEffects) => void
  availability: EffectAvailability | null
  errorFor: (path: string) => string | undefined
}) {
  const zoomOff = availability !== null && !availability.gentleZoom
  const fadeOff = availability !== null && !availability.crossfade
  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Product motion</legend>
        <div
          id="effects-motion"
          tabIndex={-1}
          className="grid gap-2 sm:grid-cols-2"
        >
          {MOTION_STYLES.map((motion) => (
            <Choice
              key={motion}
              name="effects-motion"
              value={motion}
              checked={effects.motion === motion}
              disabled={motion === "gentle-zoom" && zoomOff}
              label={MOTION_LABELS[motion].label}
              hint={MOTION_LABELS[motion].description}
              onSelect={() => onChange({ ...effects, motion })}
            />
          ))}
        </div>
        {errorFor("effects.motion") ? (
          <p className="text-xs font-medium text-destructive">
            {errorFor("effects.motion")}
          </p>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Scene transitions</legend>
        <div
          id="effects-transition"
          tabIndex={-1}
          className="grid gap-2 sm:grid-cols-2"
        >
          {TRANSITION_STYLES.map((transition) => (
            <Choice
              key={transition}
              name="effects-transition"
              value={transition}
              checked={effects.transition === transition}
              disabled={transition === "crossfade" && fadeOff}
              label={TRANSITION_LABELS[transition].label}
              hint={TRANSITION_LABELS[transition].description}
              onSelect={() => onChange({ ...effects, transition })}
            />
          ))}
        </div>
        {errorFor("effects.transition") ? (
          <p className="text-xs font-medium text-destructive">
            {errorFor("effects.transition")}
          </p>
        ) : null}
      </fieldset>

      {zoomOff || fadeOff ? (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-status-waiting"
          />
          <span>
            This FFmpeg build lacks the filters for{" "}
            {[zoomOff && "gentle zoom", fadeOff && "crossfades"]
              .filter(Boolean)
              .join(" and ")}
            . Still photos and cuts always work.
          </span>
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Effects are added when the MP4 is rendered; the storyboard preview stays
        still. Your device&apos;s reduce-motion setting calms this page, not the
        video file. Choose None and Cuts for a fully static video.
      </p>
    </div>
  )
}
