"use client"

import { useRef } from "react"
import { useFrame } from "@react-three/fiber"
import type * as THREE from "three"

import type { OfficeEmployee } from "@/config/office"

import { g } from "../character/geometry"
import { useIdentityMaterials, useSceneMaterials } from "../materials"
import { flat, roundedRectShape, smoothLathe } from "../shared/shapes"

const TOP = 0.58

type PropsArgs = {
  employee: OfficeEmployee
  /** Holographic panel material (identity or status tinted). */
  screen: THREE.Material
  /** Bright content/edge material for the same tint. */
  screenGlow: THREE.Material
  /** Animate job-specific motion (working + motion allowed). */
  animate: boolean
}

/**
 * Job-specific desk props. Animated parts are driven from the shared frame
 * loop only while `animate` is true; otherwise they rest in a fixed pose
 * (time 0), so a static frame is fully deterministic.
 */
export function StationProps(props: PropsArgs) {
  switch (props.employee.workstation) {
    case "research":
      return <ResearchProps {...props} />
    case "writing":
      return <WritingProps {...props} />
    case "video":
      return <VideoProps {...props} />
    case "review":
      return <ReviewProps {...props} />
    case "schedule":
      return <ScheduleProps {...props} />
    case "publish":
      return <PublishProps {...props} />
    case "analytics":
      return <AnalyticsProps {...props} />
  }
}

/** Time for prop animation: frozen at 0 unless animating. */
function usePropClock(animate: boolean, apply: (t: number) => void) {
  useFrame((state) => apply(animate ? state.clock.elapsedTime : 0))
}

function HoloPanel({
  width,
  height,
  material,
  edge,
  position,
  rotationY = 0,
  children,
}: {
  width: number
  height: number
  material: THREE.Material
  edge: THREE.Material
  position: [number, number, number]
  rotationY?: number
  children?: React.ReactNode
}) {
  const m = useSceneMaterials()
  return (
    <group position={position} rotation-y={rotationY}>
      <mesh
        geometry={g.shape(`holo:${width}:${height}`, () =>
          flat(roundedRectShape(width, height, 0.035)),
        )}
        material={material}
      />
      <mesh
        geometry={g.box(width - 0.04, 0.012, 0.012, 0.005)}
        position-y={height / 2}
        material={edge}
      />
      <mesh
        geometry={g.box(width - 0.04, 0.012, 0.012, 0.005)}
        position-y={-height / 2}
        material={edge}
      />
      {/* Projector base on the desk */}
      <mesh
        geometry={g.cylinder(0.06, 0.075, 0.03, 20)}
        position-y={-(position[1] - TOP) + 0.015}
        material={m.metal}
      />
      <group position-z={0.004}>{children}</group>
    </group>
  )
}

function Lines({
  rows,
  material,
  x = 0,
  width,
}: {
  rows: number[]
  material: THREE.Material
  x?: number
  width: number
}) {
  return (
    <>
      {rows.map((y, i) => (
        <mesh
          key={y}
          geometry={g.box(
            width * (0.55 + ((i * 37) % 40) / 100),
            0.022,
            0.004,
            0.008,
          )}
          position={[x, y, 0]}
          material={material}
        />
      ))}
    </>
  )
}

