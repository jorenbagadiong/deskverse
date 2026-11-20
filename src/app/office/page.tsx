import type { Metadata } from "next"

import { OfficeExperience } from "@/components/office/office-experience"
import { brand } from "@/config/brand"

export const metadata: Metadata = {
  title: "Office",
  description: `Interactive 3D office where the ${brand.name} AI team works (simulated).`,
}

export default function OfficePage() {
  return (
    <div className="mx-auto max-w-content px-gutter py-stack sm:px-gutter-lg sm:py-10">
      <header className="mb-stack flex flex-col gap-2">
        <p className="text-eyebrow text-primary uppercase">
          DV-002 · Virtual office
        </p>
        <h1 className="text-headline">The {brand.name} office</h1>
        <p className="max-w-2xl text-muted-foreground">
          Meet the seven-robot team across two floors of {brand.name} HQ. Select
          anyone to see what they&apos;re doing and try simulated actions.
          Nothing here runs a real AI agent.
        </p>
      </header>
      <OfficeExperience />
    </div>
  )
}
