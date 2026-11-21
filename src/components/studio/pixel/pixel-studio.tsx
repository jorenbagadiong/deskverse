"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { CircleCheck, ListChecks, Plus, Trash2 } from "lucide-react"

import { FfmpegStatus } from "@/components/studio/pixel/ffmpeg-status"
import { FormatSummary } from "@/components/studio/pixel/format-summary"
import {
  ImagePicker,
  type StudioImage,
} from "@/components/studio/pixel/image-picker"
import { RenderPanel } from "@/components/studio/pixel/render-panel"
import { StoryboardPreview } from "@/components/studio/pixel/storyboard-preview"
import { TextField } from "@/components/studio/pixel/text-field"
import { useRenderJob } from "@/components/studio/pixel/use-render-job"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card"
import { formatDuration } from "@/lib/video/format"
import type { AssetId } from "@/lib/video/ids"
import { buildStoryboard, storyboardFrames } from "@/lib/video/storyboard"
import {
  BENEFIT_COUNT,
  DEFAULT_DISCLOSURE,
  MEDIA_LIMITS,
  normalizeText,
  TEXT_LIMITS,
  validateProduct,
  type ValidationIssue,
} from "@/lib/video/validation"

interface BenefitRow {
  key: number
  text: string
}

const IMAGES_FIELD = "product-images"
const FIELD_IDS: Record<string, string> = {
  name: "product-name",
  headline: "video-headline",
  benefits: "add-benefit",
  callToAction: "call-to-action",
  disclosure: "affiliate-disclosure",
  images: IMAGES_FIELD,
}

const benefitFieldId = (row: BenefitRow) => `benefit-${row.key}`