function ResearchProps({ employee, screen, screenGlow, animate }: PropsArgs) {
  const id = useIdentityMaterials(employee.glow)
  const m = useSceneMaterials()
  const beam = useRef<THREE.Mesh>(null)
  const globe = useRef<THREE.Group>(null)
  usePropClock(animate, (t) => {
    if (beam.current) beam.current.position.y = Math.sin(t * 2.2) * 0.17
    if (globe.current) globe.current.rotation.y = t * 0.8
  })
  return (
    <>
      <HoloPanel
        width={0.82}
        height={0.5}
        material={screen}
        edge={screenGlow}
        position={[-0.66, TOP + 0.52, -0.2]}
        rotationY={0.57}
      >
        {[0.06, 0.11, 0.16].map((r) => (
          <mesh
            key={r}
            geometry={g.ring(r, r + 0.01, 32)}
            position-x={-0.2}
            material={screenGlow}
          />
        ))}
        <Lines
          rows={[0.12, 0.05, -0.02, -0.09]}
          material={screenGlow}
          x={0.15}
          width={0.3}
        />
        <mesh
          ref={beam}
          userData={{ dynamic: true }}
          geometry={g.box(0.76, 0.01, 0.004, 0.003)}
          material={m.white}
        />
      </HoloPanel>
      <HoloPanel
        width={0.42}
        height={0.32}
        material={screen}
        edge={screenGlow}
        position={[0.66, TOP + 0.42, -0.42]}
        rotationY={-0.55}
      >
        <Lines rows={[0.07, 0.0, -0.07]} material={screenGlow} width={0.28} />
      </HoloPanel>
      <group position={[0.42, TOP, 0.12]}>
        <mesh
          geometry={g.cylinder(0.05, 0.07, 0.04, 16)}
          position-y={0.02}
          material={m.metal}
        />
        <group ref={globe} userData={{ dynamic: true }} position-y={0.17}>
          <mesh geometry={g.sphere(0.11, 20, 14)} material={id.accent} />
          <mesh
            geometry={g.torus(0.13, 0.008, Math.PI * 2, 6, 28)}
            rotation-x={Math.PI / 2 - 0.4}
            material={m.metal}
          />
        </group>
      </group>
    </>
  )
}

function WritingProps({ employee, screen, screenGlow, animate }: PropsArgs) {
  const id = useIdentityMaterials(employee.glow)
  const m = useSceneMaterials()
  const pages = useRef<THREE.Group>(null)
  const cursorLine = useRef<THREE.Mesh>(null)
  usePropClock(animate, (t) => {
    if (pages.current) {
      pages.current.position.y = TOP + 0.5 + Math.sin(t * 1.6) * 0.04
      pages.current.rotation.y = -0.4 + Math.sin(t * 0.7) * 0.15
    }
    if (cursorLine.current)
      cursorLine.current.scale.x = animate ? 0.2 + ((t * 0.6) % 1) * 0.8 : 0.6
  })
  return (
    <>
      <HoloPanel
        width={0.7}
        height={0.52}
        material={screen}
        edge={screenGlow}
        position={[-0.68, TOP + 0.5, -0.22]}
        rotationY={0.57}
      >
        <Lines
          rows={[0.16, 0.09, 0.02, -0.05, -0.12]}
          material={screenGlow}
          x={-0.04}
          width={0.5}
        />
        <mesh
          ref={cursorLine}
          userData={{ dynamic: true }}
          geometry={g.box(0.42, 0.022, 0.004, 0.008)}
          position={[-0.04, -0.19, 0]}
          material={m.white}
        />
      </HoloPanel>
      {/* Floating script pages */}
      <group
        ref={pages}
        userData={{ dynamic: true }}
        position={[0.5, TOP + 0.5, -0.25]}
      >
        {[0, 1].map((i) => (
          <group
            key={i}
            position={[i * 0.06, i * 0.04, i * -0.03]}
            rotation-z={i * 0.12 - 0.06}
          >
            <mesh
              geometry={g.box(0.22, 0.29, 0.006, 0.006)}
              material={m.shell}
            />
            {[0.08, 0.04, 0, -0.04, -0.08].map((y) => (
              <mesh
                key={y}
                geometry={g.box(0.15, 0.012, 0.002, 0.002)}
                position={[0, y, 0.005]}
                material={id.accentDeep}
              />
            ))}
          </group>
        ))}
      </group>
      {/* Books and a pen cup */}
      <group position={[0.5, TOP, 0.12]}>
        {[0, 1, 2].map((i) => (
          <mesh
            key={i}
            geometry={g.box(0.24, 0.045, 0.17, 0.012)}
            position={[i * 0.01, 0.023 + i * 0.046, 0]}
            rotation-y={i * 0.12}
            material={i === 1 ? id.accent : m.desk}
          />
        ))}
      </group>
      <group position={[-0.2, TOP, 0.18]}>
        <mesh
          geometry={g.cylinder(0.04, 0.035, 0.1, 16)}
          position-y={0.05}
          material={id.accentDeep}
        />
        <mesh
          geometry={g.capsule(0.008, 0.16)}
          position={[0.01, 0.15, 0]}
          rotation-z={0.2}
          material={id.glow}
        />
      </group>
    </>
  )
}

