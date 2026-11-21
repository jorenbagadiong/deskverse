"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useRef, useState } from "react"
import { LoaderCircle, Save } from "lucide-react"

import {
  FormMessage,
  SelectField,
  TextArea,
  TextInput,
} from "@/components/tickets/fields"
import { Button } from "@/components/ui/button"
import { api, issuesByPath, newRequestId } from "@/lib/tickets/client"
import { validateTicketPatch } from "@/lib/tickets/validation"
import {
  PLATFORM_LABEL,
  PRIORITY_LABEL,
  TICKET_TEXT_LIMITS as L,
  TICKETS_ENDPOINT,
  type ApiError,
  type TicketDetail,
  type TicketPlatform,
  type TicketPriority,
} from "@/lib/tickets/types"

export interface TicketDraft {
  title: string
  description: string
  instructions: string
  priority: TicketPriority
  platform: TicketPlatform
  schedule: string
  publishingNotes: string
}

export const EMPTY_TICKET: TicketDraft = {
  title: "",
  description: "",
  instructions: "",
  priority: "normal",
  platform: "tiktok",
  schedule: "",
  publishingNotes: "",
}

export function draftFromTicket(ticket: TicketDetail): TicketDraft {
  return {
    title: ticket.title,
    description: ticket.description,
    instructions: ticket.instructions,
    priority: ticket.priority,
    platform: ticket.platform,
    schedule: ticket.publishingPreferences.schedule,
    publishingNotes: ticket.publishingPreferences.notes,
  }
}

export function fieldsFromDraft(draft: TicketDraft) {
  return {
    title: draft.title,
    description: draft.description,
    instructions: draft.instructions,
    priority: draft.priority,
    platform: draft.platform,
    publishingPreferences: {
      schedule: draft.schedule,
      notes: draft.publishingNotes,
    },
  }
}

/** The ticket's own fields. Controlled: the parent keeps the draft. */
export function TicketFields({
  idPrefix,
  draft,
  onChange,
  errors,
  disabled,
}: {
  idPrefix: string
  draft: TicketDraft
  onChange: (draft: TicketDraft) => void
  errors: Record<string, string>
  disabled?: boolean
}) {
  const set =
    <K extends keyof TicketDraft>(key: K) =>
    (value: TicketDraft[K]) =>
      onChange({ ...draft, [key]: value })
  return (
    <div className="grid gap-4">
      <TextInput
        id={`${idPrefix}-title`}
        label="Title"
        required
        value={draft.title}
        onChange={set("title")}
        max={L.title}
        error={errors.title}
        hint="A name you'll recognise, like “November kitchen campaign”."
        disabled={disabled}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id={`${idPrefix}-platform`}
          label="Target platform"
          value={draft.platform}
          onChange={set("platform")}
          options={PLATFORM_LABEL}
          error={errors.platform}
          disabled={disabled}
        />
        <SelectField
          id={`${idPrefix}-priority`}
          label="Priority"
          value={draft.priority}
          onChange={set("priority")}
          options={PRIORITY_LABEL}
          error={errors.priority}
          disabled={disabled}
        />
      </div>
      <TextArea
        id={`${idPrefix}-description`}
        label="Description"
        value={draft.description}
        onChange={set("description")}
        max={L.description}
        error={errors.description}
        hint="What this ticket is for."
        disabled={disabled}
      />
      <TextArea
        id={`${idPrefix}-instructions`}
        label="Instructions for the team"
        value={draft.instructions}
        onChange={set("instructions")}
        max={L.instructions}
        error={errors.instructions}
        hint="Tone, must-mention points, things to avoid. Saved for future workers; nothing runs yet."
        disabled={disabled}
        rows={4}
      />
      <fieldset className="grid gap-4 rounded-lg p-3 ring-1 ring-border">
        <legend className="px-1 text-sm font-medium">
          Publishing preferences
        </legend>
        <p className="-mt-2 text-xs text-muted-foreground">
          Saved as notes only. Nothing is scheduled or published from here.
        </p>
        <TextInput
          id={`${idPrefix}-schedule`}
          label="Schedule"
          value={draft.schedule}
          onChange={set("schedule")}
          max={L.schedule}
          error={errors["publishingPreferences.schedule"]}
          placeholder="e.g. One approved video per day"
          disabled={disabled}
        />
        <TextArea
          id={`${idPrefix}-publishing-notes`}
          label="Publishing notes"
          value={draft.publishingNotes}
          onChange={set("publishingNotes")}
          max={L.publishingNotes}
          error={errors["publishingPreferences.notes"]}
          disabled={disabled}
          rows={2}
        />
      </fieldset>
    </div>
  )
}

/** /tickets/new: creates a Draft ticket, then opens its workspace. */
export function NewTicketForm() {
  const router = useRouter()
  const [draft, setDraft] = useState<TicketDraft>(EMPTY_TICKET)
  // One request ID per form, made on the first submit (not during render,
  // which may be prerendered) and reused by retries, so a retry after a
  // timeout can't create a second ticket.
  const requestId = useRef<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (saving) return
    // Instant feedback with the server's own rules (the server re-checks).
    const local = validateTicketPatch(fieldsFromDraft(draft))
    if (!local.ok) {
      setError({
        error: "invalid",
        message: "Some fields need attention.",
        issues: local.issues,
      })
      return
    }
    setSaving(true)
    setError(null)
    const result = await api<{ ticket: TicketDetail }>(TICKETS_ENDPOINT, {
      method: "POST",
      body: {
        requestId: (requestId.current ??= newRequestId()),
        ...fieldsFromDraft(draft),
      },
    })
    if (result.ok) {
      router.push(`/tickets/${result.data.ticket.id}`)
      return
    }
    // Keep everything typed so far; show what went wrong.
    setError(result.error)
    setSaving(false)
  }

  const errors = issuesByPath(error)
  return (
    <form
      onSubmit={save}
      noValidate
      className="flex max-w-3xl flex-col gap-5"
      aria-describedby={error ? "new-ticket-error" : undefined}
    >
      <TicketFields
        idPrefix="ticket"
        draft={draft}
        onChange={setDraft}
        errors={errors}
        disabled={saving}
      />
      {error ? (
        <FormMessage id="new-ticket-error">
          <p className="font-semibold">The ticket wasn&apos;t saved.</p>
          <p className="mt-1">
            {error.issues?.length
              ? "Fix the highlighted fields, then save again."
              : error.message}
          </p>
        </FormMessage>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" size="lg" disabled={saving}>
          {saving ? (
            <LoaderCircle
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
          ) : (
            <Save aria-hidden="true" />
          )}
          {saving ? "Saving…" : "Save Draft"}
        </Button>
        <Button asChild variant="outline" size="lg">
          <Link href="/tickets">Cancel</Link>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Saving creates a Draft. You add products, links and media next. Nothing
        is sent to the AI team yet.
      </p>
    </form>
  )
}
