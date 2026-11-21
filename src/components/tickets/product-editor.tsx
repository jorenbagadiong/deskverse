"use client"

import { useEffect, useId, useRef, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Download,
  ImagePlus,
  Link2,
  LoaderCircle,
  Plus,
  Save,
  Trash2,
  Video,
  X,
} from "lucide-react"

import {
  FormMessage,
  formatBytes,
  SelectField,
  TextArea,
  TextInput,
} from "@/components/tickets/fields"
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
import { api, issuesByPath, uploadFile } from "@/lib/tickets/client"
import {
  MEDIA_RIGHTS_LABEL,
  REFERENCE_LABEL,
  TICKET_LIMITS,
  TICKET_TEXT_LIMITS as L,
  productEndpoint,
  type ApiError,
  type MediaRights,
  type ReferenceKind,
  type TicketAsset,
  type TicketDetail,
  type TicketProduct,
} from "@/lib/tickets/types"
import {
  mediaCompleteness,
  validateProductPatch,
  validateWebUrl,
} from "@/lib/tickets/validation"
import { cn } from "@/lib/utils"

interface ReferenceDraft {
  key: string
  kind: ReferenceKind
  url: string
  label: string
}

interface ProductDraft {
  name: string
  affiliateUrl: string
  description: string
  specifications: string
  notes: string
  source: string
  mediaRights: MediaRights
  mediaRightsNote: string
  references: ReferenceDraft[]
}

let keySeed = 0
const nextKey = () => `ref-${++keySeed}`

function toDraft(product: TicketProduct): ProductDraft {
  return {
    name: product.name,
    affiliateUrl: product.affiliateUrl,
    description: product.description,
    specifications: product.specifications,
    notes: product.notes,
    source: product.source,
    mediaRights: product.mediaRights,
    mediaRightsNote: product.mediaRightsNote,
    references: product.references.map((r) => ({
      key: r.id,
      kind: r.kind,
      url: r.url,
      label: r.label,
    })),
  }
}

function payload(draft: ProductDraft) {
  return {
    ...draft,
    references: draft.references.map(({ kind, url, label }) => ({
      kind,
      url,
      label,
    })),
  }
}

const same = (a: ProductDraft, b: ProductDraft) =>
  JSON.stringify(payload(a)) === JSON.stringify(payload(b))

interface UploadState {
  key: string
  name: string
  fraction: number
  error: string | null
}

