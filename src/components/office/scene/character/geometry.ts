import * as THREE from "three"

import type { CharacterLook } from "@/config/office"

import { geometryCache } from "../shared/geometry-cache"
import {
  arcBandShape,
  beveledPlate,
  flat,
  roundedBox,
  roundedRectShape,
  smoothLathe,
} from "../shared/shapes"

import type { EyeShape, MouthShape } from "./expression"

/**
 * Character proportions. One rig for everyone: oversized head (~45% of the
 * height), compact egg-shaped body, short articulated limbs.
 */
export const RIG = {
  hipY: 0.3,
  shoulderY: 0.58,
  neckY: 0.7,
  legX: 0.11,
} as const

export type HeadSpec = {
  width: number
  height: number
  depth: number
  radius: number
  /** Face screen size [w, h]. */
  face: [number, number]
  eyeX: number
  form: "box" | "sphere" | "capsule"
}

export const HEADS: Record<CharacterLook["head"], HeadSpec> = {
  soft: {
    width: 0.68,
    height: 0.56,
    depth: 0.58,
    radius: 0.22,
    face: [0.5, 0.34],
    eyeX: 0.115,
    form: "box",
  },
  tall: {
    width: 0.6,
    height: 0.64,
    depth: 0.56,
    radius: 0.24,
    face: [0.44, 0.38],
    eyeX: 0.1,
    form: "box",
  },
  wide: {
    width: 0.84,
    height: 0.52,
    depth: 0.58,
    radius: 0.22,
    face: [0.64, 0.32],
    eyeX: 0.15,
    form: "box",
  },
  screen: {
    width: 0.8,
    height: 0.56,
    depth: 0.5,
    radius: 0.11,
    face: [0.66, 0.42],
    eyeX: 0.14,
    form: "box",
  },
  orb: {
    width: 0.66,
    height: 0.66,
    depth: 0.66,
    radius: 0.33,
    face: [0.46, 0.32],
    eyeX: 0.11,
    form: "sphere",
  },
  capsule: {
    width: 0.54,
    height: 0.74,
    depth: 0.54,
    radius: 0.27,
    face: [0.44, 0.3],
    eyeX: 0.1,
    form: "capsule",
  },
}

export const BUILDS: Record<CharacterLook["build"], [number, number, number]> =
  {
    standard: [1, 1, 1],
    slim: [0.88, 1.05, 0.9],
    sturdy: [1.16, 0.97, 1.06],
  }

const VISOR_GAP = 0.012

export function headShellGeometry(kind: CharacterLook["head"]) {
  const h = HEADS[kind]
  return geometryCache.get(`head:${kind}`, () => {
    if (h.form === "sphere") return new THREE.SphereGeometry(h.radius, 32, 22)
    if (h.form === "capsule")
      return new THREE.CapsuleGeometry(
        h.radius,
        h.height - h.radius * 2,
        12,
        28,
      )
    return roundedBox(h.width, h.height, h.depth, h.radius, 4)
  })
}

/** Glossy face screen: flat beveled plate on boxy heads, curved visor on round ones. */
export function faceGeometry(kind: CharacterLook["head"]) {
  const h = HEADS[kind]
  return geometryCache.get(`face:${kind}`, () => {
    const [fw, fh] = h.face
    if (h.form === "sphere") {
      const r = h.radius + VISOR_GAP
      const halfW = Math.asin(Math.min(0.95, fw / 2 / r))
      const halfH = Math.asin(Math.min(0.95, fh / 2 / r))
      return new THREE.SphereGeometry(
        r,
        32,
        16,
        Math.PI / 2 - halfW,
        halfW * 2,
        Math.PI / 2 - halfH,
        halfH * 2,
      )
    }
    if (h.form === "capsule") {
      const r = h.radius + VISOR_GAP
      const halfW = Math.asin(Math.min(0.95, fw / 2 / r))
      return new THREE.CylinderGeometry(
        r,
        r,
        fh,
        28,
        1,
        true,
        -halfW,
        halfW * 2,
      )
    }
    return beveledPlate(roundedRectShape(fw, fh, fh * 0.42), 0.05, 0.012)
  })
}

/** Z of the face surface at (x, y), so eyes sit on flat or curved screens. */
export function faceSurface(kind: CharacterLook["head"], x: number, y: number) {
  const h = HEADS[kind]
  if (h.form === "sphere") {
    const r = h.radius + VISOR_GAP
    const z = Math.sqrt(Math.max(0, r * r - x * x - y * y))
    return { z: z + 0.004, yaw: Math.asin(x / r), pitch: -Math.asin(y / r) }
  }
  if (h.form === "capsule") {
    const r = h.radius + VISOR_GAP
    return {
      z: Math.sqrt(Math.max(0, r * r - x * x)) + 0.004,
      yaw: Math.asin(x / r),
      pitch: 0,
    }
  }
  return { z: h.depth / 2 + 0.018, yaw: 0, pitch: 0 }
}