function VideoProps({ employee, screen, screenGlow, animate }: PropsArgs) {
  const id = useIdentityMaterials(employee.glow)
  const m = useSceneMaterials()
  const clips = useRef<THREE.Group>(null)
  const wheel = useRef<THREE.Group>(null)
  const W = 0.86
  usePropClock(animate, (t) => {
    const children = clips.current?.children ?? []
    children.forEach((clip, i) => {
      const base = (i * 0.29) % 1
      clip.position.x = (((base + t * 0.08) % 1) - 0.5) * (W - 0.16)
    })
    if (wheel.current) wheel.current.rotation.y = t * 2.4
  })
  return (
    <>
      <HoloPanel
        width={W}
        height={0.46}
        material={screen}
        edge={screenGlow}
        position={[-0.62, TOP + 0.5, -0.22]}
        rotationY={0.54}
      >
        {/* Preview window + timeline tracks */}
        <mesh
          geometry={g.box(0.36, 0.16, 0.004, 0.012)}
          position={[0, 0.1, 0]}
          material={screenGlow}
        />
        <mesh
          geometry={g.box(W - 0.1, 0.006, 0.004, 0.002)}
          position-y={-0.06}
          material={screenGlow}
        />
        <mesh
          geometry={g.box(W - 0.1, 0.006, 0.004, 0.002)}
          position-y={-0.14}
          material={screenGlow}
        />
        <group ref={clips} userData={{ dynamic: true }}>
          {[0, 1, 2, 3].map((i) => (
            <mesh
              key={i}
              geometry={g.box(0.14, 0.05, 0.006, 0.012)}
              position={[0, i % 2 ? -0.14 : -0.06, 0.003]}
              material={i % 2 ? m.glow.secondary : id.glow}
            />
          ))}
        </group>
        {/* Playhead */}
        <mesh
          geometry={g.box(0.008, 0.2, 0.006, 0.002)}
          position={[0.02, -0.1, 0.006]}
          material={m.white}
        />
      </HoloPanel>
      {/* Jog wheel */}
      <group position={[0.36, TOP, -0.14]}>
        <mesh
          geometry={g.cylinder(0.075, 0.08, 0.035, 28)}
          position-y={0.018}
          material={m.joint}
        />
        <group ref={wheel} userData={{ dynamic: true }} position-y={0.037}>
          <mesh
            geometry={g.torus(0.06, 0.008, Math.PI * 1.6, 6, 24)}
            rotation-x={Math.PI / 2}
            material={id.glow}
          />
        </group>
      </group>
      {/* Mini camera on a desk tripod */}
      <group position={[0.58, TOP, 0.1]} rotation-y={-0.6}>
        {[0, 2.1, 4.2].map((a) => (
          <mesh
            key={a}
            geometry={g.capsule(0.008, 0.16)}
            position={[Math.sin(a) * 0.04, 0.08, Math.cos(a) * 0.04]}
            rotation={[Math.cos(a) * 0.35, 0, -Math.sin(a) * 0.35]}
            material={m.metal}
          />
        ))}
        <mesh
          geometry={g.box(0.14, 0.1, 0.18, 0.03)}
          position-y={0.21}
          material={id.accent}
        />
        <mesh
          geometry={g.cylinder(0.045, 0.05, 0.07, 20)}
          position={[0, 0.21, 0.12]}
          rotation-x={Math.PI / 2}
          material={m.face}
        />
        <mesh
          geometry={g.torus(0.045, 0.008, Math.PI * 2, 6, 20)}
          position={[0, 0.21, 0.156]}
          material={id.glow}
        />
      </group>
    </>
  )
}

