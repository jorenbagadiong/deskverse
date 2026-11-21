import type { Metadata } from "next"
import { Info } from "lucide-react"

import { EmployeeAvatar } from "@/components/employees/employee-card"
import { PixelStudio } from "@/components/studio/pixel/pixel-studio"
import { employees } from "@/config/employees"

export const metadata: Metadata = {
  title: "Pixel Studio",
  description:
    "Make 9:16 affiliate product videos from your own images, captions, voiceover and music, rendered locally with FFmpeg.",
}

const pixel = employees.find((employee) => employee.id === "pixel")!

export default function PixelStudioPage() {
  return (
    <div className="mx-auto max-w-content px-gutter sm:px-gutter-lg">
      <header className="flex flex-col gap-5 py-section">
        <div className="flex flex-col gap-3">
          <p className="text-eyebrow text-primary uppercase">
            DV-003C · Product videos with voiceover &amp; music
          </p>
          <div className="flex items-center gap-3">
            <EmployeeAvatar employee={pixel} className="size-12" />
            <h1 className="text-headline sm:text-display">Pixel Studio</h1>
          </div>
          <p className="max-w-2xl text-lg text-muted-foreground">
            Make a vertical product video for TikTok, Reels or Shorts. Add your
            product images and captions, and {pixel.name}, your{" "}
            {pixel.role.toLowerCase()}, lays them out as a 9:16 storyboard and
            renders an MP4 you can preview and download, optionally with your
            own voiceover and background music.
          </p>
        </div>
        <p className="flex max-w-2xl items-start gap-2 rounded-lg bg-status-info/10 p-3 text-sm ring-1 ring-status-info/35 ring-inset">
          <Info
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-status-info"
          />
          <span>
            <strong className="font-semibold">Runs on your computer.</strong>{" "}
            FFmpeg on this machine assembles the images, text and audio you
            supply into the video. It doesn&apos;t generate AI footage, and
            nothing is sent to a cloud service.
          </span>
        </p>
      </header>
      <PixelStudio />
    </div>
  )
}
