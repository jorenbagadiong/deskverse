"use client"

import { Building2 } from "lucide-react"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { FLOORS, type ViewMode } from "@/config/office"
import { cn } from "@/lib/utils"

const OPTIONS: { value: ViewMode; label: string; short: string }[] = [
  { value: "building", label: "Whole building", short: "All" },
  { value: "floor-1", label: `Floor 1: ${FLOORS[1].name}`, short: "1F" },
  { value: "floor-2", label: `Floor 2: ${FLOORS[2].name}`, short: "2F" },
]

/** Building / Floor 1 / Floor 2 camera modes. Compact labels on small screens. */
export function FloorSwitcher({
  view,
  onChange,
  className,
}: {
  view: ViewMode
  onChange: (view: ViewMode) => void
  className?: string
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      spacing={0}
      aria-label="Floors"
      value={view}
      onValueChange={(value) => {
        if (value) onChange(value as ViewMode)
      }}
      className={cn("bg-surface/90 shadow-raised backdrop-blur", className)}
    >
      {OPTIONS.map(({ value, label, short }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          aria-label={label}
          className="data-[state=on]:text-primary"
        >
          {value === "building" ? <Building2 aria-hidden="true" /> : null}
          <span aria-hidden="true" className="sm:hidden">
            {short}
          </span>
          <span aria-hidden="true" className="hidden sm:inline">
            {value === "building"
              ? "Building"
              : short === "1F"
                ? "Floor 1"
                : "Floor 2"}
          </span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
