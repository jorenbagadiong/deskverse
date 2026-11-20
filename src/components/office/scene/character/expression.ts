/**
 * Facial expressions as pure data. Each employee has a resting face
 * (personality); status changes swap eye/mouth glyphs. Tested in
 * tests/character.test.ts.
 */
import type { EmployeeStatus } from "@/config/employee-status"
import type { CharacterLook } from "@/config/office"

export type EyeShape = "round" | "pill" | "half" | "narrow" | "happy" | "sad"
export type MouthShape = "smile" | "grin" | "flat" | "frown" | "o"

export type Expression = {
  eyes: EyeShape
  mouth: MouthShape
  /** Alert eyes glow red (failure). */
  alert: boolean
}

export function expressionFor(
  status: EmployeeStatus,
  look: Pick<CharacterLook, "eyes" | "mouth">,
): Expression {
  switch (status) {
    case "completed":
      return { eyes: "happy", mouth: "grin", alert: false }
    case "failed":
      return { eyes: "sad", mouth: "frown", alert: true }
    case "waiting":
      // Wide-awake and attentive, looking at the viewer.
      return {
        eyes: look.eyes === "round" ? "round" : "pill",
        mouth: "o",
        alert: false,
      }
    case "working":
      // Concentrating: curious faces stay wide-eyed, others narrow their focus.
      return {
        eyes: look.eyes === "round" ? "round" : "half",
        mouth: "flat",
        alert: false,
      }
    default:
      return { eyes: look.eyes, mouth: look.mouth, alert: false }
  }
}