function ReviewProps({ employee, screen, screenGlow, animate }: PropsArgs) {
  const id = useIdentityMaterials(employee.glow)
  const m = useSceneMaterials()
  const scan = useRef<THREE.Mesh>(null)
  usePropClock(animate, (t) => {
    if (scan.current) scan.current.position.z = Math.sin(t * 1.4) * 0.12
  })
  return (
    <>
      <HoloPanel
        width={0.6}
        height={0.5}
        material={screen}
        edge={screenGlow}
        position={[-0.71, TOP + 0.5, -0.24]}
        rotationY={0.57}
      >
        {[0.15, 0.05, -0.05, -0.15].map((y, i) => (
          <group key={y} position-y={y}>
            <mesh
              geometry={g.box(0.05, 0.05, 0.004, 0.012)}
              position-x={-0.2}
              material={i < 3 ? m.glow.success : m.glow.muted}
            />
            <mesh
              geometry={g.box(0.3, 0.022, 0.004, 0.008)}
              position-x={0.04}
              material={screenGlow}
            />
          </group>
        ))}
      </HoloPanel>
      {/* Light table with a document under review */}
      <group position={[-0.32, TOP + 0.004, 0.08]}>
        <mesh geometry={g.box(0.46, 0.012, 0.32, 0.01)} material={id.holo} />
        <mesh
          geometry={g.box(0.24, 0.014, 0.3, 0.006)}
          position-y={0.004}
          material={m.shell}
        />
        <mesh
          ref={scan}
          userData={{ dynamic: true }}
          geometry={g.box(0.3, 0.018, 0.01, 0.004)}
          position-y={0.008}
          material={id.glow}
        />
      </group>
      {/* Approve / reject stamps */}
      {[
        [0.42, m.glow.success],
        [0.58, m.glow.danger],
      ].map(([x, mat]) => (
        <group key={x as number} position={[x as number, TOP, 0.1]}>
          <mesh
            geometry={g.cylinder(0.04, 0.05, 0.05, 16)}
            position-y={0.025}
            material={m.joint}
          />
          <mesh
            geometry={g.cylinder(0.02, 0.02, 0.07, 10)}
            position-y={0.085}
            material={m.joint}
          />
          <mesh
            geometry={g.sphere(0.035, 14, 10)}
            position-y={0.13}
            material={mat as THREE.Material}
          />
        </group>
      ))}
      <mesh
        geometry={g.shape("shield-desk", () =>
          flat(roundedRectShape(0.12, 0.14, 0.05)),
        )}
        position={[0, 0.34, 0.395]}
        material={id.glow}
      />
    </>
  )
}

function ScheduleProps({ employee, screen, screenGlow, animate }: PropsArgs) {
  const id = useIdentityMaterials(employee.glow)
  const m = useSceneMaterials()
  const tile = useRef<THREE.Mesh>(null)
  const hand = useRef<THREE.Mesh>(null)
  const cols = 4
  const rows = 3
  const slot = (c: number, r: number): [number, number] => [
    -0.27 + c * 0.18,
    0.13 - r * 0.13,
  ]
  usePropClock(animate, (t) => {
    // One scheduling tile glides between slots.
    const route = [slot(0, 1), slot(2, 0), slot(3, 2), slot(1, 2)]
    const u = (t * 0.35) % route.length
    const i = Math.floor(u)
    const k = u - i
    const e = k * k * (3 - 2 * k)
    const [x0, y0] = route[i]
    const [x1, y1] = route[(i + 1) % route.length]
    tile.current?.position.set(x0 + (x1 - x0) * e, y0 + (y1 - y0) * e, 0.008)
    if (hand.current) hand.current.rotation.z = -t * 1.2
  })
  return (
    <>
      <HoloPanel
        width={0.8}
        height={0.5}
        material={screen}
        edge={screenGlow}
        position={[-0.66, TOP + 0.52, -0.24]}
        rotationY={0.57}
      >
        {Array.from({ length: cols * rows }, (_, n) => {
          const [x, y] = slot(n % cols, Math.floor(n / cols))
          return (
            <mesh
              key={n}
              geometry={g.box(0.15, 0.1, 0.004, 0.016)}
              position={[x, y, 0]}
              material={n % 5 === 1 ? screenGlow : m.glow.muted}
            />
          )
        })}
        <mesh
          ref={tile}
          userData={{ dynamic: true }}
          geometry={g.box(0.15, 0.1, 0.01, 0.016)}
          position={[slot(0, 1)[0], slot(0, 1)[1], 0.008]}
          material={id.glow}
        />
      </HoloPanel>
      {/* Desk clock */}
      <group position={[0.5, TOP, 0.08]} rotation-y={-0.4}>
        <mesh
          geometry={g.cylinder(0.1, 0.1, 0.05, 28)}
          position-y={0.1}
          rotation-x={Math.PI / 2}
          material={id.accent}
        />
        <mesh
          geometry={g.circle(0.08, 28)}
          position={[0, 0.1, 0.027]}
          material={m.shell}
        />
        <mesh
          ref={hand}
          userData={{ dynamic: true }}
          geometry={g.box(0.012, 0.06, 0.004, 0.003)}
          position={[0, 0.1, 0.03]}
          material={id.accentDeep}
        />
        <mesh
          geometry={g.box(0.08, 0.05, 0.05, 0.015)}
          position-y={0.025}
          material={m.desk}
        />
      </group>
    </>
  )
}

