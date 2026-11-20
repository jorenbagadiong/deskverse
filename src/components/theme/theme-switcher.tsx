"use client"

import { useSyncExternalStore } from "react"
import { useTheme } from "next-themes"
import { Monitor, Moon, Sun } from "lucide-react"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"

const options = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const

const subscribe = () => () => {}

/** True only after hydration, so the server and first client render match. */
function useHydrated() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  )
}

export function ThemeSwitcher({
  showLabels = false,
  className,
}: {
  showLabels?: boolean
  className?: string
}) {
  const { theme, setTheme } = useTheme()
  const hydrated = useHydrated()

  return (
    <ToggleGroup
      type="single"
      variant="outline"
      spacing={0}
      size="sm"
      aria-label="Color theme"
      value={hydrated ? (theme ?? "") : ""}
      onValueChange={(value) => {
        if (value) setTheme(value)
      }}
      className={cn("bg-surface", className)}
    >
      {options.map(({ value, label, Icon }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          aria-label={showLabels ? undefined : `${label} theme`}
          className="data-[state=on]:text-primary"
        >
          <Icon aria-hidden="true" />
          {showLabels ? <span>{label}</span> : null}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
