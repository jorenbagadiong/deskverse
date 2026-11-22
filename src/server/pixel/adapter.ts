import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"

import type { QuillScriptDocument } from "@/lib/quill/types"
import { VIDEO_FORMAT } from "@/lib/video/format"
import type { ImageMimeType, VideoProject } from "@/lib/video/types"
import { DEFAULT_DISCLOSURE, validateProduct } from "@/lib/video/validation"
import type { Queryable } from "@/server/orchestrator/canonical"
import {
  manifestChecksum,
  manifestFromRow,
  STALE_STEPS,
  type RenderManifest,
} from "@/server/pixel/plan"
import { selectFacts } from "@/server/quill/select"
import { getScript } from "@/server/quill/store"
import { validateScript } from "@/server/quill/validate"
import { verifyScoutReport } from "@/server/scout/store"
import { openAssetFile } from "@/server/tickets/media"
import {
  sniffTicketMedia,
  verifyImage,
  type MediaTools,
} from "@/server/tickets/media-verify"
import type { FontMetrics, VideoFontWeight } from "@/server/video/font-metrics"
import { buildTrustedProject } from "@/server/video/project"
import type { VideoStorage } from "@/server/video/storage"

/**
 * The Quill → Pixel adapter (DV-005C). Pixel renders exactly what its own
 * trusted builder produces from `script.pixel.product` (Pixel's product
 * contract) and the pinned images; the script's scene JSON is never used
 * as a render project. Before rendering, everything is re-verified from
 * current records, and the built project must match the script's scenes
 * (kinds, order, captions, subtext, durations) or the render is refused.
 *
 * Not rendered (and never claimed to be): narration (Quill writes text,
 * not speech: videos are silent and captioned) and visual directions
 * (guidance; Pixel uses its fixed layout and the pinned images in order).
 */

export class AdapterRefusal extends Error {
  constructor(
    readonly kind: "permanent" | "needs_input",
    message: string,
  ) {
    super(message)
  }
}

