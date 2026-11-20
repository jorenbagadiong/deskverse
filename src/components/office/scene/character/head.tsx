"use client"

import * as THREE from "three"

import type { OfficeEmployee } from "@/config/office"

import { useIdentityMaterials, useSceneMaterials } from "../materials"
import { beveledPlate, smoothLathe } from "../shared/shapes"

import type { Expression } from "./expression"
import {
  eyeGeometry,
  faceGeometry,
  faceSurface,
  g,
  HEADS,
  headShellGeometry,
  mouthGeometry,
} from "./geometry"

const EYE_Y = 0.025
const MOUTH_Y = -0.085

/**
 * Head: shell + glossy face screen + expressive digital face + headgear.
 * Centered on the head's middle; the parent positions it above the neck.
 */
export function Head({
  employee,
  expression,
  eyesRef,
  orbitRef,
}: {
  employee: OfficeEmployee
  expression: Expression
  eyesRef: React.Ref<THREE.Group>
  orbitRef: React.Ref<THREE.Group>
}) {
  const m = useSceneMaterials()
  const id = useIdentityMaterials(employee.glow)
  const kind = employee.look.head
  const spec = HEADS[kind]
  const eyeMaterial = expression.alert ? m.eyeAlert : id.eye

  const eye = (side: 1 | -1) => {
    const x = side * spec.eyeX
    const s = faceSurface(kind, x, EYE_Y)
    // Sad eyes droop toward the outside.
    const tilt = expression.eyes === "sad" ? -side * 0.38 : 0
    return (
      <mesh
        key={side}
        geometry={eyeGeometry(expression.eyes)}
        material={eyeMaterial}
        position={[x, EYE_Y, s.z]}
        rotation={[s.pitch, s.yaw, tilt]}
      />
    )
  }
  const mouthSurface = faceSurface(kind, 0, MOUTH_Y)
  const blush = (side: 1 | -1) => {
    const x = side * (spec.eyeX + 0.085)
    const s = faceSurface(kind, x, -0.06)
    return (
      <mesh
        key={side}
        geometry={g.circle(0.038, 16)}
        material={m.blush}
        position={[x, -0.06, s.z - 0.001]}
        rotation={[s.pitch, s.yaw, 0]}
      />
    )
  }

  return (
    <group>
      <mesh geometry={headShellGeometry(kind)} material={m.shell} castShadow />
      {spec.form === "box" ? (
        // Identity-colored bezel framing the face screen.
        <mesh
          geometry={g.plate(
            spec.face[0] + 0.05,
            spec.face[1] + 0.05,
            0.03,
            0.012,
          )}
          material={id.accent}
          position-z={spec.depth / 2 - 0.03}
        />
      ) : null}
      <mesh
        geometry={faceGeometry(kind)}
        material={m.face}
        position-z={spec.form === "box" ? spec.depth / 2 - 0.022 : 0}
      />
      <group
        ref={eyesRef}
        position-y={EYE_Y}
        scale={1}
        userData={{ dynamic: true }}
      >
        <group position-y={-EYE_Y}>
          {eye(-1)}
          {eye(1)}
        </group>
      </group>
      <mesh
        geometry={mouthGeometry(expression.mouth)}
        material={eyeMaterial}
        position={[0, MOUTH_Y, mouthSurface.z]}
        rotation-x={mouthSurface.pitch}
      />
      {blush(-1)}
      {blush(1)}
      <Headgear employee={employee} orbitRef={orbitRef} />
    </group>
  )
}

function EarDiscs({ employee }: { employee: OfficeEmployee }) {
  const id = useIdentityMaterials(employee.glow)
  const spec = HEADS[employee.look.head]
  return (
    <>
      {[-1, 1].map((side) => (
        <group
          key={side}
          position-x={side * (spec.width / 2 + 0.005)}
          rotation-z={Math.PI / 2}
        >
          <mesh
            geometry={g.cylinder(0.095, 0.095, 0.06, 28)}
            material={id.accent}
          />
          <mesh
            geometry={g.cylinder(0.045, 0.045, 0.064, 20)}
            material={id.glow}
          />
        </group>
      ))}
    </>
  )
}

