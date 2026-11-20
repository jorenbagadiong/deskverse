import { FlaskConical } from "lucide-react"

import { cn } from "@/lib/utils"

/** Marks data as simulated: nothing here runs a real agent. */
export function SimulatedTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full bg-secondary/12 px-2 text-[11px] font-medium text-secondary ring-1 ring-secondary/35 ring-inset",
        className,
      )}
    >
      <FlaskConical aria-hidden="true" className="size-3" />
      Simulated
    </span>
  )
}
