/**
 * Generated identifiers for render jobs and media assets.
 *
 * IDs are the only thing ever used to build file-system paths: user-supplied
 * file names are kept for display at most. The strict patterns below make an
 * ID safe to use as a single path segment (no separators, no dots, no case
 * tricks), so a valid ID can never escape its directory.
 */

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

export type RenderJobId = Brand<string, "RenderJobId">
export type AssetId = Brand<string, "AssetId">

/** 128 random bits, lowercase hex. */
const HEX_32 = "[0-9a-f]{32}"
export const RENDER_JOB_ID_PATTERN = new RegExp(`^job_${HEX_32}$`)
export const ASSET_ID_PATTERN = new RegExp(`^asset_${HEX_32}$`)

function randomHex(bytes: number) {
  const buffer = new Uint8Array(bytes)
  // Web Crypto: available in browsers and in Node.js 20+ as a global.
  globalThis.crypto.getRandomValues(buffer)
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("")
}

export function createRenderJobId(): RenderJobId {
  return `job_${randomHex(16)}` as RenderJobId
}

export function createAssetId(): AssetId {
  return `asset_${randomHex(16)}` as AssetId
}

export function isRenderJobId(value: unknown): value is RenderJobId {
  return typeof value === "string" && RENDER_JOB_ID_PATTERN.test(value)
}

export function isAssetId(value: unknown): value is AssetId {
  return typeof value === "string" && ASSET_ID_PATTERN.test(value)
}
