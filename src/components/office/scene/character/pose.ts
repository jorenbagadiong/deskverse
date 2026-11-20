/**
 * Character poses as pure data + pure functions of time.
 * No three.js, no React: deterministic and unit-tested (tests/character.test.ts).
 *
 * Arm convention (mirrored for both sides):
 *   swing  rotation.x at the shoulder; negative = forward/up in front
 *   raise  outward rotation; positive = away from the body (applied as side * raise)
 *   elbow  forearm bend; negative = bends forward
 */
import type { EmployeeStatus } from "@/config/employee-status"
import type { WorkstationKind } from "@/config/office"

export type ArmPose = { swing: number; raise: number; elbow: number }

export type Pose = {
  /** Forward lean of the upper body (radians). */
  lean: number
  /** Body turn around Y; positive turns toward the camera side (+x). */
  twist: number
  headPitch: number
  headYaw: number
  headRoll: number
  left: ArmPose
  right: ArmPose
}

const arm = (swing: number, raise: number, elbow: number): ArmPose => ({
  swing,
  raise,
  elbow,
})

export const RELAXED: Pose = {
  lean: 0,
  twist: 0,
  headPitch: 0.02,
  headYaw: 0,
  headRoll: 0,
  left: arm(0.05, 0.14, -0.18),
  right: arm(0.05, 0.14, -0.18),
}

/** Base working pose per role: where the hands and gaze go at that desk. */
const WORKING: Record<WorkstationKind, Pose> = {
  // Scout holds the scanner up toward the floating research panels.
  research: {
    ...RELAXED,
    lean: 0.04,
    headPitch: 0.04,
    left: arm(-0.7, 0.1, -0.6),
    right: arm(-1.25, 0.28, -0.4),
  },
  // Quill types, head bowed over the keyboard.
  writing: {
    ...RELAXED,
    lean: 0.08,
    headPitch: 0.12,
    left: arm(-1.1, 0.06, -0.5),
    right: arm(-1.1, 0.06, -0.5),
  },
  // Pixel works the jog wheel and the edit keys.
  video: {
    ...RELAXED,
    lean: 0.06,
    headPitch: 0.08,
    left: arm(-1.0, 0.1, -0.6),
    right: arm(-1.15, 0.22, -0.45),
  },
  // Vera leans in to inspect the document on the light table.
  review: {
    ...RELAXED,
    lean: 0.1,
    headPitch: 0.16,
    left: arm(-0.8, 0.08, -0.7),
    right: arm(-1.25, 0.15, -0.3),
  },
  // Tempo reaches up to the calendar wall on their left.
  schedule: {
    ...RELAXED,
    headPitch: -0.06,
    headYaw: -0.4,
    left: arm(-1.25, 0.75, -0.25),
    right: arm(-0.5, 0.1, -0.4),
  },
  // Relay tosses data packets up toward the transmitter.
  publish: {
    ...RELAXED,
    lean: 0.06,
    headPitch: -0.12,
    left: arm(-1.0, 0.2, -0.5),
    right: arm(-1.55, 0.4, -0.2),
  },
  // Ledger: hand on chin, the other pointing at the chart.
  analytics: {
    ...RELAXED,
    lean: 0.02,
    headPitch: 0.02,
    headRoll: 0.08,
    left: arm(-0.4, 0.18, -2.25),
    right: arm(-1.35, 0.25, -0.15),
  },
}

export function basePose(status: EmployeeStatus, kind: WorkstationKind): Pose {
  switch (status) {
    case "working":
      return WORKING[kind]
    case "waiting":
      // Turns toward the viewer and raises a hand to ask for approval.
      return {
        ...RELAXED,
        twist: 0.45,
        headPitch: -0.18,
        headYaw: 0.1,
        right: arm(-0.2, 2.55, -0.35),
      }
    case "completed":
      return {
        ...RELAXED,
        headPitch: -0.08,
        left: arm(0, 0.35, -0.3),
        right: arm(0, 0.35, -0.3),
      }
    case "failed":
      // Slumped and disappointed.
      return {
        ...RELAXED,
        lean: 0.12,
        headPitch: 0.16,
        headRoll: 0.2,
        left: arm(0.18, 0.06, -0.05),
        right: arm(0.18, 0.06, -0.05),
      }
    default:
      return RELAXED
  }
}

/** Smoothed square wave in [-1, 1]: holds at each side, eases between. */
export function smoothSquare(t: number, period: number) {
  return Math.max(-1, Math.min(1, Math.sin((2 * Math.PI * t) / period) * 2.5))
}

/** A bump in [0, 1] of the given duration at the start of every period. */
export function pulse(t: number, period: number, duration: number) {
  const phase = ((t % period) + period) % period
  return phase < duration ? Math.sin((Math.PI * phase) / duration) : 0
}

const ZERO_ARM = arm(0, 0, 0)
export const NO_MOTION: Pose = {
  lean: 0,
  twist: 0,
  headPitch: 0,
  headYaw: 0,
  headRoll: 0,
  left: ZERO_ARM,
  right: ZERO_ARM,
}

