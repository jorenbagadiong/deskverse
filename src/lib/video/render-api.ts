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
  AudioMode,
  AudioRole,
  ImageMimeType,
  ProductInfo,
  VisualEffects,
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
 *
 * Job management (DV-003D1):
 *   GET    /api/studio/pixel/jobs[?limit=N]            → JobHistory         newest first, bounded
 *   POST   /api/studio/pixel/jobs/:jobId/cancel        → RenderJobStatus    stop a queued/active render
 *   POST   /api/studio/pixel/jobs/:jobId/retry         → RenderJobStatus    re-queue a failed job
 *   DELETE /api/studio/pixel/jobs/:jobId               → { deleted: true }  remove the job and its files
 *   GET    /api/studio/pixel/storage                   → StorageSummary
 *   POST   /api/studio/pixel/storage/cleanup           → CleanupSummary     remove abandoned temp data
 */

export const JOBS_ENDPOINT = "/api/studio/pixel/jobs"
export const jobEndpoint = (id: string) =>
  `${JOBS_ENDPOINT}/${encodeURIComponent(id)}`
export const assetsEndpoint = (id: string) => `${jobEndpoint(id)}/assets`
export const renderEndpoint = (id: string) => `${jobEndpoint(id)}/render`
export const audioEndpoint = (id: string, role: AudioRole) =>
  `${jobEndpoint(id)}/audio?role=${role}`
export const cancelEndpoint = (id: string) => `${jobEndpoint(id)}/cancel`
export const retryEndpoint = (id: string) => `${jobEndpoint(id)}/retry`
export const STORAGE_ENDPOINT = "/api/studio/pixel/storage"
export const CLEANUP_ENDPOINT = `${STORAGE_ENDPOINT}/cleanup`
export const historyEndpoint = (limit?: number) =>
  `${JOBS_ENDPOINT}${limit ? `?limit=${limit}` : ""}`

/** History page sizes. */
export const HISTORY_LIMIT = { default: 30, max: 100 } as const

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
  /**
   * Optional (DV-003D2): named choices only. Omitted renders static with
   * cuts, as before; the studio always sends what the user picked.
   */
  effects?: VisualEffects
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

/** What the user may do with a job right now (decided by the server). */
export interface JobActions {
  cancel: boolean
  retry: boolean
  delete: boolean
  preview: boolean
}

/**
 * Where the narration plays, as resolved by the server from the saved timing
 * and the recording's FFprobe duration (DV-003D3).
 */
export interface NarrationSummary {
  startSeconds: number
  endSeconds: number
  trimStartSeconds: number
  trimEndSeconds: number
  videoSeconds: number
}

/** POST /render's answer: the job status plus the approved narration timing. */
export type RenderStartResponse = RenderJobStatus & {
  narration: NarrationSummary | null
}

/** One row of the render history: no paths, no private asset metadata. */
export interface JobSummary {
  jobId: RenderJobId
  state: RenderJobState
  createdAt: string
  updatedAt: string
  /** From the server-built project; null for drafts or unreadable projects. */
  productName: string | null
  audioMode: AudioMode | null
  /** The project's effects (static with cuts for pre-DV-003D2 projects); null for drafts. */
  effects: VisualEffects | null
  /** Narration timing when the project has a voiceover; null otherwise. */
  narration: NarrationSummary | null
  imageCount: number
  /** Verified facts, only for completed videos. */
  durationSeconds: number | null
  sizeBytes: number | null
  error: RenderJobError | null
  progress: RenderProgress | null
  videoUrl: string | null
  downloadUrl: string | null
  actions: JobActions
}

export interface JobHistory {
  jobs: JobSummary[]
  /** All readable jobs in storage (the list may be shorter). */
  total: number
  limit: number
}

export interface StorageSummary {
  totalBytes: number
  uploadBytes: number
  outputBytes: number
  workBytes: number
  otherBytes: number
  jobs: number
  completed: number
  failed: number
  interrupted: number
  cancelled: number
  drafts: number
  active: number
  unreadable: number
}

export interface CleanupSummary {
  freedBytes: number
  removedDrafts: number
  clearedWorkDirs: number
  removedTempFiles: number
}
