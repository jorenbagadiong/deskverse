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
  type OfficeEmployeeId,
  type RoomId,
  type ViewMode,
} from "@/config/office"

import {
  activityOf,
  arrivalMessage,
  freeSpot,
  isAtDesk,
  isHeadingTo,
  roomOf,
  startOf,
  type Activity,
  type LiveLocation,
  type Movement,
} from "./office-movement"
import {
  DESTINATION_LABEL,
  deskNode,
  getNode,
  planRoute,
  type DestinationKind,
} from "./office-navigation"

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
  /** Task status at the time of the entry. */
  status: EmployeeStatus
  /** Status changes and movement events are logged separately. */
  kind: "status" | "movement"
  /** Body activity, for movement entries. */
  activity?: Activity
  message: string
}

export type OfficeState = {
  selectedId: OfficeEmployeeId | null
  /** Camera view: the whole office or one room. */
  view: ViewMode
  statuses: Record<OfficeEmployeeId, EmployeeStatus>
  /** Physical movement, independent of task status. */
  movement: Record<OfficeEmployeeId, Movement>
  activity: ActivityEntry[]
  nextActivityId: number
  nextRouteId: number
  /** Optional ambient wandering (off by default). */
  wander: boolean
  tick: number
  wanderCursor: number
}

export type OfficeAction =
  /** `room`: where the employee is right now (the scene's live reading). */
  | { type: "select"; id: OfficeEmployeeId | null; room?: RoomId | null }
  | { type: "setView"; view: ViewMode; selectedRoom?: RoomId | null }
  | {
      type: "setStatus"
      id: OfficeEmployeeId
      status: EmployeeStatus
      /** Live position, needed only if the employee is walking. */
      from?: LiveLocation
      instant?: boolean
    }
  | {
      type: "goTo"
      id: OfficeEmployeeId
      destination: DestinationKind
      from?: LiveLocation
      /** Reduced motion: arrive immediately instead of walking. */
      instant?: boolean
    }
  | { type: "stop"; id: OfficeEmployeeId; at: LiveLocation }
  | { type: "arrive"; id: OfficeEmployeeId; routeId: number }
  | { type: "setWander"; on: boolean }
  | { type: "ambientTick"; instant?: boolean }

export const MAX_ACTIVITY = 4
/** Ambient ticks an employee stays on a break before heading back. */
export const BREAK_TICKS = 3

export function createInitialOfficeState(): OfficeState {
  return {
    selectedId: null,
    view: "office",
    statuses: Object.fromEntries(
      officeEmployees.map((e) => [e.id, e.initialStatus]),
    ) as Record<OfficeEmployeeId, EmployeeStatus>,
    movement: Object.fromEntries(
      officeEmployees.map((e) => [
        e.id,
        { kind: "at", node: deskNode(e.id), since: 0 },
      ]),
    ) as Record<OfficeEmployeeId, Movement>,
    activity: [],
    nextActivityId: 1,
    nextRouteId: 1,
    wander: false,
    tick: 0,
    wanderCursor: 0,
  }
}

export function statusMessage(id: OfficeEmployeeId, status: EmployeeStatus) {
  const employee = getOfficeEmployee(id)
  return `${employee.name} is now ${statusMeta[status].label.toLowerCase()}: ${employee.tasks[status]}`
}

function log(
  state: OfficeState,
  entry: Omit<ActivityEntry, "id" | "status"> & { status?: EmployeeStatus },
): OfficeState {
  const full: ActivityEntry = {
    ...entry,
    id: state.nextActivityId,
    status: entry.status ?? state.statuses[entry.employeeId],
  }
  return {
    ...state,
    activity: [full, ...state.activity].slice(0, MAX_ACTIVITY),
    nextActivityId: state.nextActivityId + 1,
  }
}

/** Sends an employee towards a desk, spot or seat (or straight there when instant). */
function moveTo(
  state: OfficeState,
  id: OfficeEmployeeId,
  destination: DestinationKind,
  from?: LiveLocation,
  instant = false,
): OfficeState {
  const current = state.movement[id]
  const target = freeSpot(destination, id, state.movement)
  if (!target) return state
  if (current.kind === "at" && current.node === target) return state
  if (current.kind === "walking" && current.target === target) return state
  const name = getOfficeEmployee(id).name

  if (instant) {
    const next = {
      ...state,
      movement: {
        ...state.movement,
        [id]: { kind: "at", node: target, since: state.tick } as Movement,
      },
    }
    return log(next, {
      employeeId: id,
      kind: "movement",
      activity: activityOf(next.movement[id]),
      message: arrivalMessage(name, target),
    })
  }

  const route = planRoute(startOf(current, from), target)
  if (!route) return state
  const walking: Movement = {
    kind: "walking",
    routeId: state.nextRouteId,
    route,
    destination,
    target,
  }
  const next = {
    ...state,
    movement: { ...state.movement, [id]: walking },
    nextRouteId: state.nextRouteId + 1,
  }
  return log(next, {
    employeeId: id,
    kind: "movement",
    activity: "walking",
    message: `${name} is walking to the ${DESTINATION_LABEL[destination]}.`,
  })
}

