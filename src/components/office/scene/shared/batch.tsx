"use client"

import { useLayoutEffect, useRef } from "react"
import { useThree } from "@react-three/fiber"
import * as THREE from "three"
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js"

import { useSceneMaterials } from "../materials"

import { normalizeForMerge } from "./shapes"

/**
 * Draw-call reducer for rigid groups. Children are authored as ordinary,
 * readable JSX meshes; after mount, every static mesh in the subtree is merged
 * by material into one mesh, and the originals are hidden (they still receive
 * pointer events). Subtrees with `userData={{ dynamic: true }}` (animated or
 * blinking parts) are left alone.
 *
 * Re-merges when `version` changes (e.g. status or expression) or the theme's
 * material set changes. Merged geometries are disposed on cleanup.
 */
export function Batch({
  version = "",
  children,
}: {
  version?: string
  children: React.ReactNode
}) {
  const root = useRef<THREE.Group>(null)
  const materials = useSceneMaterials()
  const invalidate = useThree((s) => s.invalidate)

  useLayoutEffect(() => {
    const group = root.current
    if (!group) return
    const result = batchMeshes(group)
    invalidate()
    return () => {
      result.dispose()
      invalidate()
    }
  }, [version, materials, invalidate])

  return <group ref={root}>{children}</group>
}

type Bucket = {
  material: THREE.Material
  castShadow: boolean
  receiveShadow: boolean
  geometries: THREE.BufferGeometry[]
  sources: THREE.Mesh[]
}

export function batchMeshes(group: THREE.Group) {
  group.updateWorldMatrix(true, true)
  const toLocal = group.matrixWorld.clone().invert()
  const buckets = new Map<string, Bucket>()
  const matrix = new THREE.Matrix4()

  const visit = (object: THREE.Object3D) => {
    if (
      object !== group &&
      (object.userData.dynamic || object.userData.batched)
    )
      return
    const mesh = object as THREE.Mesh
    if (
      mesh.isMesh &&
      !Array.isArray(mesh.material) &&
      mesh.material.visible !== false
    ) {
      const key = `${mesh.material.uuid}:${mesh.castShadow}:${mesh.receiveShadow}`
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = {
          material: mesh.material,
          castShadow: mesh.castShadow,
          receiveShadow: mesh.receiveShadow,
          geometries: [],
          sources: [],
        }
        buckets.set(key, bucket)
      }
      matrix.multiplyMatrices(toLocal, mesh.matrixWorld)
      const geometry = normalizeForMerge(mesh.geometry)
      geometry.applyMatrix4(matrix)
      bucket.geometries.push(geometry)
      bucket.sources.push(mesh)
    }
    for (const child of object.children) visit(child)
  }
  visit(group)

  const merged: THREE.Mesh[] = []
  const hidden: THREE.Mesh[] = []
  const scratch: THREE.BufferGeometry[] = []
  for (const bucket of buckets.values()) {
    scratch.push(...bucket.geometries)
    if (bucket.sources.length < 2) continue
    const geometry = mergeGeometries(bucket.geometries, false)
    if (!geometry) continue
    const mesh = new THREE.Mesh(geometry, bucket.material)
    mesh.castShadow = bucket.castShadow
    mesh.receiveShadow = bucket.receiveShadow
    mesh.userData.batched = true
    // Originals keep handling pointer events; the merged copy only draws.
    mesh.raycast = () => {}
    group.add(mesh)
    merged.push(mesh)
    for (const source of bucket.sources) {
      source.visible = false
      hidden.push(source)
    }
  }
  for (const geometry of scratch) geometry.dispose()

  return {
    drawCallsSaved: hidden.length - merged.length,
    dispose() {
      for (const mesh of merged) {
        group.remove(mesh)
        mesh.geometry.dispose()
      }
      for (const source of hidden) source.visible = true
    },
  }
}
