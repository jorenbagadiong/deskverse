/**
 * Human-readable metadata for the color tokens defined in src/app/globals.css.
 * Used by the /brand showcase. tests/design-tokens.test.ts verifies these hex
 * values match the stylesheet, so this list cannot silently drift.
 */
export type ColorToken = {
  name: string
  token: `--${string}`
  dark: string
  light: string
  /** Token of the text color intended to sit on this color, if any. */
  onToken?: `--${string}`
  usage: string
}

export const brandColors: ColorToken[] = [
  {
    name: "Background",
    token: "--background",
    dark: "#080f1c",
    light: "#f5f8fc",
    onToken: "--foreground",
    usage: "App canvas",
  },
  {
    name: "Surface",
    token: "--surface",
    dark: "#111d2e",
    light: "#ffffff",
    onToken: "--foreground",
    usage: "Cards, panels",
  },
  {
    name: "Primary",
    token: "--primary",
    dark: "#2dd4bf",
    light: "#087d76",
    onToken: "--primary-foreground",
    usage: "Main actions, focus, working state",
  },
  {
    name: "Secondary",
    token: "--secondary",
    dark: "#a78bfa",
    light: "#6a45d1",
    onToken: "--secondary-foreground",
    usage: "Supporting actions, AI identity",
  },
  {
    name: "Accent",
    token: "--accent",
    dark: "#ffb86b",
    light: "#9a4a0a",
    onToken: "--accent-foreground",
    usage: "Highlights, approvals",
  },
  {
    name: "Foreground",
    token: "--foreground",
    dark: "#eaf3ff",
    light: "#17202e",
    usage: "Body text",
  },
  {
    name: "Muted",
    token: "--muted-foreground",
    dark: "#9eb2c9",
    light: "#4a5b70",
    usage: "Secondary text, captions",
  },
]

export const statusColors: ColorToken[] = [
  {
    name: "Idle",
    token: "--status-idle",
    dark: "#9eb2c9",
    light: "#526378",
    usage: "Available",
  },
  {
    name: "Working",
    token: "--status-working",
    dark: "#2dd4bf",
    light: "#087d76",
    usage: "In progress",
  },
  {
    name: "Waiting",
    token: "--status-waiting",
    dark: "#ffb86b",
    light: "#9a4a0a",
    usage: "Needs approval",
  },
  {
    name: "Completed",
    token: "--status-completed",
    dark: "#4ade80",
    light: "#157f3c",
    usage: "Success",
  },
  {
    name: "Failed",
    token: "--status-failed",
    dark: "#f87171",
    light: "#c0262d",
    usage: "Error",
  },
]
