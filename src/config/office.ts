import type { EmployeeStatus } from "@/config/employee-status"
import { employees, type Employee } from "@/config/employees"

/**
 * Typed registry of everyone with a desk in Deskverse HQ (DV-002B).
 * Names, roles and identity tokens come from the shared roster in employees.ts;
 * this file adds the office-specific data: desk, character look and simulated
 * task copy, plus the single-floor room layout. The 3D scene, employee list,
 * detail panel and 2D floor plan all render from these arrays.
 */

/** The four areas of the single-floor office. */
export type RoomId = "operations" | "pantry" | "lounge" | "meeting"

export type RoomBounds = { x0: number; x1: number; z0: number; z1: number }

/**
 * The whole office footprint (scene units, y = 0 everywhere). The front (+z)
 * and right (+x) sides are open, like a cutaway; the back and left outer
 * walls hide when the camera orbits behind them.
 */
export const OFFICE_BOUNDS: RoomBounds = { x0: -9, x1: 9, z0: -6.5, z1: 6.5 }

/** Back-room partitions: glass walls along z = BACK_ROOMS_Z with doorways. */
export const BACK_ROOMS_Z = -2.2

export const ROOMS: Record<
  RoomId,
  { name: string; short: string; bounds: RoomBounds; description: string }
> = {
  operations: {
    name: "Operations Room",
    short: "Operations",
    // The open-plan hall in front, including the corridor along the back rooms.
    bounds: { x0: -9, x1: 9, z0: BACK_ROOMS_Z, z1: 6.5 },
    description: "All seven workstations",
  },
  meeting: {
    name: "Meeting Room",
    short: "Meeting",
    bounds: { x0: -9, x1: -3, z0: -6.5, z1: BACK_ROOMS_Z },
    description: "Conference table with seats for the whole team",
  },
  pantry: {
    name: "Pantry",
    short: "Pantry",
    bounds: { x0: -3, x1: 2.5, z0: -6.5, z1: BACK_ROOMS_Z },
    description: "Coffee bar, fridge and a high table",
  },
  lounge: {
    name: "Gaming & Rest Lounge",
    short: "Lounge",
    bounds: { x0: 2.5, x1: 9, z0: -6.5, z1: BACK_ROOMS_Z },
    description: "Gaming stations, sofa and a lounge chair",
  },
}

/** Rooms in plan order (back row west → east, then the Operations Room). */
export const ROOM_IDS: readonly RoomId[] = [
  "operations",
  "pantry",
  "lounge",
  "meeting",
]

/** The room that contains a floor point, if any. */
export function roomAt(x: number, z: number): RoomId | null {
  for (const id of ["meeting", "pantry", "lounge", "operations"] as const) {
    const b = ROOMS[id].bounds
    if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return id
  }
  return null
}

/** Where an employee stands relative to their desk center (behind it). */
export const DESK_STAND_OFFSET_Z = -0.74

/** Camera views: the whole office or one room. */
export type ViewMode = "office" | RoomId

export type WorkstationKind =
  | "research"
  | "writing"
  | "video"
  | "review"
  | "schedule"
  | "publish"
  | "analytics"

/** Composable character design: every employee shares one rig, not one model. */
export type CharacterLook = {
  head: "soft" | "tall" | "wide" | "orb" | "capsule" | "screen"
  headgear:
    | "explorer-cap"
    | "quill-fin"
    | "headset"
    | "inspector-visor"
    | "clock-ring"
    | "antennas"
    | "glasses"
  chest:
    | "satchel"
    | "notebook"
    | "film-belt"
    | "shield"
    | "clock"
    | "messenger-bag"
    | "chart-display"
  build: "standard" | "slim" | "sturdy"
  /** Resting eye shape: the core of each personality. */
  eyes: "round" | "pill" | "half" | "narrow"
  mouth: "smile" | "flat" | "grin"
}

export type OfficeEmployeeDefinition = {
  id: "scout" | "quill" | "pixel" | "vera" | "tempo" | "relay" | "ledger"
  agentTitle: string
  summary: string
  personality: string
  /** Bright identity color for 3D glow; equals the dark-theme `--identity-*` token. */
  glow: string
  workstation: WorkstationKind
  look: CharacterLook
  /** Desk position in the Operations Room, in scene units: [x, z]. */
  desk: readonly [number, number]
  initialStatus: EmployeeStatus
  /** Simulated task description shown for each state. */
  tasks: Record<EmployeeStatus, string>
}

export type OfficeEmployee = OfficeEmployeeDefinition &
  Pick<Employee, "name" | "role" | "colorToken">

export type OfficeEmployeeId = OfficeEmployeeDefinition["id"]

