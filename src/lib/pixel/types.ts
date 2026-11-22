import type { RenderProgress } from "@/lib/video/render-job"

/**
 * Pixel ticket video contract (DV-005C), shared by the server and the
 * browser. A ticket video is rendered by Pixel Studio's own trusted
 * renderer from one verified Quill script and 3–6 pinned ticket images.
 * Finished videos are "technically verified, awaiting Vera QA": never
 * QA-approved here.
 */

export const RENDER_CONFIG = "pixel-ticket-render/1"
export const AWAITING_QA = "technically_verified_awaiting_qa"
export const AWAITING_QA_LABEL = "Technically verified — Awaiting Vera QA"

export type RenderState =
  | "planned"
  | "waiting_for_renderer"
  | "rendering"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"

export const RENDER_STATE_LABEL: Record<RenderState, string> = {
  planned: "Waiting for a worker",
  waiting_for_renderer: "Waiting for the renderer (another video is rendering)",
  rendering: "Rendering",
  verifying: "Verifying the video",
  completed: AWAITING_QA_LABEL,
  failed: "Failed",
  cancelled: "Cancelled",
}

export interface PixelImageChoice {
  assetId: string
  sha256: string
  mimeType: string
  width: number
  height: number
  name: string
  /** Pinned by the chosen script's frozen input (images added later aren't). */
  inScriptInput: boolean
}

export interface PixelScriptChoice {
  scriptId: string
  scriptVersion: number
  reportVersion: number
  createdAt: string
  integrity: "verified" | "mismatch"
  /** The product hasn't changed since the script's research (same frozen input). */
  current: boolean
  textCompatible: boolean
  problem: string | null
  /** Images of the script's frozen input (the only ones it may use). */
  imageIds: string[]
}

export interface PixelProduct {
  productId: string
  name: string
  mediaRights: string
  images: PixelImageChoice[]
  scripts: PixelScriptChoice[]
}

export interface PixelRenderState {
  renderJobId: string
  taskId: string
  productId: string
  productName: string
  taskStatus: string
  state: RenderState
  progress: RenderProgress | null
  error: string | null
  failureMessage: string | null
  attempts: number
  scriptVersion: number
  deliverableId: string | null
}

export interface PixelDeliverable {
  id: string
  runId: string
  productId: string
  productName: string
  version: number
  scriptId: string
  scriptVersion: number
  scriptChecksum: string
  sha256: string
  byteSize: number
  width: number
  height: number
  durationMs: number
  fps: number
  videoCodec: string
  pixelFormat: string
  audio: boolean
  encoder: string
  disclosureVerified: boolean
  checks: Record<string, unknown>
  status: typeof AWAITING_QA
  verifiedAt: string
  createdAt: string
}

export interface PixelOverview {
  availability: {
    ffmpeg: { ready: boolean; encoder: string | null; problem: string | null }
  }
  products: PixelProduct[]
  latestRun: {
    id: string
    status: string
    createdAt: string
    renders: PixelRenderState[]
  } | null
  deliverables: PixelDeliverable[]
}

export const pixelEndpoint = (ticketId: string) =>
  `/api/tickets/${encodeURIComponent(ticketId)}/videos`
export const deliverableEndpoint = (ticketId: string, deliverableId: string) =>
  `${pixelEndpoint(ticketId)}/${encodeURIComponent(deliverableId)}`
export const deliverableVideoUrl = (
  ticketId: string,
  deliverableId: string,
  download = false,
) =>
  `${deliverableEndpoint(ticketId, deliverableId)}/file${download ? "?download=1" : ""}`
