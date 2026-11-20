/**
 * The five states every Deskverse AI employee can be in.
 * Colors are referenced by token name; the actual values live in globals.css.
 * Each state also has an icon and a text label so it never depends on color alone.
 */
export const EMPLOYEE_STATUSES = [
  "idle",
  "working",
  "waiting",
  "completed",
  "failed",
] as const

export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number]

export const statusMeta: Record<
  EmployeeStatus,
  { label: string; description: string; token: `--status-${EmployeeStatus}` }
> = {
  idle: {
    label: "Idle",
    description: "Available and waiting for the next task.",
    token: "--status-idle",
  },
  working: {
    label: "Working",
    description: "Actively processing a task.",
    token: "--status-working",
  },
  waiting: {
    label: "Waiting for approval",
    description: "Paused until a human reviews and approves.",
    token: "--status-waiting",
  },
  completed: {
    label: "Completed",
    description: "Finished the task successfully.",
    token: "--status-completed",
  },
  failed: {
    label: "Failed",
    description: "Stopped because of an error that needs attention.",
    token: "--status-failed",
  },
}