const definitions: OfficeEmployeeDefinition[] = [
  {
    id: "scout",
    agentTitle: "Research Agent",
    summary: "Finds sources, trends and facts for upcoming content.",
    personality: "Curious explorer",
    glow: "#2dd4bf",
    workstation: "research",
    look: {
      head: "soft",
      headgear: "explorer-cap",
      chest: "satchel",
      build: "standard",
      eyes: "round",
      mouth: "smile",
    },
    desk: [-6.3, 0.6],
    initialStatus: "working",
    tasks: {
      idle: "Waiting for a research request.",
      working: "Scanning sources for this week's trend brief.",
      waiting: "Trend brief ready. Needs your approval.",
      completed: "Delivered the trend brief to Quill.",
      failed: "Couldn't reach the sample source library.",
    },
  },
  {
    id: "quill",
    agentTitle: "Scriptwriter",
    summary: "Turns research into clear, engaging video scripts.",
    personality: "Focused storyteller",
    glow: "#c084fc",
    workstation: "writing",
    look: {
      head: "tall",
      headgear: "quill-fin",
      chest: "notebook",
      build: "slim",
      eyes: "half",
      mouth: "flat",
    },
    desk: [-2.1, 0.6],
    initialStatus: "idle",
    tasks: {
      idle: "Waiting for a research brief.",
      working: "Drafting the script for the product teaser.",
      waiting: "Script draft ready. Needs your approval.",
      completed: "Script approved and handed to Pixel.",
      failed: "Brief is missing the target audience.",
    },
  },
  {
    id: "pixel",
    agentTitle: "Video Creator",
    summary: "Turns approved scripts into short videos.",
    personality: "Expressive creative",
    glow: "#fb923c",
    workstation: "video",
    look: {
      head: "screen",
      headgear: "headset",
      chest: "film-belt",
      build: "standard",
      eyes: "pill",
      mouth: "grin",
    },
    desk: [2.1, 0.6],
    initialStatus: "waiting",
    tasks: {
      idle: "Waiting for an approved script.",
      working: "Rendering the 30-second product teaser.",
      waiting: "Teaser cut ready. Needs your approval.",
      completed: "Exported the teaser for publishing.",
      failed: "Render stopped: sample footage missing.",
    },
  },
  {
    id: "vera",
    agentTitle: "Quality Reviewer",
    summary: "Checks every deliverable before it ships.",
    personality: "Observant inspector",
    glow: "#60a5fa",
    workstation: "review",
    look: {
      head: "soft",
      headgear: "inspector-visor",
      chest: "shield",
      build: "standard",
      eyes: "narrow",
      mouth: "flat",
    },
    desk: [6.3, 0.6],
    initialStatus: "idle",
    tasks: {
      idle: "Waiting for the next deliverable.",
      working: "Reviewing the teaser against the brand checklist.",
      waiting: "Review notes ready. Needs your sign-off.",
      completed: "Teaser passed quality review.",
      failed: "Found a contrast issue in the captions.",
    },
  },
  {
    id: "tempo",
    agentTitle: "Scheduler",
    summary: "Plans when each piece of content goes out.",
    personality: "Calm organizer",
    glow: "#a78bfa",
    workstation: "schedule",
    look: {
      head: "orb",
      headgear: "clock-ring",
      chest: "clock",
      build: "standard",
      eyes: "half",
      mouth: "smile",
    },
    desk: [-4.2, 4.0],
    initialStatus: "idle",
    tasks: {
      idle: "Calendar is up to date.",
      working: "Arranging next week's posting schedule.",
      waiting: "Proposed schedule needs your approval.",
      completed: "Schedule confirmed for next week.",
      failed: "Two posts overlap in the same time slot.",
    },
  },
  {
    id: "relay",
    agentTitle: "Publisher",
    summary: "Delivers finished content to the right channels.",
    personality: "Energetic messenger",
    glow: "#fb7185",
    workstation: "publish",
    look: {
      head: "capsule",
      headgear: "antennas",
      chest: "messenger-bag",
      build: "slim",
      eyes: "round",
      mouth: "grin",
    },
    desk: [0, 4.0],
    initialStatus: "working",
    tasks: {
      idle: "Outbox is empty.",
      working: "Sending the teaser to the sample channels.",
      waiting: "Ready to publish. Needs your go-ahead.",
      completed: "Teaser published to all sample channels.",
      failed: "Upload rejected: missing thumbnail.",
    },
  },
  {
    id: "ledger",
    agentTitle: "Analytics Agent",
    summary: "Measures how content performs and spots trends.",
    personality: "Analytical thinker",
    glow: "#fbbf24",
    workstation: "analytics",
    look: {
      head: "wide",
      headgear: "glasses",
      chest: "chart-display",
      build: "sturdy",
      eyes: "pill",
      mouth: "flat",
    },
    desk: [4.2, 4.0],
    initialStatus: "completed",
    tasks: {
      idle: "Dashboards are current.",
      working: "Comparing last week's engagement by channel.",
      waiting: "Weekly report ready. Needs your review.",
      completed: "Compiled last week's engagement report.",
      failed: "Analytics export came back empty.",
    },
  },
]

export const officeEmployees: OfficeEmployee[] = definitions.map(
  (definition) => {
    const base = employees.find((e) => e.id === definition.id)
    if (!base)
      throw new Error(
        `Office employee "${definition.id}" is missing from the roster`,
      )
    return {
      ...definition,
      name: base.name,
      role: base.role,
      colorToken: base.colorToken,
    }
  },
)

export function getOfficeEmployee(id: OfficeEmployeeId): OfficeEmployee {
  const employee = officeEmployees.find((e) => e.id === id)
  if (!employee) throw new Error(`Unknown office employee "${id}"`)
  return employee
}