export function PixelStudio() {
  const [name, setName] = useState("")
  const [headline, setHeadline] = useState("")
  const [benefits, setBenefits] = useState<BenefitRow[]>([{ key: 1, text: "" }])
  const [callToAction, setCallToAction] = useState("")
  const [disclosure, setDisclosure] = useState(DEFAULT_DISCLOSURE)
  const [images, setImages] = useState<StudioImage[]>([])
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const [attempts, setAttempts] = useState(0)
  const [ffmpegReady, setFfmpegReady] = useState(false)
  const nextBenefitKey = useRef(2)
  const summaryRef = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<string | null>(null)

  // --- Validation -----------------------------------------------------------

  const productResult = useMemo(
    () =>
      validateProduct({
        name,
        headline,
        benefits: benefits.map((b) => b.text),
        callToAction,
        disclosure,
      }),
    [name, headline, benefits, callToAction, disclosure],
  )
  const issues: ValidationIssue[] = useMemo(() => {
    const list = productResult.ok ? [] : [...productResult.issues]
    // Keep the summary in form order: the image picker follows the name.
    if (images.length < MEDIA_LIMITS.minCount)
      list.splice(list[0]?.path === "name" ? 1 : 0, 0, {
        path: "images",
        message: `Add at least ${MEDIA_LIMITS.minCount} product images (${images.length} added).`,
      })
    return list
  }, [productResult, images.length])
  const errorFor = (path: string) =>
    attempts > 0 || touched.has(path)
      ? issues.find((issue) => issue.path === path)?.message
      : undefined
  const touch = (path: string) =>
    setTouched((current) =>
      current.has(path) ? current : new Set(current).add(path),
    )
  const complete = issues.length === 0
  const render = useRenderJob()
  const canRender = complete && ffmpegReady && productResult.ok

  function startRender() {
    if (!canRender || !productResult.ok || render.busy) return
    // The server re-validates the text and rebuilds the storyboard itself.
    void render.start(productResult.value, images)
  }

  const fieldIdFor = (path: string) => {
    const benefit = /^benefits\.(\d+)$/.exec(path)
    if (benefit) {
      const row = benefits[Number(benefit[1])]
      return row ? benefitFieldId(row) : FIELD_IDS.benefits
    }
    return FIELD_IDS[path] ?? FIELD_IDS.name
  }

  // --- Storyboard (placeholders fill empty fields so the preview always shows) --

  const scenes = useMemo(
    () =>
      buildStoryboard(
        {
          name: normalizeText(name) || "Product name",
          headline: normalizeText(headline) || "Your headline",
          benefits: benefits.map(
            (b, i) => normalizeText(b.text) || `Benefit ${i + 1}`,
          ),
          callToAction: normalizeText(callToAction) || "Call to action",
          disclosure: normalizeText(disclosure),
        },
        images.map((image) => image.id),
      ),
    [name, headline, benefits, callToAction, disclosure, images],
  )
  const imageUrls = useMemo(
    () => new Map(images.map((image) => [image.id as string, image.url])),
    [images],
  )

  // --- Effects --------------------------------------------------------------

  // Revoke preview URLs when leaving the page.
  const imagesRef = useRef(images)
  useEffect(() => {
    imagesRef.current = images
  }, [images])
  useEffect(
    () => () => {
      for (const image of imagesRef.current) URL.revokeObjectURL(image.url)
    },
    [],
  )

  // Focus the problem summary after a failed check.
  useEffect(() => {
    if (attempts > 0) summaryRef.current?.focus()
  }, [attempts])

  // Focus a newly added benefit field.
  useEffect(() => {
    if (!pendingFocus.current) return
    document.getElementById(pendingFocus.current)?.focus()
    pendingFocus.current = null
  }, [benefits])

  // --- Handlers -------------------------------------------------------------

  function addImages(added: StudioImage[]) {
    const room = MEDIA_LIMITS.maxCount - images.length
    for (const extra of added.slice(Math.max(room, 0)))
      URL.revokeObjectURL(extra.url)
    setImages([...images, ...added.slice(0, Math.max(room, 0))])
  }

  function removeImage(id: AssetId) {
    const image = images.find((i) => i.id === id)
    if (image) URL.revokeObjectURL(image.url)
    setImages(images.filter((i) => i.id !== id))
    touch("images")
  }

  function addBenefit() {
    if (benefits.length >= BENEFIT_COUNT.max) return
    const row = { key: nextBenefitKey.current++, text: "" }
    pendingFocus.current = benefitFieldId(row)
    setBenefits([...benefits, row])
  }

  function removeBenefit(key: number) {
    const index = benefits.findIndex((b) => b.key === key)
    const next = benefits.filter((b) => b.key !== key)
    // Keep focus in the list: move to the previous benefit (or the first one).
    const target = next[Math.max(index - 1, 0)]
    if (target) pendingFocus.current = benefitFieldId(target)
    setBenefits(next)
  }

  function check(event: React.FormEvent) {
    event.preventDefault()
    setAttempts((n) => n + 1)
  }

  // --- Render ---------------------------------------------------------------

  return (
    <div className="grid gap-6 pb-section lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-start">
      <form
        noValidate
        onSubmit={check}
        aria-label="Video details"
        className="flex min-w-0 flex-col gap-6"
      >
        <Card>
          <CardHeader>
            <h2 className="text-title">Product</h2>
            <CardDescription>What you&apos;re promoting.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <TextField
              id={FIELD_IDS.name}
              label="Product name"
              value={name}
              onChange={setName}
              onBlur={() => touch("name")}
              max={TEXT_LIMITS.name}
              error={errorFor("name")}
              placeholder="e.g. Trailblazer travel mug"
            />
            <ImagePicker
              id={IMAGES_FIELD}
              images={images}
              onAdd={addImages}
              onRemove={removeImage}
              onTouched={() => touch("images")}
              error={errorFor("images")}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-title">Script</h2>
            <CardDescription>
              One short line per scene. Captions are single lines; extra spaces
              and line breaks are removed.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <TextField
              id={FIELD_IDS.headline}
              label="Video headline"
              hint="Opens the video over the hero image."
              value={headline}
              onChange={setHeadline}
              onBlur={() => touch("headline")}
              max={TEXT_LIMITS.headline}
              error={errorFor("headline")}
              placeholder="e.g. Hot coffee for 12 hours"
            />

            <fieldset className="flex flex-col gap-4">
              <legend className="mb-1 text-sm font-medium">
                Product benefit captions{" "}
                <span className="font-normal text-muted-foreground">
                  ({benefits.length} of {BENEFIT_COUNT.max}, one scene each)
                </span>
              </legend>
              {benefits.map((row, index) => (
                <TextField
                  key={row.key}
                  id={benefitFieldId(row)}
                  label={`Benefit ${index + 1}`}
                  labelClassName="font-normal"
                  value={row.text}
                  onChange={(text) =>
                    setBenefits((current) =>
                      current.map((b) =>
                        b.key === row.key ? { ...b, text } : b,
                      ),
                    )
                  }
                  onBlur={() => touch(`benefits.${index}`)}
                  max={TEXT_LIMITS.benefit}
                  error={errorFor(`benefits.${index}`)}
                  placeholder={
                    index === 0 ? "e.g. Leak-proof lid for your bag" : undefined
                  }
                  action={
                    benefits.length > BENEFIT_COUNT.min ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove benefit ${index + 1}`}
                        onClick={() => removeBenefit(row.key)}
                      >
                        <Trash2 aria-hidden="true" />
                        Remove
                      </Button>
                    ) : null
                  }
                />
              ))}
              <Button
                id={FIELD_IDS.benefits}
                type="button"
                variant="outline"
                className="self-start"
                disabled={benefits.length >= BENEFIT_COUNT.max}
                onClick={addBenefit}
              >
                <Plus aria-hidden="true" />
                Add benefit
              </Button>
            </fieldset>

            <TextField
              id={FIELD_IDS.callToAction}
              label="Call to action"
              hint="Closes the video."
              value={callToAction}
              onChange={setCallToAction}
              onBlur={() => touch("callToAction")}
              max={TEXT_LIMITS.callToAction}
              error={errorFor("callToAction")}
              placeholder="e.g. Tap the link to shop"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-title">Disclosure</h2>
            <CardDescription>
              Shown at the top of every scene. Affiliate content must tell
              viewers you may earn a commission.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TextField
              id={FIELD_IDS.disclosure}
              label="Affiliate disclosure text"
              multiline
              value={disclosure}
              onChange={setDisclosure}
              onBlur={() => touch("disclosure")}
              max={TEXT_LIMITS.disclosure}
              error={errorFor("disclosure")}
            />
          </CardContent>
        </Card>

        {attempts > 0 ? (
          complete ? (
            <div
              ref={summaryRef}
              tabIndex={-1}
              role="status"
              className="flex items-start gap-2 rounded-xl bg-status-completed/10 p-4 text-sm ring-1 ring-status-completed/40 ring-inset focus:outline-none"
            >
              <CircleCheck
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-status-completed"
              />
              <p>
                <strong className="font-semibold">Storyboard complete:</strong>{" "}
                {scenes.length} scenes,{" "}
                {formatDuration(storyboardFrames(scenes))}.{" "}
                {ffmpegReady
                  ? "Select Render MP4 to make the video."
                  : "Install FFmpeg to render it."}
              </p>
            </div>
          ) : (
            <div
              ref={summaryRef}
              tabIndex={-1}
              aria-labelledby="problems-title"
              className="rounded-xl bg-destructive/10 p-4 text-sm ring-1 ring-destructive/40 ring-inset focus:outline-none focus-visible:ring-2"
            >
              <h2 id="problems-title" className="font-semibold">
                Fix {issues.length}{" "}
                {issues.length === 1 ? "problem" : "problems"} to complete the
                storyboard
              </h2>
              <ul className="mt-2 list-disc pl-5">
                {issues.map((issue) => (
                  <li key={issue.path}>
                    <a
                      href={`#${fieldIdFor(issue.path)}`}
                      className="underline underline-offset-2"
                      onClick={(event) => {
                        event.preventDefault()
                        document.getElementById(fieldIdFor(issue.path))?.focus()
                      }}
                    >
                      {issue.message}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )
        ) : null}

        <Button type="submit" size="lg" className="self-start">
          <ListChecks aria-hidden="true" />
          Check storyboard
        </Button>
      </form>

      <div className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader>
            <h2 className="text-title">Storyboard preview</h2>
            <CardDescription>
              Hook, one scene per benefit, then the call to action. Updates as
              you type.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StoryboardPreview
              scenes={scenes}
              imageUrls={imageUrls}
              disclosure={normalizeText(disclosure)}
            />
          </CardContent>
        </Card>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <h2 className="text-title">Video format</h2>
              <CardDescription>Fixed for this version.</CardDescription>
            </CardHeader>
            <CardContent>
              <FormatSummary />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <h2 className="text-title">Local FFmpeg</h2>
              <CardDescription>
                Renders will run on this computer.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FfmpegStatus
                onStatus={(status) => setFfmpegReady(status === "ready")}
              />
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <h2 className="text-title">Render</h2>
            <CardDescription>
              Turns the storyboard into a 9:16 MP4 with FFmpeg on this computer.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RenderPanel
              requirements={[
                {
                  label: `${MEDIA_LIMITS.minCount}–${MEDIA_LIMITS.maxCount} product images`,
                  met: images.length >= MEDIA_LIMITS.minCount,
                },
                { label: "Storyboard complete", met: complete },
                { label: "FFmpeg ready on this computer", met: ffmpegReady },
              ]}
              canRender={canRender}
              busy={render.busy}
              view={render.view}
              onRender={startRender}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
