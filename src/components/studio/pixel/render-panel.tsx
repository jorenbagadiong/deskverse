import { CircleCheck, CircleDashed, Clapperboard, Lock } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The Render action, intentionally unavailable in DV-003A. It lists what a
 * render will need so the user can see which parts are already in place.
 */
export function RenderPanel({
  storyboardComplete,
  ffmpegReady,
}: {
  storyboardComplete: boolean
  ffmpegReady: boolean
}) {
  const requirements = [
    { label: "Storyboard complete", met: storyboardComplete },
    { label: "FFmpeg ready on this computer", met: ffmpegReady },
    { label: "Render engine (DV-003B)", met: false },
  ]

  return (
    <div className="flex flex-col gap-4">
      <ul
        aria-label="Render requirements"
        className="flex flex-col gap-1.5 text-sm"
      >
        {requirements.map(({ label, met }) => (
          <li key={label} className="flex items-center gap-2">
            {met ? (
              <CircleCheck
                aria-hidden="true"
                className="size-4 text-status-completed"
              />
            ) : (
              <CircleDashed
                aria-hidden="true"
                className="size-4 text-muted-foreground"
              />
            )}
            <span className={cn(!met && "text-muted-foreground")}>
              {label}
              <span className="sr-only">{met ? ": done" : ": not yet"}</span>
            </span>
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2">
        <Button
          type="button"
          size="lg"
          disabled
          aria-describedby="render-unavailable"
          className="self-start"
        >
          <Clapperboard aria-hidden="true" />
          Render MP4
        </Button>
        <p
          id="render-unavailable"
          className="flex items-start gap-2 text-sm text-muted-foreground"
        >
          <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            Rendering isn&apos;t available yet. This phase (DV-003A) builds and
            previews the storyboard only, and no video file is produced. The
            FFmpeg render engine arrives in DV-003B.
          </span>
        </p>
      </div>
    </div>
  )
}
