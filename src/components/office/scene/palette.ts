import type { EmployeeStatus } from "@/config/employee-status"

/**
 * 3D colors. Glow colors are the bright (dark-theme) brand token values and stay
 * the same in both themes, because emissive light must stay luminous. The room
 * itself switches between a navy night office and a light day office.
 * tests/office.test.ts checks these against src/app/globals.css.
 */
export const glow = {
  primary: "#2dd4bf",
  secondary: "#a78bfa",
  accent: "#ffb86b",
  success: "#4ade80",
  danger: "#f87171",
  muted: "#9eb2c9",
} as const

export const statusGlow: Record<EmployeeStatus, string> = {
  idle: "#9eb2c9",
  working: "#2dd4bf",
  waiting: "#ffb86b",
  completed: "#4ade80",
  failed: "#f87171",
}

export type SceneTheme = "dark" | "light"

export const environment = {
  dark: {
    floor: "#13213a",
    floorInset: "#0f1b2e",
    wall: "#0c1626",
    wallInner: "#13233b",
    trim: "#1d2f4a",
    desk: "#22344f",
    deskTop: "#2d4568",
    metal: "#3a5070",
    body: "#dde8f5",
    bodyShade: "#93a8c2",
    visor: "#0a1220",
    plant: "#1f9e7a",
    pot: "#2a3f5e",
    shadow: "#000814",
    window: "#0a1a33",
    glass: "#9fdcff",
    fabric: "#2b3f63",
    wood: "#6b4f3a",
    hemiSky: "#8fb4e0",
    hemiGround: "#0b1424",
    hemiIntensity: 1.1,
    keyIntensity: 1.6,
  },
  light: {
    // Day office: soft blue-grey surfaces so the white robots keep contrast.
    floor: "#aebdd0",
    floorInset: "#9fb0c6",
    wall: "#cdd7e4",
    wallInner: "#c0ccdb",
    trim: "#a9b8cb",
    desk: "#7f94ae",
    deskTop: "#e4eaf2",
    metal: "#6f839d",
    body: "#ffffff",
    bodyShade: "#b9c7d8",
    visor: "#17202e",
    plant: "#2f9e78",
    pot: "#8ea2bb",
    shadow: "#1b2a40",
    window: "#1c2f52",
    glass: "#7fb8d9",
    fabric: "#6f87a8",
    wood: "#b98a64",
    hemiSky: "#ffffff",
    hemiGround: "#9fb0c6",
    hemiIntensity: 1.3,
    keyIntensity: 1.35,
  },
} as const satisfies Record<SceneTheme, Record<string, string | number>>