function PublishProps({ employee, screen, screenGlow, animate }: PropsArgs) {
  const id = useIdentityMaterials(employee.glow)
  const m = useSceneMaterials()
  const packets = useRef<THREE.Group>(null)
  const dish = useRef<THREE.Group>(null)
  // Packets travel from the outbox to the transmitter dish along an arc.
  const from: [number, number, number] = [0.45, TOP + 0.08, -0.05]
  const to: [number, number, number] = [1.12, 1.62, -0.45]
  usePropClock(animate, (t) => {
    const children = packets.current?.children ?? []
    children.forEach((p, i) => {
      p.visible = animate
      const u = (t * 0.55 + i / children.length) % 1
      p.position.set(
        from[0] + (to[0] - from[0]) * u,
        from[1] + (to[1] - from[1]) * u + Math.sin(u * Math.PI) * 0.35,
        from[2] + (to[2] - from[2]) * u,
      )
      p.rotation.set(t * 3 + i, t * 2, 0)
    })
    if (dish.current) dish.current.rotation.y = -0.6 + Math.sin(t * 0.8) * 0.2
  })
  return (
    <>
      <HoloPanel
        width={0.66}
        height={0.46}
        material={screen}
        edge={screenGlow}
        position={[-0.66, TOP + 0.5, -0.22]}
        rotationY={0.57}
      >
        {[-0.18, 0, 0.18].map((x, i) => (
          <group key={x} position-x={x}>
            <mesh
              geometry={g.circle(0.055, 20)}
              position-y={0.07}
              material={i === 1 ? id.glow : screenGlow}
            />
            <mesh
              geometry={g.box(0.14, 0.022, 0.004, 0.008)}
              position-y={-0.08}
              material={screenGlow}
            />
          </group>
        ))}
      </HoloPanel>
      {/* Outbox tray */}
      <group position={from}>
        <mesh
          geometry={g.box(0.24, 0.05, 0.18, 0.02)}
          position-y={-0.055}
          material={id.accentDeep}
        />
        <mesh
          geometry={g.box(0.16, 0.012, 0.11, 0.004)}
          position-y={-0.02}
          material={m.shell}
        />
      </group>
      {/* Transmitter tower beside the desk */}
      <group position={[1.12, 0, -0.45]}>
        <mesh
          geometry={g.cylinder(0.05, 0.08, 1.5, 16)}
          position-y={0.75}
          material={m.metal}
          castShadow
        />
        <mesh
          geometry={g.torus(0.06, 0.012, Math.PI * 2, 6, 20)}
          position-y={1.2}
          rotation-x={Math.PI / 2}
          material={id.glow}
        />
        <group ref={dish} userData={{ dynamic: true }} position-y={1.55}>
          <group rotation-x={-0.9}>
            <mesh
              geometry={g.shape("dish", () =>
                smoothLathe(
                  [
                    [0.0, 0],
                    [0.12, 0.02],
                    [0.22, 0.07],
                    [0.26, 0.11],
                  ],
                  10,
                  28,
                ),
              )}
              material={id.accent}
              castShadow
            />
            <mesh
              geometry={g.cylinder(0.008, 0.008, 0.2, 6)}
              position-y={0.1}
              material={m.metal}
            />
            <mesh
              geometry={g.sphere(0.03, 12, 8)}
              position-y={0.2}
              material={id.glow}
            />
          </group>
        </group>
      </group>
      <group ref={packets} userData={{ dynamic: true }}>
        {[0, 1, 2].map((i) => (
          <mesh
            key={i}
            geometry={g.box(0.055, 0.055, 0.055, 0.012)}
            material={id.glow}
            visible={false}
          />
        ))}
      </group>
    </>
  )
}

