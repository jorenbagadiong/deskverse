"use client"

import { Armchair, Building2, Coffee, Monitor, Users } from "lucide-react"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ROOMS, type ViewMode } from "@/config/office"
import { cn } from "@/lib/utils"

const OPTIONS: {
  value: ViewMode
  label: string
  text: string
  Icon: typeof Building2
}[] = [
  { value: "office", label: "Entire office", text: "Office", Icon: Building2 },
  {
    value: "operations",
    label: ROOMS.operations.name,
    text: ROOMS.operations.short,
    Icon: Monitor,
  },
  {
    value: "pantry",
    label: ROOMS.pantry.name,
    text: ROOMS.pantry.short,
    Icon: Coffee,
  },
  {
    value: "lounge",
    label: ROOMS.lounge.name,
    text: "Lounge",
    Icon: Armchair,
  },
  {
    value: "meeting",
    label: ROOMS.meeting.name,
    text: ROOMS.meeting.short,
    Icon: Users,
  },
]

/**
 * Entire office / Operations / Pantry / Gaming Lounge / Meeting Room camera
 * views. Icons only on small screens; the accessible names are always full.
 */
export function RoomSwitcher({
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
      aria-label="Rooms"
      value={view}
      onValueChange={(value) => {
        if (value) onChange(value as ViewMode)
      }}
      className={cn("bg-surface/90 shadow-raised backdrop-blur", className)}
    >
      {OPTIONS.map(({ value, label, text, Icon }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          aria-label={label}
          title={label}
          className="data-[state=on]:text-primary"
        >
          <Icon aria-hidden="true" />
          <span aria-hidden="true" className="hidden lg:inline">
            {text}
          </span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
