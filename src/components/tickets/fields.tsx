"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  PRIORITY_LABEL,
  STATUS_LABEL,
  type TicketPriority,
  type TicketStatus,
} from "@/lib/tickets/types"
import { cn } from "@/lib/utils"

/**
 * Labelled form controls for Affiliate Tickets. Hints, live character
 * counts and errors are wired to the control with aria-describedby, and
 * aria-invalid marks a field with an error.
 */

const count = (text: string) => Array.from(text.trim()).length

function describedBy(id: string, hint?: string, error?: string, max?: number) {
  return (
    [
      hint ? `${id}-hint` : null,
      max ? `${id}-count` : null,
      error ? `${id}-error` : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined
  )
}

function Meta({
  id,
  hint,
  error,
  value,
  max,
}: {
  id: string
  hint?: string
  error?: string
  value: string
  max?: number
}) {
  const length = count(value)
  return (
    <>
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="text-sm font-medium text-status-failed"
        >
          {error}
        </p>
      ) : null}
      {max ? (
        <p
          id={`${id}-count`}
          className={cn(
            "self-end text-xs tabular-nums",
            length > max
              ? "font-semibold text-status-failed"
              : "text-muted-foreground",
          )}
        >
          <span className="sr-only">Characters used: </span>
          {length}/{max}
        </p>
      ) : null}
    </>
  )
}

export function TextInput({
  id,
  label,
  value,
  onChange,
  max,
  error,
  hint,
  disabled,
  type = "text",
  placeholder,
  required,
  inputMode,
  className,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  max?: number
  error?: string
  hint?: string
  disabled?: boolean
  type?: "text" | "url" | "search"
  placeholder?: string
  required?: boolean
  inputMode?: "url" | "text"
  className?: string
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden="true" className="text-status-failed">
            *
          </span>
        ) : null}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        required={required}
        inputMode={inputMode}
        spellCheck={type === "url" ? false : undefined}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error, max)}
      />
      <Meta id={id} hint={hint} error={error} value={value} max={max} />
    </div>
  )
}

export function TextArea({
  id,
  label,
  value,
  onChange,
  max,
  error,
  hint,
  disabled,
  rows = 3,
  placeholder,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  max?: number
  error?: string
  hint?: string
  disabled?: boolean
  rows?: number
  placeholder?: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error, max)}
      />
      <Meta id={id} hint={hint} error={error} value={value} max={max} />
    </div>
  )
}

export function SelectField<T extends string>({
  id,
  label,
  value,
  onChange,
  options,
  disabled,
  error,
  hint,
}: {
  id: string
  label: string
  value: T
  onChange: (value: T) => void
  options: Record<T, string>
  disabled?: boolean
  error?: string
  hint?: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive dark:bg-input/30 [&>option]:bg-popover [&>option]:text-popover-foreground"
      >
        {(Object.keys(options) as T[]).map((key) => (
          <option key={key} value={key}>
            {options[key]}
          </option>
        ))}
      </select>
      <Meta id={id} hint={hint} error={error} value="" />
    </div>
  )
}

const STATUS_CLASSES: Record<TicketStatus, string> = {
  draft: "text-status-idle bg-status-idle/12 ring-status-idle/30",
  ready:
    "text-status-completed bg-status-completed/12 ring-status-completed/35",
  archived: "text-muted-foreground bg-muted ring-border",
}

export function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span
      data-ticket-status={status}
      className={cn(
        "inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ring-1 ring-inset",
        STATUS_CLASSES[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  )
}

export function PriorityLabel({ priority }: { priority: TicketPriority }) {
  return (
    <span
      className={cn(
        "text-sm whitespace-nowrap",
        priority === "high"
          ? "font-semibold text-status-waiting"
          : "text-muted-foreground",
      )}
    >
      {PRIORITY_LABEL[priority]}
    </span>
  )
}

/** An error or notice box for a whole form (role=alert so it is announced). */
export function FormMessage({
  tone = "error",
  children,
  id,
}: {
  tone?: "error" | "info"
  children: React.ReactNode
  id?: string
}) {
  return (
    <div
      id={id}
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-lg p-3 text-sm ring-1 ring-inset",
        tone === "error"
          ? "bg-status-failed/10 text-foreground ring-status-failed/40"
          : "bg-status-info/10 ring-status-info/35",
      )}
    >
      {children}
    </div>
  )
}

export function formatDate(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso))
}

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
