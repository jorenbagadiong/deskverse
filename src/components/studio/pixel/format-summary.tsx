import { VIDEO_FORMAT } from "@/lib/video/format"

const rows = [
  ["Resolution", `${VIDEO_FORMAT.width} × ${VIDEO_FORMAT.height} px`],
  ["Aspect ratio", `${VIDEO_FORMAT.aspectRatio} (vertical)`],
  ["Frame rate", `${VIDEO_FORMAT.fps} fps`],
  ["Container", VIDEO_FORMAT.container.toUpperCase()],
  ["Video codec", `H.264, ${VIDEO_FORMAT.pixelFormat}`],
  [
    "Duration",
    `${VIDEO_FORMAT.minDurationSeconds}–${VIDEO_FORMAT.maxDurationSeconds} seconds`,
  ],
  ["Audio", "None yet (arrives in DV-003C)"],
] as const

/** The fixed output format. Not editable: the server owns encoding settings. */
export function FormatSummary() {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