const currentRoom = (
  state: OfficeState,
  id: OfficeEmployeeId,
  live?: RoomId | null,
) => (live === undefined ? roomOf(state.movement[id]) : live)

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
      // A room view only frames that room: show the whole office when the
      // employee is somewhere else. The camera then focuses them either way.
      const room = currentRoom(state, action.id, action.room)
      const view =
        state.view === "office" || state.view === room ? state.view : "office"
      if (state.selectedId === action.id && state.view === view) return state
      return { ...state, selectedId: action.id, view }
    }
    case "setView": {
      if (state.view === action.view) return state
      // Keep the selection only if they are in the room being framed.
      const room = state.selectedId
        ? currentRoom(state, state.selectedId, action.selectedRoom)
        : null
      const keep = action.view === "office" || room === action.view
      return {
        ...state,
        view: action.view,
        selectedId: keep ? state.selectedId : null,
      }
    }
    case "setStatus": {
      if (state.statuses[action.id] === action.status) return state
      let next = log(
        {
          ...state,
          statuses: { ...state.statuses, [action.id]: action.status },
        },
        {
          employeeId: action.id,
          kind: "status",
          status: action.status,
          message: statusMessage(action.id, action.status),
        },
      )
      // A working task needs the workstation: walk back first (status is kept).
      const m = next.movement[action.id]
      if (
        action.status === "working" &&
        !isAtDesk(m, action.id) &&
        !isHeadingTo(m, "desk")
      ) {
        next = moveTo(next, action.id, "desk", action.from, action.instant)
      }
      return next
    }
    case "goTo": {
      const status = state.statuses[action.id]
      // Working employees don't leave for breaks (they may always return to the desk).
      if (action.destination !== "desk" && status === "working") return state
      return moveTo(
        state,
        action.id,
        action.destination,
        action.from,
        action.instant,
      )
    }
    case "stop": {
      const m = state.movement[action.id]
      if (m.kind !== "walking") return state
      const stopped: Movement = action.at.node
        ? { kind: "at", node: action.at.node, since: state.tick }
        : action.at.edge
          ? { kind: "stopped", point: action.at.point, edge: action.at.edge }
          : m
      if (stopped === m) return state
      return log(
        { ...state, movement: { ...state.movement, [action.id]: stopped } },
        {
          employeeId: action.id,
          kind: "movement",
          activity: activityOf(stopped),
          message: `${getOfficeEmployee(action.id).name} stopped walking.`,
        },
      )
    }
    case "arrive": {
      const m = state.movement[action.id]
      if (m.kind !== "walking" || m.routeId !== action.routeId) return state
      const arrived: Movement = {
        kind: "at",
        node: m.target,
        since: state.tick,
      }
      return log(
        { ...state, movement: { ...state.movement, [action.id]: arrived } },
        {
          employeeId: action.id,
          kind: "movement",
          activity: activityOf(arrived),
          message: arrivalMessage(getOfficeEmployee(action.id).name, m.target),
        },
      )
    }
    case "setWander":
      return state.wander === action.on
        ? state
        : { ...state, wander: action.on }
    case "ambientTick": {
      if (!state.wander) return state
      const tick = state.tick + 1
      let next: OfficeState = { ...state, tick }
      // 1. Someone who has had a long enough break heads back to their desk.
      const done = officeEmployees.find((e) => {
        const m = next.movement[e.id]
        const spot = m.kind === "at" ? getNode(m.node).spot : undefined
        return (
          m.kind === "at" &&
          (spot === "pantry" || spot === "lounge") &&
          tick - m.since >= BREAK_TICKS
        )
      })
      if (done) return moveTo(next, done.id, "desk", undefined, action.instant)
      // 2. Otherwise the next idle (or finished) employee at their desk takes a break.
      for (let i = 0; i < officeEmployees.length; i++) {
        const index = (state.wanderCursor + i) % officeEmployees.length
        const e = officeEmployees[index]
        const status = next.statuses[e.id]
        if (
          (status === "idle" || status === "completed") &&
          isAtDesk(next.movement[e.id], e.id)
        ) {
          // Alternate between the pantry and the lounge.
          const destination: DestinationKind =
            index % 2 === 0 ? "pantry" : "lounge"
          next = { ...next, wanderCursor: index + 1 }
          return moveTo(next, e.id, destination, undefined, action.instant)
        }
      }
      return next
    }
  }
}
