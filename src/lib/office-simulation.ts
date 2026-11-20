/**
 * Simulated task state machine for the 3D office.
 *
 * Everything here is SIMULATED: no agent runs, nothing is sent anywhere.
 * The reducer is the single integration point for real agent workflows later:
 * replace `dispatch({ type: "setStatus" })` calls with events from a local
 * workflow runner and the scene, list and panel update unchanged.
 */
import { statusMeta, type EmployeeStatus } from "@/config/employee-status"
import {
  getOfficeEmployee,
  officeEmployees,
  viewForFloor,
  type OfficeEmployeeId,
  type ViewMode,
} from "@/config/office"

export type SimulatedAction = {
  id: string
  label: string
  next: EmployeeStatus
  /** Visual weight of the button. */
  intent: "primary" | "secondary" | "danger"
}

/** Contextual actions available from each state. */
export const simulatedActions: Record<EmployeeStatus, SimulatedAction[]> = {
  idle: [
    {
      id: "assign",
      label: "Assign sample task",
      next: "working",
      intent: "primary",
    },
  ],
  working: [
    {
      id: "request-approval",
      label: "Request approval",
      next: "waiting",
      intent: "primary",
    },
    {
      id: "finish",
      label: "Finish task",
      next: "completed",
      intent: "secondary",
    },
    { id: "fail", label: "Simulate failure", next: "failed", intent: "danger" },
  ],
  waiting: [
    { id: "approve", label: "Approve", next: "completed", intent: "primary" },
    {
      id: "request-changes",
      label: "Request changes",
      next: "working",
      intent: "secondary",
    },
  ],
  completed: [
    {
      id: "new-task",
      label: "Start new task",
      next: "working",
      intent: "primary",
    },
    { id: "rest", label: "Return to idle", next: "idle", intent: "secondary" },
  ],
  failed: [
    { id: "retry", label: "Retry", next: "working", intent: "primary" },
    { id: "dismiss", label: "Dismiss", next: "idle", intent: "secondary" },
  ],
}

export type ActivityEntry = {
  /** Monotonic sequence number; also used as a stable React key. */
  id: number
  employeeId: OfficeEmployeeId
  status: EmployeeStatus
  message: string
}

export type OfficeState = {
  selectedId: OfficeEmployeeId | null
  /** Camera / floor navigation: whole building or one floor. */
  view: ViewMode
  statuses: Record<OfficeEmployeeId, EmployeeStatus>
  activity: ActivityEntry[]
  nextActivityId: number
}

export type OfficeAction =
  | { type: "select"; id: OfficeEmployeeId | null }
  | { type: "setView"; view: ViewMode }
  | { type: "setStatus"; id: OfficeEmployeeId; status: EmployeeStatus }

export const MAX_ACTIVITY = 4

export function createInitialOfficeState(): OfficeState {
  return {
    selectedId: null,
    view: "building",
    statuses: Object.fromEntries(
      officeEmployees.map((e) => [e.id, e.initialStatus]),
    ) as Record<OfficeEmployeeId, EmployeeStatus>,
    activity: [],
    nextActivityId: 1,
  }
}

export function statusMessage(id: OfficeEmployeeId, status: EmployeeStatus) {
  const employee = getOfficeEmployee(id)
  return `${employee.name} is now ${statusMeta[status].label.toLowerCase()}: ${employee.tasks[status]}`
}

export function officeReducer(
  state: OfficeState,
  action: OfficeAction,
): OfficeState {
  switch (action.type) {
    case "select": {
      if (action.id === null) {
        return state.selectedId === null
          ? state
          : { ...state, selectedId: null }
      }
      // Selecting someone activates their floor.
      const view = viewForFloor(getOfficeEmployee(action.id).floor)
      if (state.selectedId === action.id && state.view === view) return state
      return { ...state, selectedId: action.id, view }
    }
    case "setView": {
      if (state.view === action.view) return state
      // Keep the selection only if it is still visible in the new view.
      const selected = state.selectedId
        ? getOfficeEmployee(state.selectedId)
        : null
      const keep =
        !selected ||
        action.view === "building" ||
        viewForFloor(selected.floor) === action.view
      return {
        ...state,
        view: action.view,
        selectedId: keep ? state.selectedId : null,
      }
    }
    case "setStatus": {
      if (state.statuses[action.id] === action.status) return state
      const entry: ActivityEntry = {
        id: state.nextActivityId,
        employeeId: action.id,
        status: action.status,
        message: statusMessage(action.id, action.status),
      }
      return {
        ...state,
        statuses: { ...state.statuses, [action.id]: action.status },
        activity: [entry, ...state.activity].slice(0, MAX_ACTIVITY),
        nextActivityId: state.nextActivityId + 1,
      }
    }
  }
}
