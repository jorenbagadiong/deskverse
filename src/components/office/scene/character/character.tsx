"use client"

import { useEffect, useRef } from "react"
import { Billboard } from "@react-three/drei"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"

import type { EmployeeStatus } from "@/config/employee-status"
import type { OfficeEmployee } from "@/config/office"

import { frameDelta } from "../frame-delta"
import { useSceneMaterials } from "../materials"
import type { AmbientStore } from "../shared/ambient"
import { Batch } from "../shared/batch"

import { Arm, ChestItem, Legs, Scanner, Torso } from "./body"
import { expressionFor } from "./expression"
import { g, HEADS, RIG } from "./geometry"
import { Head } from "./head"
import { FloorRing, StatusBubble } from "./marker"
import {
  addPose,
  basePose,
  blinkOpenness,
  BLINK_SECONDS,
  glanceYaw,
  GLANCE_SECONDS,
  NO_TRANSIENT,
  transient,
  TRANSIENT_SECONDS,
  workingMotion,
  type ArmPose,
  type Pose,
} from "./pose"

const POP_SECONDS = 0.35
const DROP_SECONDS = 0.5
const ARMS_UP: ArmPose = { swing: -0.15, raise: 2.4, elbow: -0.2 }

const easeOutCubic = (k: number) => 1 - (1 - k) ** 3
const easeOutBack = (k: number) => 1 + 2.7 * (k - 1) ** 3 + 1.7 * (k - 1) ** 2

const clonePose = (p: Pose): Pose => ({
  ...p,
  left: { ...p.left },
  right: { ...p.right },
})

function dampArm(
  cur: ArmPose,
  goal: ArmPose,
  lambda: number,
  dt: number,
  snap: boolean,
) {
  let diff = 0
  for (const k of ["swing", "raise", "elbow"] as const) {
    cur[k] = snap ? goal[k] : THREE.MathUtils.damp(cur[k], goal[k], lambda, dt)
    diff = Math.max(diff, Math.abs(cur[k] - goal[k]))
  }
  return diff
}

/** Eases `cur` toward `goal` in place; returns the largest remaining difference. */
function dampPose(
  cur: Pose,
  goal: Pose,
  lambda: number,
  dt: number,
  snap: boolean,
) {
  let diff = 0
  for (const k of [
    "lean",
    "twist",
    "headPitch",
    "headYaw",
    "headRoll",
  ] as const) {
    cur[k] = snap ? goal[k] : THREE.MathUtils.damp(cur[k], goal[k], lambda, dt)
    diff = Math.max(diff, Math.abs(cur[k] - goal[k]))
  }
  return Math.max(
    diff,
    dampArm(cur.left, goal.left, lambda, dt, snap),
    dampArm(cur.right, goal.right, lambda, dt, snap),
  )
}

const blendArm = (a: ArmPose, b: ArmPose, k: number): ArmPose => ({
  swing: a.swing + (b.swing - a.swing) * k,
  raise: a.raise + (b.raise - a.raise) * k,
  elbow: a.elbow + (b.elbow - a.elbow) * k,
})

/**
 * One reusable character. Everything that differs between employees comes from
 * `employee.look` (head, headgear, chest item, build, face) and
 * `employee.workstation` (working motion); the rig, materials, animation and
 * selection behavior are shared.
 */