export function eyeGeometry(shape: EyeShape) {
  return geometryCache.get(`eye:${shape}`, () => {
    switch (shape) {
      case "round":
        return new THREE.CircleGeometry(0.068, 28)
      case "half":
        return flat(roundedRectShape(0.1, 0.056, 0.026))
      case "narrow":
        return flat(roundedRectShape(0.11, 0.048, 0.022))
      case "happy":
        return flat(arcBandShape(0.055, 0.028, Math.PI * 0.12, Math.PI * 0.88))
      case "sad":
        return flat(roundedRectShape(0.08, 0.09, 0.034))
      default:
        return flat(roundedRectShape(0.09, 0.14, 0.045))
    }
  })
}

export function mouthGeometry(shape: MouthShape) {
  return geometryCache.get(`mouth:${shape}`, () => {
    switch (shape) {
      case "grin": {
        // Open "D" smile: a filled half-disc.
        const s = new THREE.Shape()
        s.absarc(0, 0, 0.05, Math.PI, Math.PI * 2, false)
        s.lineTo(-0.05, 0)
        return flat(s, 16)
      }
      case "flat":
        return flat(roundedRectShape(0.07, 0.018, 0.009))
      case "frown":
        return flat(arcBandShape(0.045, 0.018, Math.PI * 0.18, Math.PI * 0.82))
      case "o":
        return new THREE.RingGeometry(0.016, 0.03, 20)
      default:
        return flat(arcBandShape(0.045, 0.018, Math.PI * 1.18, Math.PI * 1.82))
    }
  })
}

export const torsoGeometry = () =>
  geometryCache.get("torso", () =>
    smoothLathe(
      [
        [0.15, 0],
        [0.215, 0.04],
        [0.245, 0.13],
        [0.235, 0.24],
        [0.2, 0.33],
        [0.14, 0.4],
        [0.07, 0.43],
      ],
      16,
      24,
    ),
  )

export const g = {
  sphere: (r: number, w = 16, h = 12) =>
    geometryCache.get(
      `sphere:${r}:${w}:${h}`,
      () => new THREE.SphereGeometry(r, w, h),
    ),
  capsule: (r: number, len: number) =>
    geometryCache.get(
      `capsule:${r}:${len}`,
      () => new THREE.CapsuleGeometry(r, len, 4, 12),
    ),
  cylinder: (rt: number, rb: number, h: number, seg = 24) =>
    geometryCache.get(
      `cyl:${rt}:${rb}:${h}:${seg}`,
      () => new THREE.CylinderGeometry(rt, rb, h, seg),
    ),
  torus: (
    r: number,
    tube: number,
    arc = Math.PI * 2,
    radial = 8,
    tubular = 32,
  ) =>
    geometryCache.get(
      `torus:${r}:${tube}:${arc}:${radial}:${tubular}`,
      () => new THREE.TorusGeometry(r, tube, radial, tubular, arc),
    ),
  /**
   * Rounded box sized to how much the bevel shows: hairline details are plain
   * boxes (12 triangles), small parts get one bevel segment (108), larger
   * furniture two (300). Head shells use their own high-smoothness geometry.
   */
  box: (w: number, h: number, d: number, r = 0.02) =>
    geometryCache.get(`rbox:${w}:${h}:${d}:${r}`, () =>
      r <= 0.012 || Math.min(w, h, d) <= 0.012
        ? new THREE.BoxGeometry(w, h, d)
        : roundedBox(w, h, d, r, r >= 0.05 ? 2 : 1),
    ),
  circle: (r: number, seg = 24) =>
    geometryCache.get(
      `circle:${r}:${seg}`,
      () => new THREE.CircleGeometry(r, seg),
    ),
  ring: (inner: number, outer: number, seg = 32) =>
    geometryCache.get(
      `ring:${inner}:${outer}:${seg}`,
      () => new THREE.RingGeometry(inner, outer, seg),
    ),
  plate: (w: number, h: number, depth = 0.03, bevel = 0.01) =>
    geometryCache.get(`plate:${w}:${h}:${depth}:${bevel}`, () =>
      beveledPlate(roundedRectShape(w, h, Math.min(w, h) * 0.3), depth, bevel),
    ),
  shape: (key: string, make: () => THREE.BufferGeometry) =>
    geometryCache.get(`shape:${key}`, make),
}