function AnalyticsProps({ employee, screen, screenGlow, animate }: PropsArgs) {
  const id = useIdentityMaterials(employee.glow)
  const m = useSceneMaterials()
  const bars = useRef<THREE.Group>(null)
  const heights = [0.12, 0.2, 0.16, 0.26, 0.32]
  usePropClock(animate, (t) => {
    bars.current?.children.forEach((bar, i) => {
      const h =
        heights[i] * (animate ? 0.75 + 0.25 * Math.sin(t * 1.6 + i * 0.9) : 1)
      bar.scale.y = h / 0.1
      bar.position.y = -0.17 + h / 2
    })
  })
  return (
    <>
      {/* Two monitors on the far side of the desk */}
      {[
        [-0.6, -0.05, 0.75],
        [-0.42, -0.34, 0.35],
      ].map(([x, z, ry], i) => (
        <group key={i} position={[x, TOP, z]} rotation-y={ry}>
          <mesh
            geometry={g.cylinder(0.02, 0.05, 0.14, 12)}
            position-y={0.07}
            material={m.metal}
          />
          <mesh
            geometry={g.box(0.42, 0.28, 0.035, 0.02)}
            position-y={0.29}
            material={m.joint}
            castShadow
          />
          <mesh
            geometry={g.box(0.38, 0.24, 0.004, 0.012)}
            position={[0, 0.29, 0.019]}
            material={screen}
          />
          {i === 0 ? (
            <mesh
              geometry={g.ring(0.055, 0.085, 24)}
              position={[0, 0.29, 0.024]}
              material={screenGlow}
            />
          ) : (
            <Lines
              rows={[0.36, 0.3, 0.24]}
              material={screenGlow}
              width={0.26}
            />
          )}
        </group>
      ))}
      {/* Holographic bar chart Ledger points at */}
      <HoloPanel
        width={0.62}
        height={0.44}
        material={screen}
        edge={screenGlow}
        position={[0.78, TOP + 0.5, -0.4]}
        rotationY={-0.62}
      >
        <group ref={bars} userData={{ dynamic: true }}>
          {heights.map((h, i) => (
            <mesh
              key={i}
              geometry={g.box(0.07, 0.1, 0.004, 0.01)}
              position={[-0.2 + i * 0.1, -0.17 + h / 2, 0.004]}
              scale={[1, h / 0.1, 1]}
              material={i === 4 ? m.glow.accent : id.glow}
            />
          ))}
        </group>
      </HoloPanel>
      {/* Pie chart puck */}
      <group position={[0.42, TOP, 0.15]}>
        <mesh
          geometry={g.cylinder(0.08, 0.08, 0.03, 28)}
          position-y={0.015}
          material={id.accent}
        />
        <mesh
          geometry={g.torus(0.05, 0.012, Math.PI * 0.6, 6, 16)}
          position-y={0.034}
          rotation-x={Math.PI / 2}
          material={id.glow}
        />
      </group>
    </>
  )
}