export interface VerifiedInputs {
  manifest: RenderManifest
  doc: QuillScriptDocument
  scriptVersion: number
  images: {
    assetId: string
    bytes: Uint8Array
    mimeType: ImageMimeType
    name: string
  }[]
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")

export async function verifyRenderInputs(
  db: Queryable,
  renderJob: Record<string, unknown>,
  task: { ticketId: string; snapshotChecksum: string },
  media: { dataRoot: string; tools: MediaTools },
): Promise<VerifiedInputs> {
  const scriptRow = (
    await db.query(
      "SELECT run_id FROM quill_scripts WHERE id = $1 AND ticket_id = $2 AND product_id = $3",
      [renderJob.script_id, task.ticketId, renderJob.product_id],
    )
  ).rows[0]
  if (!scriptRow)
    throw new AdapterRefusal(
      "permanent",
      "The pinned script isn't part of this ticket and product.",
    )
  const manifest = manifestFromRow(renderJob, scriptRow.run_id)
  if (manifestChecksum(manifest) !== renderJob.manifest_checksum)
    throw new AdapterRefusal(
      "permanent",
      "The render manifest doesn't match its checksum.",
    )
  const script = await getScript(
    db,
    task.ticketId,
    scriptRow.run_id,
    manifest.script.id,
  )
  if (
    !script ||
    script.integrity !== "verified" ||
    script.checksum !== manifest.script.checksum ||
    script.scriptVersion !== manifest.script.version
  )
    throw new AdapterRefusal(
      "permanent",
      "The pinned Quill script fails its checksum check or isn't the pinned version.",
    )
  const doc = script.document
  if (doc.ticketId !== task.ticketId || doc.productId !== manifest.productId)
    throw new AdapterRefusal(
      "permanent",
      "The script belongs to another ticket or product.",
    )
  const report = await verifyScoutReport(db, manifest.report.id)
  if (
    !report?.intact ||
    report.checksum !== manifest.report.checksum ||
    report.reportVersion !== manifest.report.version ||
    doc.report.id !== manifest.report.id
  )
    throw new AdapterRefusal(
      "permanent",
      "The script's Scout research no longer verifies.",
    )
  if (
    task.snapshotChecksum !== manifest.snapshotChecksum ||
    doc.snapshotChecksum !== manifest.snapshotChecksum
  )
    throw new AdapterRefusal(
      "permanent",
      `The script was written from different product data than this task's frozen copy. ${STALE_STEPS}`,
    )
  // Facts and disclosure, re-validated with Quill's own rules.
  const errors = validateScript(
    doc,
    selectFacts(report.report).eligible,
  ).filter((f) => f.level === "error")
  if (errors.length > 0)
    throw new AdapterRefusal(
      "permanent",
      `The script no longer passes validation: ${errors[0].message}`,
    )
  if (
    doc.disclosure.text !== DEFAULT_DISCLOSURE ||
    doc.pixel.product.disclosure !== doc.disclosure.text ||
    !doc.disclosure.required
  )
    throw new AdapterRefusal(
      "permanent",
      "The script's affiliate disclosure is missing or changed.",
    )
  const text = validateProduct(doc.pixel.product)
  if (!text.ok)
    throw new AdapterRefusal(
      "permanent",
      `The script's text doesn't fit Pixel's limits: ${text.issues[0].message}`,
    )

  // Images: current records, real files, same bytes, decodable.
  const images: VerifiedInputs["images"] = []
  for (const pinned of manifest.assets) {
    const row = (
      await db.query(
        "SELECT id, ticket_id, extension, byte_size, sha256, mime_type, original_name FROM ticket_assets WHERE id = $1 AND ticket_id = $2 AND product_id = $3 AND kind = 'image'",
        [pinned.id, task.ticketId, manifest.productId],
      )
    ).rows[0]
    if (!row || row.sha256 !== pinned.sha256)
      throw new AdapterRefusal(
        "needs_input",
        `A pinned image was removed or replaced. ${STALE_STEPS}`,
      )
    let file: string
    try {
      file = (
        await openAssetFile(media.dataRoot, {
          ticketId: row.ticket_id,
          id: row.id,
          extension: row.extension,
          byteSize: Number(row.byte_size),
        })
      ).file
    } catch {
      throw new AdapterRefusal(
        "needs_input",
        "A pinned image file is missing or changed on disk. Run yarn tickets:reconcile, then upload it again.",
      )
    }
    const bytes = new Uint8Array(await fs.readFile(file))
    if (sha(bytes) !== pinned.sha256)
      throw new AdapterRefusal(
        "needs_input",
        "A pinned image's bytes no longer match their checksum.",
      )
    const type = sniffTicketMedia(bytes.subarray(0, 64))
    if (type !== row.mime_type || type === "video/mp4" || !type)
      throw new AdapterRefusal(
        "needs_input",
        "A pinned image isn't the still image it was recorded as.",
      )
    try {
      await verifyImage(file, type, bytes.subarray(0, 256 * 1024), media.tools)
    } catch (error) {
      throw new AdapterRefusal(
        "needs_input",
        `A pinned image can't be used: ${(error as Error).message}`,
      )
    }
    images.push({
      assetId: row.id,
      bytes,
      mimeType: type,
      name: row.original_name || `image.${row.extension}`,
    })
  }
  return { manifest, doc, scriptVersion: script.scriptVersion, images }
}

/**
 * Builds the trusted Pixel project in a new private Pixel job: the images
 * are added through Pixel's own upload checks, the project through Pixel's
 * own builder, then compared with the script's scenes.
 */
export async function buildTicketProject(
  storage: VideoStorage,
  inputs: VerifiedInputs,
  fonts: Record<VideoFontWeight, FontMetrics>,
): Promise<{ jobId: string; project: VideoProject }> {
  const job = await storage.createJob()
  const assetIds: string[] = []
  for (const image of inputs.images) {
    const asset = await storage.addImageAsset(job.id, {
      bytes: image.bytes,
      declaredType: image.mimeType,
      fileName: image.name,
    })
    assetIds.push(asset.id)
  }
  const fresh = await storage.readJob(job.id)
  const built = buildTrustedProject(
    fresh,
    { product: inputs.doc.pixel.product, assetIds },
    fonts,
  )
  if (!built.ok)
    throw new AdapterRefusal(
      "permanent",
      `Pixel can't build this video: ${built.issues[0].message}`,
    )
  assertFidelity(inputs.doc, built.value)
  await storage.writeProject(job.id, built.value)
  return { jobId: job.id, project: built.value }
}

/** The project Pixel built must say exactly what the script's scenes say. */
export function assertFidelity(
  doc: QuillScriptDocument,
  project: VideoProject,
) {
  const problems: string[] = []
  if (project.scenes.length !== doc.scenes.length)
    problems.push(
      `${project.scenes.length} scenes instead of ${doc.scenes.length}`,
    )
  project.scenes.forEach((scene, i) => {
    const s = doc.scenes[i]
    if (!s) return
    if (scene.kind !== s.kind)
      problems.push(`scene ${i + 1} is a ${scene.kind}, not a ${s.kind}`)
    if (scene.caption.text !== s.caption)
      problems.push(`scene ${i + 1}'s caption differs`)
    if ((scene.caption.subtext ?? null) !== (s.subtext ?? null))
      problems.push(`scene ${i + 1}'s subtext differs`)
    const ms = Math.round((scene.durationFrames / VIDEO_FORMAT.fps) * 1000)
    if (Math.abs(ms - s.durationMs) > 1)
      problems.push(`scene ${i + 1} lasts ${ms} ms, not ${s.durationMs} ms`)
  })
  if (project.product.disclosure !== doc.disclosure.text)
    problems.push("the disclosure differs")
  if (project.audio && project.audio.mode !== "none")
    problems.push("the project has audio")
  if (problems.length > 0)
    throw new AdapterRefusal(
      "permanent",
      `Pixel can't render this script faithfully: ${problems.slice(0, 3).join("; ")}.`,
    )
}
