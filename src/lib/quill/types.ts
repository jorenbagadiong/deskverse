import type { ProductInfo, SceneKind } from "@/lib/video/types"

/**
 * Quill scriptwriting contract (DV-005B), shared by the server and the
 * browser. A script is written only from one exact, verified Scout report.
 * Every scene that states a product fact lists the Scout claims and
 * evidence behind it; scenes without claims carry no product facts.
 */

export const QUILL_FORMAT = "quill-script/1"
export const QUILL_TEMPLATES = "quill-templates/1"

export type GenerationMode = "template" | "template+ollama"

export const GENERATION_MODE_LABEL: Record<GenerationMode, string> = {
  template: "Template (no AI model)",
  "template+ollama": "Template + local AI wording (Ollama)",
}

export interface SceneEvidence {
  key: string
  sourceKey: string
  sourceUrl: string
  retrievedAt: string | null
}

export interface SceneClaim {
  claimKey: string
  /** The Scout claim's statement, as recorded in the report. */
  statement: string
  evidence: SceneEvidence[]
}

export interface QuillScene {
  /** Stable: "scene-1", "scene-2"… (the same ids Pixel's storyboard uses). */
  id: string
  /** Pixel's scene vocabulary. */
  kind: SceneKind
  durationMs: number
  narration: string
  caption: string
  subtext: string | null
  visual: string
  claims: SceneClaim[]
  notes: string[]
}

export type FindingLevel = "error" | "warning" | "info"

export interface Finding {
  level: FindingLevel
  code: string
  message: string
  sceneId: string | null
}

export interface ExcludedClaim {
  claimKey: string
  statement: string
  reason: string
}

export interface QuillScriptDocument {
  format: typeof QUILL_FORMAT
  ticketId: string
  productId: string
  productName: string
  snapshotChecksum: string
  report: { id: string; version: number; checksum: string }
  generation: {
    mode: GenerationMode
    templates: typeof QUILL_TEMPLATES
    model: {
      name: string
      digest: string | null
      ollamaVersion: string | null
      temperature: number
    } | null
    modelProposalsAccepted: number
    modelProposalsRejected: number
    note: string | null
  }
  language: "en"
  platform: string
  status: "valid"
  totalDurationMs: number
  estimatedNarrationSeconds: number
  scenes: QuillScene[]
  disclosure: {
    text: string
    /** Overlaid on every scene, like Pixel's disclosure. */
    placement: "every-scene"
    required: true
    source: "pixel-default"
  }
  pixel: {
    /** The script's text in Pixel's product contract (validated by Pixel's own rules). */
    product: ProductInfo
    textCompatible: boolean
    textIssues: string[]
    renderReady: boolean
    renderIssues: string[]
    imageCount: number
  }
  findings: Finding[]
  excludedClaims: ExcludedClaim[]
  generatedAt: string
}

export interface QuillScript {
  id: string
  runId: string
  taskId: string
  scriptVersion: number
  schemaVersion: number
  createdAt: string
  checksum: string
  integrity: "verified" | "mismatch"
  document: QuillScriptDocument
}

export interface QuillScriptSummary {
  id: string
  runId: string
  productId: string
  productName: string
  scriptVersion: number
  reportId: string
  reportVersion: number
  mode: GenerationMode
  createdAt: string
  scenes: number
  pixelTextCompatible: boolean
  renderReady: boolean
}

export interface ReportChoice {
  reportId: string
  reportVersion: number
  createdAt: string
  status: "complete" | "insufficient_evidence"
  /** The product hasn't changed since this research (same frozen input). */
  current: boolean
  integrity: "verified" | "mismatch"
  eligibleFacts: number
  /** Why it can't be used, when it can't. */
  problem: string | null
}

export interface QuillProduct {
  productId: string
  name: string
  reports: ReportChoice[]
}

export interface QuillTaskState {
  productId: string
  productName: string
  taskId: string
  status: string
  attempts: number
  failureMessage: string | null
  reportId: string | null
  reportVersion: number | null
  scriptId: string | null
}

export interface QuillOverview {
  availability: {
    available: boolean
    mode: "template" | "ollama"
    reason: string | null
  }
  products: QuillProduct[]
  latestRun: {
    id: string
    status: string
    createdAt: string
    tasks: QuillTaskState[]
  } | null
  scripts: QuillScriptSummary[]
}

export const quillEndpoint = (ticketId: string) =>
  `/api/tickets/${encodeURIComponent(ticketId)}/scripts`
export const scriptEndpoint = (
  ticketId: string,
  runId: string,
  scriptId: string,
) =>
  `/api/tickets/${encodeURIComponent(ticketId)}/runs/${encodeURIComponent(runId)}/scripts/${encodeURIComponent(scriptId)}`
export const runScriptsEndpoint = (ticketId: string, runId: string) =>
  `/api/tickets/${encodeURIComponent(ticketId)}/runs/${encodeURIComponent(runId)}/scripts`
