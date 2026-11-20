import {
  CircleAlert,
  CircleCheck,
  Hourglass,
  LoaderCircle,
  Moon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { statusMeta, type EmployeeStatus } from "@/config/employee-status"
import { cn } from "@/lib/utils"

export const statusIcons: Record<EmployeeStatus, LucideIcon> = {
  idle: Moon,
  working: LoaderCircle,
  waiting: Hourglass,
  completed: CircleCheck,
  failed: CircleAlert,
}

/* Full class strings so Tailwind can detect them. */
const statusClasses: Record<EmployeeStatus, string> = {
  idle: "text-status-idle bg-status-idle/12 ring-status-idle/30",
  working: "text-status-working bg-status-working/12 ring-status-working/35",
  waiting: "text-status-waiting bg-status-waiting/12 ring-status-waiting/35",
  completed:
    "text-status-completed bg-status-completed/12 ring-status-completed/35",
  failed: "text-status-failed bg-status-failed/12 ring-status-failed/40",
}

export const statusDotClasses: Record<EmployeeStatus, string> = {
  idle: "bg-status-idle",
  working: "bg-status-working",
  waiting: "bg-status-waiting",
  completed: "bg-status-completed",
  failed: "bg-status-failed",
}

/**
 * Status pill: icon + text label + color, so state never relies on color alone.
 */
export function StatusBadge({
  status,
  className,
  ...props
}: { status: EmployeeStatus } & React.ComponentProps<"span">) {
  const Icon = statusIcons[status]
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset",
        statusClasses[status],
        className,
      )}
      {...props}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {statusMeta[status].label}
    </span>
  )
}
