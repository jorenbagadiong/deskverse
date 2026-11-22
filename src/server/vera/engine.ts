import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { PLATFORM_PREPARATION } from "@/lib/vera/policy"
import type { TicketPlatform } from "@/lib/tickets/types"
import {
  VERA_FORMAT,
  VERA_RULESET,
  PLATFORM_CHECKLIST,
  type ReviewPin,
  type VeraDocument,
  type VeraFinding,
} from "@/lib/vera/types"
import {
  canonicalJson,
  sha256,
  type Queryable,
} from "@/server/orchestrator/canonical"
import type { HandlerContext } from "@/server/orchestrator/workflows"
import { HandlerAborted } from "@/server/orchestrator/workflows"
import { ticketRenderStorage } from "@/server/pixel/store"
import { buildTrustedProject } from "@/server/video/project"
import { loadVideoFont } from "@/server/video/font-metrics"
import { loadInputs, LineageError } from "./inputs"
import { aggregateVerdict, contentChecks, finding } from "./rules"
import { fileDigest, videoChecks } from "./video"

export async function reviewVideo(
  db: Queryable,
  ctx: HandlerContext,
  options: { dataRoot: string; commands: { ffmpeg: string; ffprobe: string } },
): Promise<VeraDocument> {
  const pin = ctx.params.veraPin as ReviewPin
  if (!pin || pin.ticketId !== ctx.ticketId || pin.ruleset !== VERA_RULESET)
    throw new Error("No supported Vera pin.")
  const findings: VeraFinding[] = []
  const finish = (): VeraDocument => ({
    format: VERA_FORMAT,
    ruleset: VERA_RULESET,
    platformChecklist: PLATFORM_CHECKLIST,
    taskId: ctx.taskId,
    runId: ctx.runId,
    pin,
    verdict: aggregateVerdict(findings),
    findings,
    revisionPolicy: {
      automaticContentRevisions: 0,
      executionMaxAttempts: ctx.maxAttempts,
    },
    completedAt: new Date().toISOString(),
  })
  let inputs
  try {
    inputs = await loadInputs(db, ctx.ticketId, pin.deliverableId)
    if (canonicalJson(inputs.pin) !== canonicalJson(pin))
      throw new LineageError(
        "The selected deliverable's frozen pin no longer matches.",
      )
  } catch (e) {
    if (!(e instanceof LineageError)) throw e
    findings.push(
      finding(
        pin,
        "provenance.chain",
        "provenance",
        "failed",
        "fatal",
        "Exact Pixel → Quill → Scout → frozen product lineage verifies.",
        { problem: e.message },
        "Restore original records or run Scout, Quill and Pixel again with corrected inputs.",
      ),
    )
    return finish()
  }
  findings.push(
    finding(
      pin,
      "provenance.chain",
      "provenance",
      "passed",
      "info",
      "Exact versions, ownership and checksums verify through Pixel, Quill and Scout.",
      {
        manifestChecksum: pin.manifestChecksum,
        script: pin.manifest.script,
        report: pin.manifest.report,
        snapshotChecksum: pin.manifest.snapshotChecksum,
      },
      null,
      null,
      [pin.manifest.script.id, pin.manifest.report.id, pin.sourceSnapshotId],
    ),
  )
  const storage = ticketRenderStorage(options.dataRoot)
  const file = await storage
    .resolveCompletedOutput(inputs.deliverable.pixel_job_id)
    .catch(() => null)
  if (!file) {
    findings.push(
      finding(
        pin,
        "video.bytes",
        "video_technical",
        "failed",
        "fatal",
        "The MP4 exists inside approved private Pixel storage.",
        { exists: false },
        "Restore the original video or create a new Pixel version.",
      ),
    )
    return finish()
  }
  const digest = await fileDigest(file.path)
  const bytesMatch = digest === pin.sha256 && file.sizeBytes === pin.byteSize
  findings.push(
    finding(
      pin,
      "video.bytes",
      "video_technical",
      bytesMatch ? "passed" : "failed",
      bytesMatch ? "info" : "fatal",
      "Actual MP4 SHA-256 and byte count equal the explicitly pinned deliverable.",
      {
        sha256: digest,
        byteSize: file.sizeBytes,
        expectedSha256: pin.sha256,
        expectedBytes: pin.byteSize,
      },
      bytesMatch
        ? null
        : "Restore the original MP4; never overwrite a validated video with changed bytes.",
    ),
  )
  if (!bytesMatch) return finish()
  let project
  try {
    project = await storage.readProject(inputs.deliverable.pixel_job_id)
  } catch {
    findings.push(
      finding(
        pin,
        "provenance.project",
        "provenance",
        "failed",
        "fatal",
        "Pixel's trusted project remains readable.",
        { readable: false },
        "Restore Pixel's original project and assets.",
      ),
    )
    return finish()
  }
  const job = await storage.readJob(inputs.deliverable.pixel_job_id)
  const built = buildTrustedProject(
    job,
    {
      product: inputs.script.document.pixel.product,
      assetIds: project.assets.map((a) => a.id),
    },
    { bold: loadVideoFont("bold"), medium: loadVideoFont("medium") },
  )
  const trusted =
    built.ok && canonicalJson(built.value) === canonicalJson(project)
  findings.push(
    finding(
      pin,
      "provenance.project",
      "provenance",
      trusted ? "passed" : "failed",
      trusted ? "info" : "fatal",
      "Persisted Pixel project equals a fresh build from the validated Quill product text.",
      { trusted, projectChecksum: sha256(canonicalJson(project)) },
      trusted
        ? null
        : "Restore the trusted project or create a new Pixel version.",
    ),
  )
  if (!trusted) return finish()
  findings.push(
    ...contentChecks(pin, inputs.script.document, inputs.report, project),
  )
  let assetsMatch = project.assets.length === pin.manifest.assets.length
  for (const [i, a] of project.assets.entries()) {
    try {
      assetsMatch =
        assetsMatch &&
        (await fileDigest(await storage.assetPath(job.id, a.id))) ===
          pin.manifest.assets[i]?.sha256
    } catch {
      assetsMatch = false
    }
  }
  findings.push(
    finding(
      pin,
      "rights.image-bytes",
      "media_rights",
      assetsMatch ? "passed" : "failed",
      assetsMatch ? "info" : "owner",
      "Every rendered image matches its pinned product image checksum and order.",
      { assetsMatch, images: pin.manifest.assets },
      assetsMatch
        ? null
        : "Restore the pinned images or supply corrected product images and create a new version.",
    ),
  )
  const pixelFrames = inputs.deliverable.checks?.disclosureFrames
  const pixelVerified =
    inputs.deliverable.disclosure_verified === true &&
    Array.isArray(pixelFrames) &&
    pixelFrames.length === project.scenes.length &&
    project.scenes.every((s) =>
      pixelFrames.some(
        (f: { sceneId: string; iou: number }) =>
          f.sceneId === s.id && Number.isFinite(f.iou) && f.iou >= 0.6,
      ),
    )
  findings.push(
    finding(
      pin,
      "disclosure.pixel-evidence",
      "disclosure",
      pixelVerified ? "passed" : "failed",
      pixelVerified ? "info" : "revision",
      "Pixel recorded successful disclosure IoU ≥0.60 for every exact scene.",
      { verified: pixelVerified, frames: pixelFrames ?? null },
      pixelVerified
        ? null
        : "Create a Pixel version with complete disclosure evidence.",
    ),
  )
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-vera-"))
  try {
    findings.push(
      ...(await videoChecks({
        video: file.path,
        project,
        pin,
        work,
        commands: options.commands,
        signal: ctx.signal,
      })),
    )
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
  if (ctx.signal.aborted) throw new HandlerAborted("aborted")
  // Check again after decoding so a mid-review file replacement cannot pass.
  if ((await fileDigest(file.path)) !== pin.sha256)
    findings.push(
      finding(
        pin,
        "video.stable-bytes",
        "video_technical",
        "failed",
        "fatal",
        "MP4 bytes remain unchanged throughout QA.",
        { changed: true },
        "Restore the original file and investigate local storage changes.",
      ),
    )
  findings.push(
    finding(
      pin,
      "disclosure.contrast",
      "disclosure",
      "warning",
      "warning",
      "Known white 32 px disclosure uses a 62% black box; human readability remains unverified.",
      {
        templateContrast: "white over black@0.62",
        notEvaluated:
          "Perceived readability, platform overlays, legal sufficiency",
        fadeExclusion:
          "First 250 ms and final 400 ms fade the entire video, including disclosure.",
      },
      "Inspect at actual mobile size; review disclosure visibility during the trusted fades.",
    ),
  )
  findings.push(
    finding(
      pin,
      "platform.checklist",
      "platform_preparation",
      "warning",
      "warning",
      "Later publishing must check current platform commercial-content obligations.",
      {
        checklist: PLATFORM_CHECKLIST,
        platform: inputs.script.document.platform,
        preparation:
          PLATFORM_PREPARATION[
            inputs.script.document.platform as TicketPlatform
          ] ?? PLATFORM_PREPARATION.other,
        accountSettings: "not evaluated or modified",
        policy:
          "Local preparation checklist; not a current legal/platform compliance certification.",
      },
      "Before publishing, verify the platform's current commercial-content settings and any required labels. Burned-in text alone is insufficient to certify compliance.",
    ),
  )
  return finish()
}
