"use client"

import { useState } from "react"
import { ImagePlus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { createAssetId, type AssetId } from "@/lib/video/ids"
import type { ImageMimeType } from "@/lib/video/types"
import {
  formatBytes,
  MEDIA_LIMITS,
  sanitizeDisplayName,
  validateMediaMetadata,
} from "@/lib/video/validation"

/**
 * An image chosen in the browser. The original File is kept so Render can
 * upload the real bytes (never the blob: preview URL) to the local server.
 */
export interface StudioImage {
  /** Local key for previews; the server assigns its own ID on upload. */
  id: AssetId
  file: File
  /** blob: URL for previews; revoked when the image is removed. */
  url: string
  name: string
  mimeType: ImageMimeType
  sizeBytes: number
  width: number
  height: number
}

type Inspection =
  { ok: true; image: StudioImage } | { ok: false; message: string }

/** Checks type and size before decoding, then dimensions after. */
async function inspectImage(file: File): Promise<Inspection> {
  const name = sanitizeDisplayName(file.name)
  const precheck = validateMediaMetadata({
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    width: MEDIA_LIMITS.minSide,
    height: MEDIA_LIMITS.minSide,
  })
  if (!precheck.ok) return { ok: false, message: precheck.issues[0].message }

  let width: number
  let height: number
  try {
    const bitmap = await createImageBitmap(file)
    width = bitmap.width
    height = bitmap.height
    bitmap.close()
  } catch {
    return { ok: false, message: `“${name}” couldn't be read as an image.` }
  }

  const checked = validateMediaMetadata({
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    width,
    height,
  })
  if (!checked.ok) return { ok: false, message: checked.issues[0].message }
  return {
    ok: true,
    image: {
      id: createAssetId(),
      file,
      url: URL.createObjectURL(file),
      name,
      mimeType: checked.value.mimeType,
      sizeBytes: file.size,
      width,
      height,
    },
  }
}

export function ImagePicker({
  id,
  images,
  onAdd,
  onRemove,
  error,
  onTouched,
}: {
  id: string
  images: readonly StudioImage[]
  onAdd: (images: StudioImage[]) => void
  onRemove: (id: AssetId) => void
  error?: string
  onTouched: () => void
}) {
  const [rejections, setRejections] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const full = images.length >= MEDIA_LIMITS.maxCount

  async function handleFiles(list: FileList | null) {
    onTouched()
    if (!list || list.length === 0) return
    setBusy(true)
    const files = Array.from(list)
    const room = MEDIA_LIMITS.maxCount - images.length
    const messages: string[] = []
    if (files.length > room)
      messages.push(
        `Only ${MEDIA_LIMITS.maxCount} images fit in one video, so ${files.length - room} ${files.length - room === 1 ? "was" : "were"} skipped.`,
      )
    const results = await Promise.all(files.slice(0, room).map(inspectImage))
    const accepted: StudioImage[] = []
    for (const result of results) {
      if (result.ok) accepted.push(result.image)
      else messages.push(result.message)
    }
    setRejections(messages)
    if (accepted.length > 0) onAdd(accepted)
    setBusy(false)
  }

  const describedBy = [`${id}-hint`, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ")

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm leading-none font-medium" id={`${id}-label`}>
          Product images
        </span>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {MEDIA_LIMITS.minCount}–{MEDIA_LIMITS.maxCount} JPEG, PNG or WebP
          images, up to {formatBytes(MEDIA_LIMITS.maxBytes)} each and at least{" "}
          {MEDIA_LIMITS.minSide} px per side. The first image is the hero shot.
          When you render, they&apos;re sent only to Deskverse on this computer
          and stored in its private data folder.
        </p>
      </div>

      <div>
        <input
          id={id}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          disabled={full || busy}
          className="peer sr-only"
          onChange={(event) => {
            void handleFiles(event.target.files)
            // Allow choosing the same file again after removing it.
            event.target.value = ""
          }}
        />
        <label
          htmlFor={id}
          aria-hidden="true"
          className={cn(
            "inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium transition-colors select-none peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 hover:bg-muted dark:bg-input/30",
            error && "border-destructive",
          )}
        >
          <ImagePlus aria-hidden="true" className="size-4" />
          {busy
            ? "Checking images…"
            : full
              ? "Image limit reached"
              : "Add images"}
        </label>
      </div>

      {error ? (
        <p id={`${id}-error`} className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}

      {rejections.length > 0 ? (
        <div
          role="alert"
          className="rounded-lg bg-destructive/10 p-3 text-sm text-foreground ring-1 ring-destructive/40 ring-inset"
        >
          <p className="font-medium">Some files weren&apos;t added:</p>
          <ul className="mt-1 list-disc pl-5">
            {rejections.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {images.length > 0 ? (
        <ul
          aria-label="Selected images"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3"
        >
          {images.map((image, index) => (
            <li
              key={image.id}
              className="flex flex-col overflow-hidden rounded-lg bg-surface-sunken ring-1 ring-border"
            >
              <div className="relative aspect-square">
                {/* Local blob: preview; next/image can't optimize object URLs. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.url}
                  alt={`Product image ${index + 1}: ${image.name}`}
                  className="absolute inset-0 size-full object-cover"
                />
                {index === 0 ? (
                  <span className="absolute top-1.5 left-1.5 rounded-md bg-background/90 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-foreground">
                    Hero
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-1 p-2">
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-xs font-medium"
                    title={image.name}
                  >
                    {image.name}
                  </p>
                  <p className="text-[0.6875rem] text-muted-foreground">
                    {image.width}×{image.height} ·{" "}
                    {formatBytes(image.sizeBytes)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${image.name}`}
                  onClick={() => {
                    setRejections([])
                    onRemove(image.id)
                  }}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
