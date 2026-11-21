import type { AssetId, RenderJobId } from "@/lib/video/ids"
import type {
  RenderJobError,
  RenderJobState,
  RenderOutput,
  RenderProgress,
} from "@/lib/video/render-job"
import type {
  AudioConfig,
  AudioContainer,
  AudioRole,
  ImageMimeType,
  ProductInfo,
} from "@/lib/video/types"

/**
 * The HTTP contract between Pixel Studio and the local render endpoints.
 * Shared by the browser and the route handlers; client-safe (types + paths).
 *
 *   POST /api/studio/pixel/jobs                       → { jobId }            create a draft
 *   POST /api/studio/pixel/jobs/:jobId/assets         raw image bytes        upload one image
 *   POST /api/studio/pixel/jobs/:jobId/audio?role=voiceover|music  raw audio  upload audio (DV-003C)
 *   POST /api/studio/pixel/jobs/:jobId/render         RenderRequest (JSON)   queue the render
 *   GET  /api/studio/pixel/jobs/:jobId                → RenderJobStatus      poll
 *   GET  /api/studio/pixel/jobs/:jobId/video[?download=1]                    verified MP4 only
 */

export const JOBS_ENDPOINT = "/api/studio/pixel/jobs"
export const jobEndpoint = (id: string) =>
  `${JOBS_ENDPOINT}/${encodeURIComponent(id)}`
export const assetsEndpoint = (id: string) => `${jobEndpoint(id)}/assets`
export const renderEndpoint = (id: string) => `${jobEndpoint(id)}/render`
export const audioEndpoint = (id: string, role: AudioRole) =>
  `${jobEndpoint(id)}/audio?role=${role}`
export const videoEndpoint = (id: string, download = false) =>
  `${jobEndpoint(id)}/video${download ? "?download=1" : ""}`

/** Display name of an upload, URI-encoded so any characters survive a header. */
export const FILE_NAME_HEADER = "x-file-name"

/** The only fields a render request may contain. */
export interface RenderRequest {
  product: ProductInfo
  /** Uploaded image IDs of this job, in storyboard order (first = hero). */
  assetIds: AssetId[]
  /** Optional (DV-003C): omitted or mode "none" renders a silent video. */
  audio?: AudioConfig
}

export interface UploadedAudio {
  id: AssetId
  role: AudioRole
  displayName: string
  container: AudioContainer
  sizeBytes: number
  durationSeconds: number
  sampleRate: number
  channels: number
}

export interface UploadedAsset {
  id: AssetId
  displayName: string
  mimeType: ImageMimeType
  sizeBytes: number
  width: number
  height: number
}

export interface RenderJobStatus {
  jobId: RenderJobId
  state: RenderJobState
  /** Live progress while queued/rendering in this server process. */
  progress: RenderProgress | null
  error: RenderJobError | null
  /** FFprobe-verified output, only once completed. */
  output: RenderOutput | null
  /** Set only for completed, verified videos. */
  videoUrl: string | null
  downloadUrl: string | null
}

export interface ApiError {
  error: string
  message: string
  issues?: { path: string; message: string }[]
}