export function Character({
  employee,
  status,
  selected,
  hovered,
  reducedMotion,
  ambient,
  position,
  rotationY = 0,
  onSelect,
  onHover,
}: {
  employee: OfficeEmployee
  status: EmployeeStatus
  selected: boolean
  hovered: boolean
  reducedMotion: boolean
  ambient: AmbientStore
  position: [number, number, number]
  rotationY?: number
  onSelect: () => void
  onHover: (hovering: boolean) => void
}) {
  const m = useSceneMaterials()
  const invalidate = useThree((s) => s.invalidate)
  const kind = employee.workstation
  const spec = HEADS[employee.look.head]
  const expression = expressionFor(status, employee.look)

  const motionGroup = useRef<THREE.Group>(null)
  const lean = useRef<THREE.Group>(null)
  const head = useRef<THREE.Group>(null)
  const eyes = useRef<THREE.Group>(null)
  const leftShoulder = useRef<THREE.Group>(null)
  const leftElbow = useRef<THREE.Group>(null)
  const rightShoulder = useRef<THREE.Group>(null)
  const rightElbow = useRef<THREE.Group>(null)
  const orbit = useRef<THREE.Group>(null)
  const notebook = useRef<THREE.Group>(null)
  const bubble = useRef<THREE.Group>(null)
  const chevron = useRef<THREE.Group>(null)

  const pose = useRef<Pose>(clonePose(basePose(status, kind)))
  const statusEvent = useRef({ pending: false, at: -Infinity })
  const selectEvent = useRef({ pending: false, at: -Infinity })
  const ambientEvent = useRef({
    blinkAt: -Infinity,
    glanceAt: -Infinity,
    glanceDir: 1 as 1 | -1,
  })
  const previousStatus = useRef(status)
  // Offsets working loops so employees don't move in lockstep.
  const seed = (employee.desk[0] * 1.37 + employee.desk[1] * 0.71) % 5

  useEffect(() => {
    if (previousStatus.current !== status) {
      previousStatus.current = status
      statusEvent.current.pending = true
    }
    invalidate()
  }, [status, invalidate])

  useEffect(() => {
    if (selected) selectEvent.current.pending = true
    invalidate()
  }, [selected, invalidate])

  useFrame((state, rawDelta) => {
    const dt = frameDelta(rawDelta)
    const t = state.clock.elapsedTime
    const motion = !reducedMotion
    if (statusEvent.current.pending)
      statusEvent.current = { pending: false, at: t }
    if (selectEvent.current.pending)
      selectEvent.current = { pending: false, at: t }

    const request = ambient.requests.current.get(employee.id)
    if (request) {
      ambient.requests.current.delete(employee.id)
      const a = ambientEvent.current
      a.blinkAt = t
      if (request === "glance" && status !== "working") {
        a.glanceAt = t
        a.glanceDir = a.glanceDir === 1 ? -1 : 1
      }
    }

    const sinceStatus = t - statusEvent.current.at
    const working = status === "working" && motion
    let animating = working

    // 1. Target pose: base + role-specific working loop + one-off reactions.
    let goal = basePose(status, kind)
    if (working) goal = addPose(goal, workingMotion(kind, t + seed))
    const tr = motion ? transient(status, sinceStatus) : NO_TRANSIENT
    if (motion && sinceStatus < (TRANSIENT_SECONDS[status] ?? 0))
      animating = true
    if (tr.armsUp > 0 || tr.wave !== 0) {
      goal = clonePose(goal)
      goal.left = blendArm(goal.left, ARMS_UP, tr.armsUp)
      goal.right = blendArm(goal.right, ARMS_UP, tr.armsUp)
      goal.right.raise += tr.wave
    }
    const sinceGlance = t - ambientEvent.current.glanceAt
    if (motion && sinceGlance < GLANCE_SECONDS) {
      goal = {
        ...goal,
        headYaw:
          goal.headYaw + glanceYaw(sinceGlance, ambientEvent.current.glanceDir),
      }
      animating = true
    }

    // 2. Ease the rig toward it (snap under reduced motion).
    const remaining = dampPose(pose.current, goal, 10, dt, !motion)
    if (remaining > 0.001) animating = true
    const p = pose.current
    if (motionGroup.current) {
      motionGroup.current.position.set(tr.shake, tr.hop, 0)
      motionGroup.current.rotation.y = p.twist + tr.spin
    }
    lean.current?.rotation.set(p.lean, 0, 0)
    head.current?.rotation.set(p.headPitch, p.headYaw, p.headRoll)
    leftShoulder.current?.rotation.set(p.left.swing, 0, -p.left.raise)
    leftElbow.current?.rotation.set(p.left.elbow, 0, 0)
    rightShoulder.current?.rotation.set(p.right.swing, 0, p.right.raise)
    rightElbow.current?.rotation.set(p.right.elbow, 0, 0)

    // 3. Blink.
    const sinceBlink = t - ambientEvent.current.blinkAt
    if (eyes.current)
      eyes.current.scale.y = motion ? blinkOpenness(sinceBlink) : 1
    if (motion && sinceBlink < BLINK_SECONDS) animating = true

    // 4. Accessories that move only while working.
    if (orbit.current && working) orbit.current.rotation.y += dt * 0.9
    if (notebook.current) {
      notebook.current.position.y =
        0.62 + (working ? Math.sin(t * 2.2) * 0.03 : 0)
      notebook.current.rotation.y =
        0.5 + (working ? Math.sin(t * 1.1) * 0.25 : 0)
    }

    // 5. Status bubble pop and selection chevron drop.
    if (bubble.current) {
      const k = motion ? Math.min(sinceStatus / POP_SECONDS, 1) : 1
      bubble.current.scale.setScalar(Math.max(easeOutBack(k), 0.001))
      if (k < 1) animating = true
    }
    if (chevron.current) {
      const k = motion
        ? Math.min((t - selectEvent.current.at) / DROP_SECONDS, 1)
        : 1
      chevron.current.position.y = (1 - easeOutCubic(k)) * 0.5
      if (k < 1) animating = true
    }

    if (animating) invalidate()
  })

  const headCenterY = RIG.neckY + 0.02 + spec.height / 2
  const bubbleY = headCenterY + spec.height / 2 + 0.42

  return (
    <group
      position={position}
      rotation-y={rotationY}
      onClick={(event) => {
        event.stopPropagation()
        onSelect()
      }}
      onPointerOver={(event) => {
        event.stopPropagation()
        onHover(true)
      }}
      onPointerOut={() => onHover(false)}
    >
      <Batch version={`${status}:${selected}:${hovered}`}>
        <FloorRing status={status} selected={selected} hovered={hovered} />
      </Batch>

      <group ref={motionGroup}>
        <Batch>
          <Legs employee={employee} />
        </Batch>
        <group ref={lean} position-y={RIG.hipY}>
          <group position-y={-RIG.hipY}>
            {/* Rigid parts are merged per material; moving parts are flagged dynamic. */}
            <Batch>
              <Torso employee={employee} />
              <ChestItem employee={employee} notebookRef={notebook} />
              <Arm
                side={-1}
                employee={employee}
                shoulderRef={leftShoulder}
                elbowRef={leftElbow}
              />
              <Arm
                side={1}
                employee={employee}
                shoulderRef={rightShoulder}
                elbowRef={rightElbow}
              >
                {employee.look.headgear === "explorer-cap" ? (
                  <Scanner employee={employee} />
                ) : null}
              </Arm>
              <group
                ref={head}
                position-y={RIG.neckY + 0.02}
                userData={{ dynamic: true }}
              >
                <group position-y={spec.height / 2}>
                  <Batch
                    version={`${expression.eyes}:${expression.mouth}:${expression.alert}`}
                  >
                    <Head
                      employee={employee}
                      expression={expression}
                      eyesRef={eyes}
                      orbitRef={orbit}
                    />
                  </Batch>
                </group>
              </group>
            </Batch>
          </group>
        </group>

        <Billboard position-y={bubbleY}>
          <group ref={bubble}>
            <Batch version={status}>
              <StatusBubble status={status} />
            </Batch>
          </group>
        </Billboard>
      </group>

      {selected ? (
        <group position-y={bubbleY + 0.42}>
          <group ref={chevron}>
            <mesh
              geometry={g.shape("chevron", chevronGeometry)}
              rotation-x={Math.PI}
              material={m.white}
            />
          </group>
        </group>
      ) : null}

      {/* Invisible, generous hit area: easy to click and tap. */}
      <mesh
        geometry={g.box(0.9, 1.6, 0.8, 0.05)}
        position-y={0.8}
        material={m.hitArea}
      />
    </group>
  )
}

function chevronGeometry() {
  return new THREE.ConeGeometry(0.12, 0.2, 4)
}
