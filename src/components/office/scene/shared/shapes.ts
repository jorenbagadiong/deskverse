import * as THREE from "three"
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js"

/**
 * Procedural geometry factories for the characters and furniture.
 * Everything is generated in code: there are no external model files.
 */

export function roundedRectShape(
  width: number,
  height: number,
  radius: number,
) {
  const w = width / 2
  const h = height / 2
  const r = Math.min(radius, w, h)
  const shape = new THREE.Shape()
  shape.moveTo(-w + r, -h)
  shape.lineTo(w - r, -h)
  shape.quadraticCurveTo(w, -h, w, -h + r)
  shape.lineTo(w, h - r)
  shape.quadraticCurveTo(w, h, w - r, h)
  shape.lineTo(-w + r, h)
  shape.quadraticCurveTo(-w, h, -w, h - r)
  shape.lineTo(-w, -h + r)
  shape.quadraticCurveTo(-w, -h, -w + r, -h)
  return shape
}

/** A thick arc ("band") from angle a0 to a1, used for happy eyes and mouths. */
export function arcBandShape(
  radius: number,
  thickness: number,
  a0: number,
  a1: number,
) {
  const inner = radius - thickness / 2
  const outer = radius + thickness / 2
  const capR = thickness / 2
  const steps = 18
  const capSteps = 6
  const points: THREE.Vector2[] = []
  const at = (r: number, a: number) =>
    new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r)
  for (let i = 0; i <= steps; i++)
    points.push(at(outer, a0 + ((a1 - a0) * i) / steps))
  // Rounded cap at the a1 end (outer → inner)
  const c1 = at(radius, a1)
  for (let j = 1; j < capSteps; j++) {
    const t = a1 + (Math.PI * j) / capSteps
    points.push(
      new THREE.Vector2(c1.x + Math.cos(t) * capR, c1.y + Math.sin(t) * capR),
    )
  }
  for (let i = steps; i >= 0; i--)
    points.push(at(inner, a0 + ((a1 - a0) * i) / steps))
  // Rounded cap at the a0 end (inner → outer)
  const c0 = at(radius, a0)
  for (let j = 1; j < capSteps; j++) {
    const t = a0 + Math.PI + (Math.PI * j) / capSteps
    points.push(
      new THREE.Vector2(c0.x + Math.cos(t) * capR, c0.y + Math.sin(t) * capR),
    )
  }
  return new THREE.Shape(points)
}

/** Flat, front-facing glyph geometry (eyes, mouths, icons). */
export function flat(shape: THREE.Shape, curveSegments = 10) {
  return new THREE.ShapeGeometry(shape, curveSegments)
}

/** Extruded, beveled plate: smooth edges that catch light (face screens, badges). */
export function beveledPlate(shape: THREE.Shape, depth: number, bevel: number) {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 6,
  })
  geometry.translate(0, 0, -depth / 2)
  geometry.computeVertexNormals()
  return geometry
}

export function roundedBox(
  width: number,
  height: number,
  depth: number,
  radius: number,
  segments = 5,
) {
  return new RoundedBoxGeometry(width, height, depth, segments, radius)
}

/**
 * Smooth body of revolution through the given [radius, height] points
 * (Catmull-Rom interpolated), e.g. an egg-shaped torso or a dome.
 */
export function smoothLathe(
  points: [number, number][],
  samples = 20,
  radialSegments = 28,
) {
  const curve = new THREE.SplineCurve(
    points.map(([r, y]) => new THREE.Vector2(r, y)),
  )
  const profile = curve.getPoints(samples)
  // Close the ends on the axis so there are no holes.
  if (profile[0].x !== 0) profile.unshift(new THREE.Vector2(0, profile[0].y))
  const last = profile[profile.length - 1]
  if (last.x !== 0) profile.push(new THREE.Vector2(0, last.y))
  const geometry = new THREE.LatheGeometry(profile, radialSegments)
  geometry.computeVertexNormals()
  return geometry
}

/** Prepare a geometry for merging: non-indexed with only position/normal/uv. */
export function normalizeForMerge(geometry: THREE.BufferGeometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone()
  for (const name of Object.keys(g.attributes)) {
    if (name !== "position" && name !== "normal" && name !== "uv")
      g.deleteAttribute(name)
  }
  if (!g.attributes.uv) {
    const count = g.attributes.position.count
    g.setAttribute(
      "uv",
      new THREE.BufferAttribute(new Float32Array(count * 2), 2),
    )
  }
  if (!g.attributes.normal) g.computeVertexNormals()
  g.clearGroups()
  return g
}
