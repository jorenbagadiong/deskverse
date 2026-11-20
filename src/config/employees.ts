import type { EmployeeStatus } from "./employee-status"

/**
 * Static roster of the planned Deskverse AI team.
 * Visual descriptions guide the future low-poly 3D models (DV-002);
 * `sampleStatus` is demo data for the /brand showcase only.
 */
export type Employee = {
  id: string
  name: string
  role: string
  /** Semantic color token used for the employee's identity accent. */
  colorToken:
    | "--primary"
    | "--secondary"
    | "--accent"
    | "--status-completed"
    | "--status-info"
  silhouette: string
  accessory: string
  sampleStatus: EmployeeStatus
  sampleTask: string
}

export const employees: Employee[] = [
  {
    id: "scout",
    name: "Scout",
    role: "Research",
    colorToken: "--primary",
    silhouette: "Compact rounded body with a tall periscope antenna.",
    accessory: "Telescoping lens eye and a satchel of index cards.",
    sampleStatus: "working",
    sampleTask: "Collecting sources for the weekly trend brief",
  },
  {
    id: "quill",
    name: "Quill",
    role: "Scriptwriting",
    colorToken: "--secondary",
    silhouette: "Slim upright body with a single curved quill-shaped fin.",
    accessory: "Floating holographic notepad.",
    sampleStatus: "waiting",
    sampleTask: "Script draft ready for approval",
  },
  {
    id: "pixel",
    name: "Pixel",
    role: "Video Creator",
    colorToken: "--accent",
    silhouette: "Boxy camera-shaped head on a short square body.",
    accessory: "Clapperboard visor and shoulder-mounted light.",
    sampleStatus: "working",
    sampleTask: "Rendering the 30-second product teaser",
  },
  {
    id: "vera",
    name: "Vera",
    role: "Quality Review",
    colorToken: "--status-completed",
    silhouette: "Tall oval body with a wide visor band.",
    accessory: "Magnifier monocle and checklist clipboard.",
    sampleStatus: "idle",
    sampleTask: "Waiting for the next deliverable",
  },
  {
    id: "tempo",
    name: "Tempo",
    role: "Scheduling",
    colorToken: "--status-info",
    silhouette: "Round clock-face torso on a single wheel.",
    accessory: "Orbiting ring with hour markers.",
    sampleStatus: "completed",
    sampleTask: "Published the content calendar for next week",
  },
  {
    id: "relay",
    name: "Relay",
    role: "Publishing",
    colorToken: "--primary",
    silhouette: "Streamlined forward-leaning body with twin antennae.",
    accessory: "Delivery backpack with signal fins.",
    sampleStatus: "failed",
    sampleTask: "Upload rejected: missing thumbnail",
  },
  {
    id: "ledger",
    name: "Ledger",
    role: "Analytics",
    colorToken: "--secondary",
    silhouette: "Wide, stable rectangular body like a filing cabinet.",
    accessory: "Chest display showing a tiny live bar chart.",
    sampleStatus: "completed",
    sampleTask: "Compiled last week's engagement report",
  },
]