export function ProductEditor({
  ticketId,
  product,
  index,
  total,
  readOnly,
  defaultOpen,
  onTicket,
  onReload,
  onDirty,
}: {
  ticketId: string
  product: TicketProduct
  index: number
  total: number
  readOnly: boolean
  defaultOpen: boolean
  onTicket: (ticket: TicketDetail) => void
  onReload: () => Promise<void>
  onDirty: (productId: string, dirty: boolean) => void
}) {
  const uid = useId()
  const id = (name: string) => `${uid}-${name}`
  const [open, setOpen] = useState(defaultOpen)
  const [draft, setDraft] = useState<ProductDraft>(() => toDraft(product))
  const [saved, setSaved] = useState<ProductDraft>(() => toDraft(product))
  const [busy, setBusy] = useState<null | "save" | "move" | "remove">(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [uploads, setUploads] = useState<UploadState[]>([])
  const imageInput = useRef<HTMLInputElement>(null)
  const videoInput = useRef<HTMLInputElement>(null)

  const dirty = !same(draft, saved)
  useEffect(() => {
    onDirty(product.id, dirty)
  }, [dirty, onDirty, product.id])
  useEffect(() => () => onDirty(product.id, false), [onDirty, product.id])

  const set =
    <K extends keyof ProductDraft>(key: K) =>
    (value: ProductDraft[K]) => {
      setNotice(null)
      setDraft((d) => ({ ...d, [key]: value }))
    }
  const setReference = (key: string, change: Partial<ReferenceDraft>) =>
    setDraft((d) => ({
      ...d,
      references: d.references.map((r) =>
        r.key === key ? { ...r, ...change } : r,
      ),
    }))

  async function save() {
    if (busy) return
    // Instant feedback with the server's own rules (the server re-checks).
    const local = validateProductPatch(payload(draft))
    if (!local.ok) {
      setNotice(null)
      setError({
        error: "invalid",
        message: "Some fields need attention.",
        issues: local.issues,
      })
      return
    }
    setBusy("save")
    setError(null)
    setNotice(null)
    const result = await api<{ ticket: TicketDetail }>(
      productEndpoint(ticketId, product.id),
      {
        method: "PATCH",
        body: payload(draft),
      },
    )
    setBusy(null)
    if (!result.ok) {
      setError(result.error) // the draft stays exactly as typed
      return
    }
    const fresh = result.data.ticket.products.find((p) => p.id === product.id)
    if (fresh) {
      setDraft(toDraft(fresh))
      setSaved(toDraft(fresh))
    }
    setNotice("Saved.")
    onTicket(result.data.ticket)
  }

  async function move(to: number) {
    setBusy("move")
    setError(null)
    const result = await api<{ ticket: TicketDetail }>(
      productEndpoint(ticketId, product.id),
      {
        method: "PATCH",
        body: { position: to },
      },
    )
    setBusy(null)
    if (result.ok) onTicket(result.data.ticket)
    else setError(result.error)
  }

  async function remove() {
    setBusy("remove")
    setError(null)
    const result = await api<{ ticket: TicketDetail }>(
      productEndpoint(ticketId, product.id),
      { method: "DELETE" },
    )
    if (result.ok) onTicket(result.data.ticket)
    else {
      setBusy(null)
      setError(result.error)
    }
  }

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return
    const queue = Array.from(files).map((file) => ({
      file,
      key: `${file.name}-${Math.random()}`,
    }))
    setUploads((u) => [
      ...u,
      ...queue.map(({ file, key }) => ({
        key,
        name: file.name,
        fraction: 0,
        error: null,
      })),
    ])
    let anyDone = false
    for (const { file, key } of queue) {
      const result = await uploadFile<{ asset: TicketAsset }>(
        `${productEndpoint(ticketId, product.id)}/assets`,
        file,
        (fraction) =>
          setUploads((u) =>
            u.map((x) => (x.key === key ? { ...x, fraction } : x)),
          ),
      )
      if (result.ok) {
        anyDone = true
        setUploads((u) => u.filter((x) => x.key !== key))
      } else
        setUploads((u) =>
          u.map((x) =>
            x.key === key ? { ...x, error: result.error.message } : x,
          ),
        )
    }
    if (imageInput.current) imageInput.current.value = ""
    if (videoInput.current) videoInput.current.value = ""
    if (anyDone) await onReload()
  }

  async function removeAsset(asset: TicketAsset) {
    setError(null)
    const result = await api(asset.url, { method: "DELETE" })
    if (!result.ok) setError(result.error)
    await onReload()
  }

  const errors = issuesByPath(error)
  const completeness = mediaCompleteness(product.assets)
  const linkOk =
    product.affiliateUrl !== "" &&
    validateWebUrl(product.affiliateUrl, "x", "x").ok
  const title = product.name || "Untitled product"
  const images = product.assets.filter((a) => a.kind === "image")
  const videos = product.assets.filter((a) => a.kind === "video")
  const disabled = readOnly || busy !== null

  return (
    <article
      aria-labelledby={id("heading")}
      data-product-id={product.id}
      className={cn(
        "rounded-xl bg-card ring-1",
        dirty ? "ring-status-waiting/50" : "ring-border",
      )}
    >
      <header className="flex flex-wrap items-center gap-2 p-3 sm:p-4">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={id("body")}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 transition-transform motion-reduce:transition-none",
              open ? "" : "-rotate-90",
            )}
          />
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            #{index + 1}
          </span>
          <h3 id={id("heading")} className="min-w-0 truncate font-semibold">
            {title}
          </h3>
          {dirty ? (
            <span className="shrink-0 text-xs font-medium text-status-waiting">
              Unsaved
            </span>
          ) : null}
        </button>
        <ul
          aria-label={`${title}: completeness`}
          className="flex flex-wrap gap-1.5 text-xs"
        >
          <li
            className={cn(
              "rounded-full px-2 py-0.5 ring-1 ring-inset",
              linkOk
                ? "text-status-completed ring-status-completed/35"
                : "text-muted-foreground ring-border",
            )}
          >
            {linkOk ? "Affiliate link" : "No affiliate link"}
          </li>
          <li className="rounded-full px-2 py-0.5 text-muted-foreground ring-1 ring-border ring-inset">
            {completeness.images}{" "}
            {completeness.images === 1 ? "image" : "images"}
            {completeness.videos > 0
              ? `, ${completeness.videos} ${completeness.videos === 1 ? "clip" : "clips"}`
              : ""}
          </li>
        </ul>
        <div className="flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${title} up`}
            disabled={disabled || index === 0}
            onClick={() => void move(index - 1)}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${title} down`}
            disabled={disabled || index === total - 1}
            onClick={() => void move(index + 1)}
          >
            <ArrowDown aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div
        id={id("body")}
        hidden={!open}
        className="flex flex-col gap-5 border-t border-border p-3 sm:p-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput
            id={id("name")}
            label="Product name"
            value={draft.name}
            onChange={set("name")}
            max={L.productName}
            error={errors.name}
            disabled={disabled}
          />
          <TextInput
            id={id("affiliate")}
            label="Affiliate link"
            type="url"
            inputMode="url"
            value={draft.affiliateUrl}
            onChange={set("affiliateUrl")}
            error={errors.affiliateUrl}
            hint="Your tracking link (https://…). Stored only; Deskverse doesn't open it."
            disabled={disabled}
          />
        </div>
        <TextArea
          id={id("description")}
          label="Description"
          value={draft.description}
          onChange={set("description")}
          max={L.productText}
          error={errors.description}
          disabled={disabled}
        />
        <TextArea
          id={id("specifications")}
          label="Specifications and facts"
          value={draft.specifications}
          onChange={set("specifications")}
          max={L.productText}
          error={errors.specifications}
          hint="Only facts you can back up; future workers must not invent claims."
          disabled={disabled}
        />
        <TextArea
          id={id("notes")}
          label="Notes"
          value={draft.notes}
          onChange={set("notes")}
          max={L.productText}
          error={errors.notes}
          disabled={disabled}
          rows={2}
        />

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 flex items-center gap-1.5 text-sm font-medium">
            <Link2 aria-hidden="true" className="size-4" />
            Reference links ({draft.references.length}/
            {TICKET_LIMITS.referencesPerProduct})
          </legend>
          {draft.references.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Listing pages, specifications, reviews or demo videos for future
              research.
            </p>
          ) : null}
          <ul className="flex flex-col gap-3">
            {draft.references.map((ref, i) => (
              <li
                key={ref.key}
                className="grid gap-2 rounded-lg p-2 ring-1 ring-border sm:grid-cols-[12rem_1fr_10rem_auto] sm:items-start"
              >
                <SelectField
                  id={id(`ref-${ref.key}-kind`)}
                  label={`Link ${i + 1} type`}
                  value={ref.kind}
                  onChange={(kind) => setReference(ref.key, { kind })}
                  options={REFERENCE_LABEL}
                  error={errors[`references.${i}.kind`]}
                  disabled={disabled}
                />
                <TextInput
                  id={id(`ref-${ref.key}-url`)}
                  label={`Link ${i + 1} address`}
                  type="url"
                  inputMode="url"
                  value={ref.url}
                  onChange={(url) => setReference(ref.key, { url })}
                  error={errors[`references.${i}.url`]}
                  disabled={disabled}
                />
                <TextInput
                  id={id(`ref-${ref.key}-label`)}
                  label={`Link ${i + 1} label`}
                  value={ref.label}
                  onChange={(label) => setReference(ref.key, { label })}
                  max={L.referenceLabel}
                  error={errors[`references.${i}.label`]}
                  disabled={disabled}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="sm:mt-6"
                  aria-label={`Remove link ${i + 1}`}
                  disabled={disabled}
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      references: d.references.filter((r) => r.key !== ref.key),
                    }))
                  }
                >
                  <X aria-hidden="true" />
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            disabled={
              disabled ||
              draft.references.length >= TICKET_LIMITS.referencesPerProduct
            }
            onClick={() =>
              setDraft((d) => ({
                ...d,
                references: [
                  ...d.references,
                  { key: nextKey(), kind: "listing", url: "", label: "" },
                ],
              }))
            }
          >
            <Plus aria-hidden="true" />
            Add reference link
          </Button>
        </fieldset>

        <fieldset className="grid gap-4 rounded-lg p-3 ring-1 ring-border">
          <legend className="px-1 text-sm font-medium">
            Source and media rights
          </legend>
          <TextArea
            id={id("source")}
            label="Where this information and media came from"
            value={draft.source}
            onChange={set("source")}
            max={L.source}
            error={errors.source}
            disabled={disabled}
            rows={2}
          />
          <SelectField
            id={id("rights")}
            label="Media usage rights"
            value={draft.mediaRights}
            onChange={set("mediaRights")}
            options={MEDIA_RIGHTS_LABEL}
            error={errors.mediaRights}
            disabled={disabled}
            hint="Only upload media you're allowed to republish."
          />
          <TextInput
            id={id("rights-note")}
            label="Rights note"
            value={draft.mediaRightsNote}
            onChange={set("mediaRightsNote")}
            max={L.mediaRightsNote}
            error={errors.mediaRightsNote}
            disabled={disabled}
            placeholder="e.g. Brand kit from the affiliate program, March 2026"
          />
        </fieldset>

        {error ? (
          <FormMessage>
            <p className="font-semibold">
              {error.issues?.length
                ? "Some fields need attention."
                : "That didn't work."}
            </p>
            <p className="mt-1">
              {error.issues?.length
                ? "Fix the highlighted fields, then save again. Nothing you typed was lost."
                : error.message}
            </p>
          </FormMessage>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            onClick={() => void save()}
            disabled={disabled || !dirty}
          >
            {busy === "save" ? (
              <LoaderCircle
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
              />
            ) : (
              <Save aria-hidden="true" />
            )}
            {busy === "save" ? "Saving…" : "Save product"}
          </Button>
          {dirty ? (
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                setDraft(saved)
                setError(null)
              }}
            >
              Discard changes
            </Button>
          ) : null}
          <span role="status" className="text-sm text-status-completed">
            {notice}
          </span>
        </div>

        <section
          aria-labelledby={id("media")}
          className="flex flex-col gap-3 border-t border-border pt-4"
        >
          <h4 id={id("media")} className="text-sm font-semibold">
            Media
          </h4>
          <p className="text-xs text-muted-foreground">
            Images: JPEG, PNG or WebP, up to 10 MB, at least 320 px. Clips: MP4,
            stored as reference material for now (Pixel doesn&apos;t render
            clips yet).
            {completeness.pixelReady
              ? " Enough images for a Pixel video."
              : ` Pixel will need at least 3 images to render (${completeness.images} so far).`}
          </p>
          {images.length + videos.length > 0 ? (
            <ul
              aria-label={`${title} media`}
              className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
            >
              {[...images, ...videos].map((asset, i) => (
                <li
                  key={asset.id}
                  className="flex min-w-0 flex-col gap-1.5 rounded-lg p-2 ring-1 ring-border"
                >
                  {asset.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element -- private, same-origin media; no optimisation wanted
                    <img
                      src={asset.url}
                      alt={`${title}, image ${i + 1}${asset.displayName ? ` (${asset.displayName})` : ""}`}
                      loading="lazy"
                      className="aspect-square w-full rounded-md bg-muted object-cover"
                    />
                  ) : (
                    <video
                      src={asset.url}
                      controls
                      preload="metadata"
                      aria-label={`${title}, video clip ${i - images.length + 1}`}
                      className="aspect-square w-full rounded-md bg-muted object-cover"
                    />
                  )}
                  <p className="truncate text-xs" title={asset.displayName}>
                    {asset.displayName}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {asset.width}×{asset.height} ·{" "}
                    {formatBytes(asset.sizeBytes)}
                    {asset.durationSeconds !== null
                      ? ` · ${asset.durationSeconds.toFixed(1)} s`
                      : ""}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    <Button asChild variant="ghost" size="xs">
                      <a
                        href={`${asset.url}?download=1`}
                        aria-label={`Download ${asset.displayName}`}
                      >
                        <Download aria-hidden="true" />
                        Download
                      </a>
                    </Button>
                    {!readOnly ? (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            aria-label={`Remove ${asset.displayName}`}
                          >
                            <Trash2 aria-hidden="true" />
                            Remove
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              Remove “{asset.displayName}”?
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              The file is deleted from this computer. This
                              can&apos;t be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Keep it</AlertDialogCancel>
                            <AlertDialogAction
                              variant="destructive"
                              onClick={() => void removeAsset(asset)}
                            >
                              Remove file
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {uploads.length > 0 ? (
            <ul aria-label="Uploads" className="flex flex-col gap-2">
              {uploads.map((u) => (
                <li key={u.key} className="flex flex-col gap-1 text-sm">
                  <span className="truncate">{u.name}</span>
                  {u.error ? (
                    <span
                      role="alert"
                      className="flex items-start gap-2 text-status-failed"
                    >
                      <span>{u.error}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          setUploads((x) => x.filter((y) => y.key !== u.key))
                        }
                      >
                        Dismiss
                      </Button>
                    </span>
                  ) : (
                    <progress
                      max={1}
                      value={u.fraction}
                      aria-label={`Uploading ${u.name}`}
                      className="h-2 w-full accent-primary"
                    />
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {!readOnly ? (
            <div className="flex flex-wrap gap-2">
              <input
                ref={imageInput}
                id={id("images")}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="sr-only"
                onChange={(e) => void upload(e.target.files)}
                aria-label={`Upload images for ${title}`}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => imageInput.current?.click()}
              >
                <ImagePlus aria-hidden="true" />
                Upload images
              </Button>
              <input
                ref={videoInput}
                id={id("video")}
                type="file"
                accept="video/mp4"
                className="sr-only"
                onChange={(e) => void upload(e.target.files)}
                aria-label={`Upload a video clip for ${title}`}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => videoInput.current?.click()}
              >
                <Video aria-hidden="true" />
                Upload video clip
              </Button>
            </div>
          ) : null}
        </section>

        {!readOnly ? (
          <div className="border-t border-border pt-4">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={busy !== null}
                >
                  <Trash2 aria-hidden="true" />
                  Remove product
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove “{title}”?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Its details, {product.references.length} reference{" "}
                    {product.references.length === 1 ? "link" : "links"} and{" "}
                    {product.assets.length} media{" "}
                    {product.assets.length === 1 ? "file" : "files"} are removed
                    from this ticket and the files deleted from this computer.
                    The ticket itself stays.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() => void remove()}
                  >
                    Remove product
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ) : null}
      </div>
    </article>
  )
}