function Headgear({
  employee,
  orbitRef,
}: {
  employee: OfficeEmployee
  orbitRef: React.Ref<THREE.Group>
}) {
  const m = useSceneMaterials()
  const id = useIdentityMaterials(employee.glow)
  const spec = HEADS[employee.look.head]
  const top = spec.height / 2

  switch (employee.look.headgear) {
    case "explorer-cap":
      // Scout: explorer's cap with a scanning headlamp.
      return (
        <>
          <EarDiscs employee={employee} />
          <group position-y={top - 0.09} rotation-x={-0.1}>
            <mesh
              geometry={g.shape("cap-dome", () =>
                smoothLathe(
                  [
                    [0.33, 0],
                    [0.32, 0.07],
                    [0.26, 0.15],
                    [0.15, 0.2],
                    [0.02, 0.215],
                  ],
                  18,
                  32,
                ),
              )}
              material={id.accent}
              castShadow
            />
            <mesh
              geometry={g.cylinder(0.4, 0.4, 0.025, 40)}
              position={[0, 0.005, 0.06]}
              scale={[1, 1, 0.92]}
              material={id.accentDeep}
            />
            <mesh
              geometry={g.torus(0.325, 0.022, Math.PI * 2, 8, 40)}
              position-y={0.03}
              rotation-x={Math.PI / 2}
              material={m.shellShade}
            />
            <group position={[0, 0.07, 0.3]} rotation-x={Math.PI / 2 - 0.25}>
              <mesh
                geometry={g.cylinder(0.055, 0.06, 0.05, 20)}
                material={m.joint}
              />
              <mesh
                geometry={g.circle(0.04, 20)}
                position-y={0.026}
                rotation-x={-Math.PI / 2}
                material={id.glow}
              />
            </group>
          </group>
        </>
      )

    case "quill-fin":
      // Quill: a tall quill feather tucked into the head.
      return (
        <>
          <EarDiscs employee={employee} />
          <group
            position={[-0.12, top - 0.04, -0.04]}
            rotation={[-0.35, 0.2, 0.22]}
          >
            <mesh
              geometry={g.shape("quill-feather", featherGeometry)}
              material={id.accent}
              castShadow
            />
            <mesh
              geometry={g.capsule(0.012, 0.36)}
              position-y={0.2}
              material={id.accentDeep}
            />
            <mesh
              geometry={g.cylinder(0.02, 0.006, 0.08, 10)}
              position-y={-0.03}
              material={m.joint}
            />
          </group>
        </>
      )

    case "headset":
      // Pixel: studio headset with a mic and a little camera on top.
      return (
        <group position-y={-0.1}>
          <mesh
            geometry={g.torus(0.44, 0.032, Math.PI, 12, 40)}
            material={id.accentDeep}
            castShadow
          />
          {[-1, 1].map((side) => (
            <group key={side} position-x={side * 0.43} rotation-z={Math.PI / 2}>
              <mesh
                geometry={g.cylinder(0.13, 0.13, 0.1, 28)}
                material={id.accent}
              />
              <mesh
                geometry={g.torus(0.1, 0.014, Math.PI * 2, 8, 28)}
                position-y={side * -0.052}
                rotation-x={Math.PI / 2}
                material={id.glow}
              />
            </group>
          ))}
          <group position={[-0.43, -0.02, 0.04]} rotation={[0.1, -0.55, 0]}>
            <mesh
              geometry={g.capsule(0.014, 0.22)}
              position-z={0.13}
              rotation-x={Math.PI / 2}
              material={m.joint}
            />
            <mesh
              geometry={g.sphere(0.035)}
              position-z={0.26}
              material={id.glow}
            />
          </group>
          <group position={[0.17, 0.42, 0.02]}>
            <mesh geometry={g.box(0.17, 0.11, 0.14, 0.03)} material={m.joint} />
            <mesh
              geometry={g.cylinder(0.04, 0.045, 0.06, 20)}
              position-z={0.09}
              rotation-x={Math.PI / 2}
              material={m.face}
            />
            <mesh
              geometry={g.torus(0.04, 0.009, Math.PI * 2, 8, 20)}
              position-z={0.12}
              material={id.glow}
            />
          </group>
        </group>
      )

    case "inspector-visor":
      // Vera: a translucent inspector visor over the eyes + an inspection antenna.
      return (
        <>
          <EarDiscs employee={employee} />
          <mesh
            geometry={g.box(0.6, 0.15, 0.04, 0.02)}
            position={[0, 0.025, spec.depth / 2 + 0.05]}
            material={id.holo}
          />
          <mesh
            geometry={g.box(0.62, 0.03, 0.05, 0.012)}
            position={[0, 0.11, spec.depth / 2 + 0.045]}
            material={id.accent}
          />
          <group position={[0.16, top - 0.02, 0]}>
            <mesh
              geometry={g.cylinder(0.014, 0.018, 0.16, 8)}
              position-y={0.08}
              material={m.joint}
            />
            <mesh
              geometry={g.torus(0.045, 0.012, Math.PI * 2, 8, 20)}
              position-y={0.2}
              material={id.glow}
            />
          </group>
        </>
      )

    case "clock-ring":
      // Tempo: alarm-clock bells and an hour ring that turns while working.
      return (
        <>
          {[-1, 1].map((side) => (
            <group
              key={side}
              position={[side * 0.2, top - 0.02, 0]}
              rotation-z={-side * 0.45}
            >
              <mesh
                geometry={g.cylinder(0.018, 0.018, 0.08, 8)}
                position-y={0.03}
                material={m.joint}
              />
              <mesh
                geometry={g.sphere(0.1, 24, 14)}
                position-y={0.1}
                scale={[1, 0.68, 1]}
                material={id.accent}
                castShadow
              />
            </group>
          ))}
          <mesh
            geometry={g.cylinder(0.03, 0.03, 0.05, 12)}
            position-y={top + 0.02}
            material={m.joint}
          />
          <group ref={orbitRef} position-y={0.02} userData={{ dynamic: true }}>
            <group rotation-x={Math.PI / 2 - 0.28}>
              <mesh
                geometry={g.torus(0.45, 0.016, Math.PI * 2, 8, 56)}
                material={id.glow}
              />
              {[0, 1, 2, 3].map((i) => (
                <mesh
                  key={i}
                  geometry={g.box(0.05, 0.05, 0.05, 0.015)}
                  position={[
                    Math.cos((i * Math.PI) / 2) * 0.45,
                    Math.sin((i * Math.PI) / 2) * 0.45,
                    0,
                  ]}
                  material={id.accent}
                />
              ))}
            </group>
          </group>
        </>
      )

    case "antennas":
      // Relay: messenger wings and a broadcasting antenna.
      return (
        <>
          {[-1, 1].map((side) => (
            <group
              key={side}
              position={[side * (spec.width / 2 - 0.01), 0.04, -0.02]}
              rotation={[0, (side * Math.PI) / 2, 0.25]}
            >
              <mesh
                geometry={g.shape("wing", wingGeometry)}
                scale={[side, 1, 1]}
                material={id.accent}
              />
            </group>
          ))}
          <group position={[0.07, top - 0.02, 0]}>
            <mesh
              geometry={g.cylinder(0.014, 0.02, 0.34, 8)}
              position-y={0.17}
              material={m.joint}
            />
            <mesh
              geometry={g.sphere(0.05, 18, 12)}
              position-y={0.36}
              material={id.glow}
            />
            {[0.09, 0.14].map((r) => (
              <mesh
                key={r}
                geometry={g.torus(r, 0.01, Math.PI * 0.55, 6, 16)}
                position-y={0.36}
                rotation-z={Math.PI * 0.22}
                material={id.glow}
              />
            ))}
          </group>
          <group position={[-0.1, top - 0.02, 0]}>
            <mesh
              geometry={g.cylinder(0.012, 0.016, 0.16, 8)}
              position-y={0.08}
              material={m.joint}
            />
            <mesh
              geometry={g.sphere(0.035, 14, 10)}
              position-y={0.17}
              material={id.accent}
            />
          </group>
        </>
      )

    case "glasses":
      // Ledger: analyst glasses.
      return (
        <>
          <EarDiscs employee={employee} />
          <group position={[0, 0.028, spec.depth / 2 + 0.04]}>
            {[-1, 1].map((side) => (
              <group key={side} position-x={side * spec.eyeX}>
                <mesh
                  geometry={g.shape("glasses-frame", glassesFrameGeometry)}
                  material={id.accentDeep}
                />
                <mesh
                  geometry={g.circle(0.09, 24)}
                  scale={[1.15, 0.85, 1]}
                  material={id.holo}
                />
              </group>
            ))}
            <mesh
              geometry={g.box(0.09, 0.022, 0.02, 0.008)}
              position-y={0.02}
              material={id.accentDeep}
            />
          </group>
        </>
      )
  }
}

