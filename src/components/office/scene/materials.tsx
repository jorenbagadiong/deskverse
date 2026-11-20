"use client"

import { createContext, useContext, useEffect, useMemo } from "react"
import * as THREE from "three"

import type { EmployeeStatus } from "@/config/employee-status"

import { environment, glow, type SceneTheme } from "./palette"

export type GlowKey = keyof typeof glow

function surface(
  color: string,
  extra: THREE.MeshStandardMaterialParameters = {},
) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra })
}

/** Unlit, tone-mapping-free: reads as a light source without postprocessing. */
function emissive(color: string) {
  return new THREE.MeshBasicMaterial({ color, toneMapped: false })
}

/** Translucent, double-sided holographic panel. */
function hologram(color: string, opacity = 0.3) {
  return new THREE.MeshBasicMaterial({
    color,
    toneMapped: false,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
}

function byGlow<T>(make: (color: string) => T) {
  return Object.fromEntries(
    (Object.keys(glow) as GlowKey[]).map((key) => [key, make(glow[key])]),
  ) as Record<GlowKey, T>
}

/** Per-employee identity materials, created once per color and shared. */
class IdentityMaterials {
  private readonly sets = new Map<
    string,
    ReturnType<typeof createIdentitySet>
  >()
  get(hex: string) {
    let set = this.sets.get(hex)
    if (!set) {
      set = createIdentitySet(hex)
      this.sets.set(hex, set)
    }
    return set
  }
  dispose() {
    for (const set of this.sets.values())
      for (const m of Object.values(set)) m.dispose()
    this.sets.clear()
  }
}

function createIdentitySet(hex: string) {
  const base = new THREE.Color(hex)
  const deep = base.clone().lerp(new THREE.Color("#0b1424"), 0.35)
  const eye = base.clone().lerp(new THREE.Color("#ffffff"), 0.72)
  return {
    /** Painted toy plastic in the identity color. */
    accent: new THREE.MeshPhysicalMaterial({
      color: base,
      roughness: 0.38,
      clearcoat: 0.6,
      clearcoatRoughness: 0.3,
    }),
    accentDeep: new THREE.MeshStandardMaterial({ color: deep, roughness: 0.5 }),
    glow: emissive(hex),
    /** Digital eyes: near-white with a hint of the identity color. */
    eye: emissive(`#${eye.getHexString()}`),
    holo: hologram(hex, 0.28),
  }
}

function createMaterials(theme: SceneTheme) {
  const env = environment[theme]
  return {
    floor: surface(env.floor, { roughness: 0.85 }),
    floorInset: surface(env.floorInset, { roughness: 0.9 }),
    wall: surface(env.wall, { roughness: 0.9 }),
    wallInner: surface(env.wallInner, { roughness: 0.9 }),
    trim: surface(env.trim, { roughness: 0.6 }),
    desk: surface(env.desk, { roughness: 0.55 }),
    deskTop: surface(env.deskTop, { roughness: 0.35 }),
    metal: surface(env.metal, { metalness: 0.55, roughness: 0.35 }),
    plant: surface(env.plant, { roughness: 0.75 }),
    pot: surface(env.pot, { roughness: 0.5 }),
    window: surface(env.window, { roughness: 0.15, metalness: 0.2 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: env.glass,
      transparent: true,
      opacity: theme === "dark" ? 0.18 : 0.28,
      roughness: 0.08,
      metalness: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    fabric: surface(env.fabric, { roughness: 0.95 }),
    wood: surface(env.wood, { roughness: 0.6 }),
    shadow: new THREE.MeshBasicMaterial({
      color: env.shadow,
      transparent: true,
      opacity: theme === "dark" ? 0.42 : 0.16,
      depthWrite: false,
    }),
    white: emissive("#ffffff"),
    glow: byGlow(emissive),
    screen: byGlow((c) => hologram(c)),
    // Character materials: collectible-toy finish (clear-coated plastic).
    shell: new THREE.MeshPhysicalMaterial({
      color: "#f4f7fb",
      roughness: 0.3,
      clearcoat: 0.8,
      clearcoatRoughness: 0.22,
    }),
    shellShade: new THREE.MeshPhysicalMaterial({
      color: "#c9d4e2",
      roughness: 0.42,
      clearcoat: 0.4,
      clearcoatRoughness: 0.35,
    }),
    joint: new THREE.MeshStandardMaterial({
      color: "#34405a",
      roughness: 0.45,
      metalness: 0.25,
    }),
    face: new THREE.MeshPhysicalMaterial({
      color: "#0a1120",
      roughness: 0.12,
      metalness: 0.15,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
    }),
    blush: new THREE.MeshBasicMaterial({
      color: "#ff8fab",
      transparent: true,
      opacity: 0.5,
      toneMapped: false,
      depthWrite: false,
    }),
    eyeAlert: emissive("#ff8b8b"),
    /** Invisible but raycastable: generous click/tap targets. */
    hitArea: new THREE.MeshBasicMaterial({ visible: false }),
    identity: new IdentityMaterials(),
  }
}

export type SceneMaterials = ReturnType<typeof createMaterials>

function disposeAll(materials: SceneMaterials) {
  const { glow: glows, screen, identity, ...rest } = materials
  for (const material of [
    ...Object.values(rest),
    ...Object.values(glows),
    ...Object.values(screen),
  ]) {
    material.dispose()
  }
  identity.dispose()
}

const MaterialsContext = createContext<SceneMaterials | null>(null)

/**
 * Shared materials for the whole scene: one instance per look, not per mesh.
 * Recreated when the theme changes; the previous set is disposed. (After a
 * dispose three.js re-uploads lazily, so Strict Mode's double effects are safe.)
 */
export function SceneMaterialsProvider({
  theme,
  children,
}: {
  theme: SceneTheme
  children: React.ReactNode
}) {
  const materials = useMemo(() => createMaterials(theme), [theme])
  useEffect(() => () => disposeAll(materials), [materials])
  return (
    <MaterialsContext.Provider value={materials}>
      {children}
    </MaterialsContext.Provider>
  )
}

export function useSceneMaterials() {
  const materials = useContext(MaterialsContext)
  if (!materials)
    throw new Error(
      "useSceneMaterials must be used inside <SceneMaterialsProvider>",
    )
  return materials
}

export function useIdentityMaterials(hex: string) {
  return useSceneMaterials().identity.get(hex)
}

export const statusGlowKey: Record<EmployeeStatus, GlowKey> = {
  idle: "muted",
  working: "primary",
  waiting: "accent",
  completed: "success",
  failed: "danger",
}
