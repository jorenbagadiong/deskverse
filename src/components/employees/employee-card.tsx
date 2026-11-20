import { Bot } from "lucide-react"

import { StatusBadge } from "@/components/employees/status-badge"
import type { Employee } from "@/config/employees"
import { cn } from "@/lib/utils"

/** 2D placeholder avatar until the low-poly 3D characters land in DV-002. */
export function EmployeeAvatar({
  employee,
  className,
}: {
  employee: Pick<Employee, "colorToken" | "name">
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      style={
        { "--employee": `var(${employee.colorToken})` } as React.CSSProperties
      }
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-xl bg-(--employee)/14 text-(--employee) ring-1 ring-(--employee)/30 ring-inset",
        className,
      )}
    >
      <Bot className="size-5" />
    </span>
  )
}

export function EmployeeCard({
  employee,
  className,
  ...props
}: { employee: Employee } & React.ComponentProps<"article">) {
  return (
    <article
      className={cn(
        "flex flex-col gap-3 rounded-xl bg-card p-4 text-card-foreground shadow-flat ring-1 ring-border",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-3">
        <EmployeeAvatar employee={employee} />
        <div className="min-w-0">
          <h3 className="truncate font-semibold">{employee.name}</h3>
          <p className="text-sm text-muted-foreground">{employee.role}</p>
        </div>
      </div>
      <StatusBadge status={employee.sampleStatus} className="self-start" />
      <p className="text-sm text-muted-foreground">{employee.sampleTask}</p>
    </article>
  )
}