function featherGeometry() {
  const s = new THREE.Shape()
  s.moveTo(0, 0)
  s.bezierCurveTo(0.13, 0.08, 0.12, 0.3, 0.01, 0.44)
  s.bezierCurveTo(-0.07, 0.3, -0.08, 0.1, 0, 0)
  return beveledPlate(s, 0.016, 0.01)
}

function wingGeometry() {
  const s = new THREE.Shape()
  s.moveTo(0, 0)
  s.quadraticCurveTo(0.12, -0.02, 0.24, 0.1)
  s.quadraticCurveTo(0.16, 0.09, 0.2, 0.17)
  s.quadraticCurveTo(0.12, 0.13, 0.12, 0.2)
  s.quadraticCurveTo(0.05, 0.12, 0, 0.1)
  s.lineTo(0, 0)
  return beveledPlate(s, 0.018, 0.008)
}

function glassesFrameGeometry() {
  const outer = new THREE.Shape()
  outer.absellipse(0, 0, 0.115, 0.085, 0, Math.PI * 2, false, 0)
  const hole = new THREE.Path()
  hole.absellipse(0, 0, 0.092, 0.064, 0, Math.PI * 2, true, 0)
  outer.holes.push(hole)
  return beveledPlate(outer, 0.012, 0.006)
}
