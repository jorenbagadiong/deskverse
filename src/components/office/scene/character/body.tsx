"use client"

import * as THREE from "three"

import type { OfficeEmployee } from "@/config/office"

import { useIdentityMaterials, useSceneMaterials } from "../materials"
import { Batch } from "../shared/batch"
import { beveledPlate } from "../shared/shapes"

import { BUILDS, g, RIG, torsoGeometry } from "./geometry"

/** Two stubby legs with rounded toy feet in the identity color. */
export function Legs({ employee }: { employee: OfficeEmployee }) {
  const m = useSceneMaterials()
  const id = useIdentityMaterials(employee.glow)
  const [bx] = BUILDS[employee.look.build]
  return (
    <>
      {[-1, 1].map((side) => (
        <group key={side} position-x={side * RIG.legX * bx}>
          <mesh
            geometry={g.capsule(0.062, 0.12)}
            position-y={0.19}
            material={m.shellShade}
          />
          <mesh
            geometry={g.sphere(0.092, 18, 12)}
            position={[0, 0.052, 0.03]}
            scale={[1, 0.6, 1.32]}
            material={id.accent}
            castShadow
          />
        </group>
      ))}
    </>
  )
}

export function Torso({ employee }: { employee: OfficeEmployee }) {
  const m = useSceneMaterials()
  const id = useIdentityMaterials(employee.glow)
  const build = BUILDS[employee.look.build]
  return (
    <group scale={build}>
      <mesh
        geometry={torsoGeometry()}
        position-y={RIG.hipY - 0.04}
        material={m.shell}
        castShadow
      />
      {/* Identity waist band: the shared design-language stripe. */}
      <mesh
        geometry={g.torus(0.236, 0.03, Math.PI * 2, 8, 36)}
        position-y={0.36}
        rotation-x={Math.PI / 2}
        material={id.accent}
      />
      <mesh
        geometry={g.cylinder(0.07, 0.08, 0.07, 20)}
        position-y={RIG.neckY - 0.01}
        material={m.joint}
      />
    </group>
  )
}

/**
 * Two-joint arm. The shoulder pivots (swing/raise) and the elbow bends; both
 * groups are driven by the character's frame loop through refs.
 */
export function Arm({
  side,
  employee,
  shoulderRef,
  elbowRef,
  children,
}: {
  side: 1 | -1
  employee: OfficeEmployee
  shoulderRef: React.Ref<THREE.Group>
  elbowRef: React.Ref<THREE.Group>
  children?: React.ReactNode
}) {
  const m = useSceneMaterials()
  const [bx] = BUILDS[employee.look.build]
  // Each segment is one rigid, single-material group, merged by a nested
  // Batch: 2 draw calls per arm instead of 4.
  return (
    <group
      ref={shoulderRef}
      position={[side * (0.235 * bx + 0.03), RIG.shoulderY, 0]}
      userData={{ dynamic: true }}
    >
      <Batch>
        <mesh geometry={g.sphere(0.068, 16, 12)} material={m.shell} />
        <mesh
          geometry={g.capsule(0.05, 0.08)}
          position-y={-0.085}
          material={m.shell}
        />
        <group ref={elbowRef} position-y={-0.15} userData={{ dynamic: true }}>
          <Batch>
            <mesh
              geometry={g.capsule(0.047, 0.06)}
              position-y={-0.055}
              material={m.shellShade}
            />
            <group position-y={-0.135}>
              <mesh
                geometry={g.sphere(0.066, 16, 12)}
                material={m.shellShade}
              />
              {children}
            </group>
          </Batch>
        </group>
      </Batch>
    </group>
  )
}

/** Handheld scanner for Scout (attached to the right hand). */
export function Scanner({ employee }: { employee: OfficeEmployee }) {
  const m = useSceneMaterials()
  const id = useIdentityMaterials(employee.glow)
  return (
    <group position={[0.02, -0.04, 0.05]} rotation={[0.25, 0, -0.3]}>
      <mesh
        geometry={g.capsule(0.022, 0.1)}
        position-y={-0.06}
        material={m.joint}
      />
      <group position-y={-0.17} rotation-x={Math.PI / 2}>
        <mesh
          geometry={g.torus(0.07, 0.018, Math.PI * 2, 10, 28)}
          material={id.accent}
        />
        <mesh geometry={g.circle(0.062, 24)} material={id.holo} />
      </group>
    </group>
  )
}

