import { ImageOff } from "lucide-react"

import { cn } from "@/lib/utils"
import { formatDuration, VIDEO_FORMAT } from "@/lib/video/format"
import { storyboardFrames } from "@/lib/video/storyboard"
import type { VideoScene } from "@/lib/video/types"

const KIND_LABEL: Record<VideoScene["kind"], string> = {
  hook: "Hook",
  benefit: "Benefit",
  "call-to-action": "Call to action",
}

const POSITION: Record<VideoScene["caption"]["position"], string> = {
  top: "justify-start pt-[18%]",
  center: "justify-center",
  bottom: "justify-end pb-[12%]",
}

/**
 * Static storyboard: one 9:16 card per scene with its image, caption and the
 * affiliate disclosure, plus a timeline. A preview of the plan, not a
 * rendered video. Captions scale with the card via container query units.
 */
export function StoryboardPreview({
  scenes,
  imageUrls,
  disclosure,
}: {
  scenes: readonly VideoScene[]
  imageUrls: ReadonlyMap<string, string>
  disclosure: string
}) {
  const total = storyboardFrames(scenes)

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">
          {scenes.length} scenes · {formatDuration(total)}
        </span>{" "}
        at {VIDEO_FORMAT.fps} fps. A static plan of the video, not a render.
      </p>

      <div
        aria-hidden="true"
        className="flex h-2 gap-0.5 overflow-hidden rounded-full"
      >
        {scenes.map((scene) => (
          <span
            key={scene.id}
            style={{ flexGrow: scene.durationFrames }}
            className={cn(
              "basis-0",
              scene.kind === "hook"
                ? "bg-secondary"
                : scene.kind === "call-to-action"
                  ? "bg-accent"
                  : "bg-primary",
            )}
          />
        ))}
      </div>

      <ol
        aria-label="Storyboard scenes"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3"
      >
        {scenes.map((scene, index) => {
          const url = scene.assetId ? imageUrls.get(scene.assetId) : undefined
          return (
            <li key={scene.id} className="flex flex-col gap-1.5">
              <div
                data-testid="scene-frame"
                className="@container relative aspect-9/16 overflow-hidden rounded-lg bg-surface-sunken ring-1 ring-border"
              >
                {url ? (
                  // Local blob: preview; next/image can't optimize object URLs.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={url}
                    alt=""
                    className="absolute inset-0 size-full object-cover"
                  />
                ) : (
                  <div className="absolute inset-0 flex justify-center bg-linear-to-b from-secondary/25 to-primary/20 pt-[24%]">
                    <ImageOff
                      aria-hidden="true"
                      className="size-[18cqw] text-muted-foreground/60"
                    />
                  </div>
                )}
                {/* Darken behind text so captions stay legible on any photo. */}
                <div className="absolute inset-0 bg-linear-to-b from-black/45 via-black/5 to-black/55" />
                <p className="absolute inset-x-0 top-0 bg-black/55 px-[5cqw] py-[2.5cqw] text-center text-[4.5cqw] leading-tight font-medium text-white">
                  {disclosure}
                </p>
                <div
                  className={cn(
                    "absolute inset-0 flex flex-col items-center gap-[2cqw] px-[7cqw] text-center text-white",
                    POSITION[scene.caption.position],
                  )}
                >
                  <p
                    className={cn(
                      "leading-[1.1] font-bold text-balance [text-shadow:0_1px_3px_rgb(0_0_0/0.7)]",
                      scene.kind === "benefit" ? "text-[8cqw]" : "text-[10cqw]",
                      scene.kind === "call-to-action" &&
                        "rounded-[3cqw] bg-accent px-[4cqw] py-[2cqw] text-accent-foreground text-shadow-none",
                    )}
                  >
                    {scene.caption.text}
                  </p>
                  {scene.caption.subtext ? (
                    <p className="text-[5.5cqw] font-medium opacity-90 [text-shadow:0_1px_3px_rgb(0_0_0/0.7)]">
                      {scene.caption.subtext}
                    </p>
                  ) : null}
                </div>
              </div>
              <p className="flex items-baseline justify-between gap-2 text-xs">
                <span className="font-medium">
                  {index + 1}. {KIND_LABEL[scene.kind]}
                </span>
                <span className="font-mono text-muted-foreground tabular-nums">
                  {formatDuration(scene.durationFrames)}
                </span>
              </p>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
