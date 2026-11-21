import type { VIDEO_FORMAT } from "@/lib/video/format"
import type { AssetId } from "@/lib/video/ids"

/** What the video is about. All text is validated (see validation.ts). */
export interface ProductInfo {
  name: string
  headline: string
  /** One caption per benefit scene, 1–5 of them. */
  benefits: string[]
  callToAction: string
  /** Affiliate disclosure, shown on every scene of the video. */
  disclosure: string
}

/** Image types FFmpeg can decode that carry no scripts (no SVG, no GIF). */
export const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number]

export const IMAGE_EXTENSIONS: Record<ImageMimeType, readonly string[]> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
}

/** What a client may tell us about a file before it is stored. Untrusted. */
export interface MediaAssetMetadata {
  /** Display only: never used to build a path. */
  fileName: string
  mimeType: ImageMimeType
  sizeBytes: number
  width: number
  height: number
}

/** A media file stored in a job's private directory under its generated ID. */
export interface MediaAsset {
  id: AssetId
  kind: "image"
  mimeType: ImageMimeType
  sizeBytes: number
  width: number
  height: number
  /** Sanitized original name, display only. */
  displayName: string
}

export type CaptionRole = "headline" | "benefit" | "call-to-action"
export type CaptionPosition = "top" | "center" | "bottom"

export interface Caption {
  text: string
  /** Smaller line under the caption (the product name on the hook scene). */
  subtext: string | null
  role: CaptionRole
  position: CaptionPosition
}

export type SceneKind = "hook" | "benefit" | "call-to-action"

export interface VideoScene {
  /** Stable within a storyboard: "scene-1", "scene-2"… */
  id: string
  kind: SceneKind
  /** Whole frames at VIDEO_FORMAT.fps, so durations never drift. */
  durationFrames: number
  /** The image shown in this scene, or null for a solid brand background. */
  assetId: AssetId | null
  caption: Caption
}

/**
 * Settings are not configurable in DV-003A: the type only admits the fixed
 * format, and validation rejects anything else, including extra keys.
 */
export interface VideoSettings {
  width: typeof VIDEO_FORMAT.width
  height: typeof VIDEO_FORMAT.height
  fps: typeof VIDEO_FORMAT.fps
  container: typeof VIDEO_FORMAT.container
  videoCodec: typeof VIDEO_FORMAT.videoCodec
  pixelFormat: typeof VIDEO_FORMAT.pixelFormat
  audio: typeof VIDEO_FORMAT.audio
}

/** Everything a render needs, and nothing a client could use to steer FFmpeg. */
export interface VideoProject {
  product: ProductInfo
  assets: MediaAsset[]
  scenes: VideoScene[]
  settings: VideoSettings
}