/** Chest accessory: a second identity cue alongside the headgear. */
export function ChestItem({
  employee,
  notebookRef,
}: {
  employee: OfficeEmployee
  notebookRef: React.Ref<THREE.Group>
}) {
  const m = useSceneMaterials()
  const id = useIdentityMaterials(employee.glow)
  const [bx, , bz] = BUILDS[employee.look.build]
  const front = 0.235 * bz

  switch (employee.look.chest) {
    case "satchel":
      return (
        <>
          <mesh
            geometry={g.torus(0.27, 0.017, Math.PI * 2, 8, 40)}
            position-y={0.47}
            rotation={[Math.PI / 2, 0.55, 0]}
            scale={[bx, bz, 1]}
            material={id.accentDeep}
          />
          <group position={[0.21 * bx, 0.33, 0.12]} rotation-y={0.5}>
            <mesh
              geometry={g.box(0.17, 0.13, 0.08, 0.03)}
              material={id.accentDeep}
              castShadow
            />
            <mesh
              geometry={g.box(0.175, 0.06, 0.085, 0.02)}
              position-y={0.04}
              material={id.accent}
            />
          </group>
        </>
      )
    case "notebook":
      // Quill's notebook floats beside the shoulder (it hovers while working).
      return (
        <group
          ref={notebookRef}
          position={[-0.42 * bx, 0.62, 0.12]}
          rotation={[0.2, 0.5, 0.15]}
          userData={{ dynamic: true }}
        >
          <mesh
            geometry={g.box(0.17, 0.22, 0.035, 0.012)}
            material={id.accent}
            castShadow
          />
          <mesh
            geometry={g.box(0.15, 0.2, 0.038, 0.006)}
            position-x={0.006}
            material={m.white}
          />
          {[0.05, 0.0, -0.05].map((y) => (
            <mesh
              key={y}
              geometry={g.box(0.09, 0.01, 0.002, 0.003)}
              position={[0.01, y, 0.021]}
              material={id.accentDeep}
            />
          ))}
        </group>
      )
    case "film-belt":
      return (
        <group position-y={0.36} scale={[bx, 1, bz]}>
          <mesh
            geometry={g.torus(0.238, 0.036, Math.PI * 2, 10, 48)}
            rotation-x={Math.PI / 2}
            material={m.joint}
          />
          {[-0.12, 0, 0.12].map((x) => (
            <mesh
              key={x}
              geometry={g.box(0.05, 0.04, 0.012, 0.006)}
              position={[x, 0, Math.sqrt(0.272 ** 2 - x * x)]}
              rotation-y={Math.asin(x / 0.272)}
              material={m.white}
            />
          ))}
        </group>
      )
    case "shield":
      return (
        <group position={[0, 0.5, front + 0.005]} rotation-x={-0.18}>
          <mesh
            geometry={g.shape("shield", shieldGeometry)}
            material={id.accent}
            castShadow
          />
          <mesh
            geometry={g.box(0.03, 0.065, 0.01, 0.004)}
            position={[-0.015, -0.005, 0.03]}
            rotation-z={Math.PI / 4}
            material={m.white}
          />
          <mesh
            geometry={g.box(0.03, 0.11, 0.01, 0.004)}
            position={[0.022, 0.012, 0.03]}
            rotation-z={-Math.PI / 5}
            material={m.white}
          />
        </group>
      )
    case "clock":
      return (
        <group
          position={[0, 0.5, front - 0.01]}
          rotation-x={Math.PI / 2 - 0.18}
        >
          <mesh
            geometry={g.cylinder(0.105, 0.105, 0.03, 32)}
            material={id.accent}
          />
          <mesh
            geometry={g.cylinder(0.085, 0.085, 0.034, 32)}
            material={m.white}
          />
          <mesh
            geometry={g.box(0.016, 0.01, 0.07, 0.004)}
            position={[0, 0.02, -0.025]}
            material={id.accentDeep}
          />
          <mesh
            geometry={g.box(0.05, 0.01, 0.016, 0.004)}
            position={[0.02, 0.02, 0]}
            material={id.accentDeep}
          />
        </group>
      )
    case "messenger-bag":
      return (
        <>
          <mesh
            geometry={g.torus(0.27, 0.017, Math.PI * 2, 8, 40)}
            position-y={0.47}
            rotation={[Math.PI / 2, -0.55, 0]}
            scale={[bx, bz, 1]}
            material={id.accentDeep}
          />
          <group position={[-0.22 * bx, 0.33, 0.1]} rotation-y={-0.5}>
            <mesh
              geometry={g.box(0.2, 0.15, 0.08, 0.03)}
              material={id.accent}
              castShadow
            />
            <mesh
              geometry={g.box(0.12, 0.07, 0.01, 0.006)}
              position={[0, 0.01, 0.042]}
              material={m.white}
            />
          </group>
        </>
      )
    case "chart-display":
      return (
        <group position={[0, 0.5, front - 0.005]} rotation-x={-0.16}>
          <mesh geometry={g.plate(0.24, 0.16, 0.02, 0.008)} material={m.face} />
          {[-0.06, 0, 0.06].map((x, i) => (
            <mesh
              key={x}
              geometry={g.box(0.035, 0.04 + i * 0.03, 0.006, 0.004)}
              position={[x, -0.04 + (0.04 + i * 0.03) / 2, 0.02]}
              material={id.glow}
            />
          ))}
        </group>
      )
  }
}

function shieldGeometry() {
  const s = new THREE.Shape()
  s.moveTo(0, 0.1)
  s.quadraticCurveTo(0.05, 0.085, 0.085, 0.09)
  s.quadraticCurveTo(0.09, -0.02, 0, -0.1)
  s.quadraticCurveTo(-0.09, -0.02, -0.085, 0.09)
  s.quadraticCurveTo(-0.05, 0.085, 0, 0.1)
  return beveledPlate(s, 0.02, 0.01)
}