/** Role-specific looping motion while working, added on top of the base pose. */
export function workingMotion(kind: WorkstationKind, t: number): Pose {
  const s = Math.sin
  switch (kind) {
    case "research":
      return {
        ...NO_MOTION,
        headYaw: 0.42 * smoothSquare(t, 3.2),
        right: arm(0.12 * s(2 * t), 0.1 * s(1.3 * t), 0),
      }
    case "writing":
      return {
        ...NO_MOTION,
        headPitch: -0.18 * pulse(t, 5, 1.3),
        left: arm(0, 0, 0.12 * s(16 * t)),
        right: arm(0, 0, 0.12 * s(16 * t + Math.PI)),
      }
    case "video":
      return {
        ...NO_MOTION,
        headPitch: 0.04 * s(4 * t),
        headYaw: 0.2 * s(0.8 * t),
        left: arm(0, 0, 0.1 * s(9 * t)),
        right: arm(0.08 * Math.cos(3 * t), 0.12 * s(3 * t), 0),
      }
    case "review": {
      const stamp = pulse(t, 4.5, 0.45)
      return {
        ...NO_MOTION,
        headYaw: 0.3 * s(1.1 * t),
        right: arm(0.5 * stamp, 0.1 * s(1.1 * t), -0.2 * stamp),
      }
    }
    case "schedule":
      return {
        ...NO_MOTION,
        headYaw: 0.1 * s(1.6 * t),
        left: arm(0.1 * s(3.2 * t), 0.15 * s(1.6 * t), 0),
      }
    case "publish":
      return {
        ...NO_MOTION,
        lean: 0.04 * s(5.6 * t),
        left: arm(0, 0, 0.15 * s(5.6 * t)),
        right: arm(-0.45 * Math.max(0, s(2.8 * t)), 0, 0),
      }
    case "analytics":
      return {
        ...NO_MOTION,
        headPitch: 0.05 * s(1.8 * t),
        headRoll: 0.06 * s(0.9 * t),
        right: arm(0.06 * s(2.4 * t), 0.12 * s(1.2 * t), 0),
      }
  }
}

export function addPose(a: Pose, b: Pose): Pose {
  const addArm = (x: ArmPose, y: ArmPose) =>
    arm(x.swing + y.swing, x.raise + y.raise, x.elbow + y.elbow)
  return {
    lean: a.lean + b.lean,
    twist: a.twist + b.twist,
    headPitch: a.headPitch + b.headPitch,
    headYaw: a.headYaw + b.headYaw,
    headRoll: a.headRoll + b.headRoll,
    left: addArm(a.left, b.left),
    right: addArm(a.right, b.right),
  }
}

/** One-off reactions that play once when a status is entered (seconds). */
export const TRANSIENT_SECONDS: Partial<Record<EmployeeStatus, number>> = {
  completed: 1.2,
  failed: 0.7,
  waiting: 1.2,
}

export type Transient = {
  /** Vertical hop (scene units). */
  hop: number
  /** Celebration spin (radians). */
  spin: number
  /** Disappointed side-to-side shake (scene units). */
  shake: number
  /** 0..1 blend toward arms-up celebration. */
  armsUp: number
  /** Hand wave offset for the raised arm (radians). */
  wave: number
}

export const NO_TRANSIENT: Transient = {
  hop: 0,
  spin: 0,
  shake: 0,
  armsUp: 0,
  wave: 0,
}

const easeOutCubic = (k: number) => 1 - (1 - k) ** 3

export function transient(status: EmployeeStatus, since: number): Transient {
  const duration = TRANSIENT_SECONDS[status]
  if (!duration || since < 0 || since >= duration) return NO_TRANSIENT
  const k = since / duration
  switch (status) {
    case "completed":
      return {
        ...NO_TRANSIENT,
        hop: Math.sin(k * Math.PI) * 0.28,
        spin: easeOutCubic(k) * Math.PI * 2,
        armsUp: Math.sin(k * Math.PI),
      }
    case "failed":
      return { ...NO_TRANSIENT, shake: Math.sin(since * 48) * 0.045 * (1 - k) }
    case "waiting":
      return { ...NO_TRANSIENT, wave: Math.sin(since * 14) * 0.28 * (1 - k) }
    default:
      return NO_TRANSIENT
  }
}

/** Idle glance: a short look to the side, triggered by the ambient scheduler. */
export const GLANCE_SECONDS = 0.9
export const BLINK_SECONDS = 0.16

export function glanceYaw(since: number, direction: 1 | -1) {
  if (since < 0 || since >= GLANCE_SECONDS) return 0
  return direction * 0.35 * Math.sin((Math.PI * since) / GLANCE_SECONDS)
}

/** Eye openness 0..1 during a blink (1 = open). */
export function blinkOpenness(since: number) {
  if (since < 0 || since >= BLINK_SECONDS) return 1
  return Math.max(0.08, Math.abs(Math.cos((Math.PI * since) / BLINK_SECONDS)))
}
