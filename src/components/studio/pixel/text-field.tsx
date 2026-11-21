"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { codePointLength, normalizeText } from "@/lib/video/validation"

/**
 * Labelled text input with a live character count and an inline error.
 * The hint, count and error are all wired to the control via
 * aria-describedby, and aria-invalid flags it when the error is shown.
 */
export function TextField({
  id,
  label,
  value,
  onChange,
  onBlur,
  max,
  error,
  hint,
  multiline = false,
  placeholder,
  className,
  labelClassName,
  action,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  max: number
  error?: string
  hint?: string
  multiline?: boolean
  placeholder?: string
  className?: string
  labelClassName?: string
  /** Extra control beside the label (e.g. a Remove button). */
  action?: React.ReactNode
}) {
  const length = codePointLength(normalizeText(value))
  const over = length > max
  const describedBy = [
    hint ? `${id}-hint` : null,
    `${id}-count`,
    error ? `${id}-error` : null,
  ]
    .filter(Boolean)
    .join(" ")
  const shared = {
    id,
    value,
    placeholder,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    onBlur,
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <Label htmlFor={id} className={labelClassName}>
          {label}
        </Label>
        {action}
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {multiline ? (
        <Textarea
          {...shared}
          rows={2}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          {...shared}
          type="text"
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <div className="flex items-start justify-between gap-3 text-xs">
        {error ? (
          <p id={`${id}-error`} className="font-medium text-destructive">
            {error}
          </p>
        ) : (
          <span />
        )}
        <span
          id={`${id}-count`}
          className={cn(
            "shrink-0 font-mono tabular-nums",
            over ? "font-semibold text-destructive" : "text-muted-foreground",
          )}
        >
          <span className="sr-only">Characters used: </span>
          {length}/{max}
        </span>
      </div>
    </div>
  )
}
