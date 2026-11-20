import type { Metadata } from "next"

import { OfficeExperience } from "@/components/office/office-experience"
import { brand } from "@/config/brand"

export const metadata: Metadata = {
  title: "Office",
  description: `Interactive 3D office where the ${brand.name} AI team works (simulated).`,
}

export default function OfficePage() {
  return (
    <div className="py-stack sm:py-10">
      <header className="mx-auto mb-stack flex max-w-content flex-col gap-2 px-gutter sm:px-gutter-lg">
        <p className="text-eyebrow text-primary uppercase">
          DV-002 · Virtual office
        </p>
        <h1 className="text-headline">The {brand.name} office</h1>
        <p className="max-w-2xl text-muted-foreground">
          Meet the seven-robot team across two floors of {brand.name} HQ. Select
          anyone to see what they&apos;re doing, try simulated actions, or send
          them for a coffee in the pantry or a rest in the lounge. Nothing here
          runs a real AI agent.
        </p>
      </header>
      {/* The simulation uses the full page width; cards sit below it. */}
      <div className="mx-auto w-full max-w-[120rem] px-gutter sm:px-gutter-lg">
        <OfficeExperience />
      </div>
    </div>
  )
}
