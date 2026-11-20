import type * as THREE from "three"

/**
 * One instance of each shared geometry for the whole scene. Seven characters
 * reuse the same head/limb/eye buffers instead of creating their own.
 *
 * Geometries are created lazily on first use. `disposeAll()` releases GPU
 * buffers (called when the office unmounts or is hidden); three.js re-uploads
 * them automatically if they are rendered again.
 */
class GeometryCache {
  private readonly items = new Map<string, THREE.BufferGeometry>()

  get<T extends THREE.BufferGeometry>(key: string, create: () => T): T {
    let geometry = this.items.get(key) as T | undefined
    if (!geometry) {
      geometry = create()
      this.items.set(key, geometry)
    }
    return geometry
  }

  get size() {
    return this.items.size
  }

  disposeAll() {
    for (const geometry of this.items.values()) geometry.dispose()
  }
}

export const geometryCache = new GeometryCache()

/** Hook-style accessor; the cache is a plain singleton, so this is render-safe. */
export function useSharedGeometry<T extends THREE.BufferGeometry>(
  key: string,
  create: () => T,
): T {
  return geometryCache.get(key, create)
}
