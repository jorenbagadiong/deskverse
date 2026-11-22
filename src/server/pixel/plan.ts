import type pg from "pg"

import { RENDER_CONFIG } from "@/lib/pixel/types"
import { MEDIA_LIMITS } from "@/lib/video/validation"
import { canonicalJson, sha256 } from "@/server/orchestrator/canonical"
import { OrchestratorError, type PlanInput } from "@/server/orchestrator/store"
import { getScript } from "@/server/quill/store"
import { verifyScoutReport } from "@/server/scout/store"

/**
 * Planning a Pixel video run (DV-005C): validates the owner's choices in
 * the planning transaction and pins an immutable render manifest per
 * product. Everything is checked against current trusted records:
 * - the Quill script belongs to this ticket and product, its checksum
 *   recomputes, its Pixel text is compatible, and its Scout report still
 *   verifies with the pinned checksum and version;
 * - the product's frozen input is IDENTICAL to the one the script was
 *   written from (Quill's conservative rule: any change, including new
 *   images, needs new research and a new script);
 * - 3–6 distinct still images (JPEG/PNG/WebP) from that frozen input, each
 *   still a current record of this product with the same SHA-256;
 * - media rights: if "unspecified", the owner must explicitly confirm.
 */

export interface RenderSelection {
  productId: string
  scriptId: string
  assetIds: string[]
  rightsAcknowledged?: boolean
}

export interface RenderManifest {
  ticketId: string
  productId: string
  script: { id: string; version: number; checksum: string; runId: string }
  report: { id: string; version: number; checksum: string }
  snapshotChecksum: string
  assets: { id: string; sha256: string }[]
  rightsAcknowledged: boolean
  renderConfig: typeof RENDER_CONFIG
}

export const manifestChecksum = (m: RenderManifest) => sha256(canonicalJson(m))

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const STALE_STEPS =
  "To use new or changed images or details: mark the updated ticket Ready, run Scout again, write a new Quill script from the new research, then start Pixel with that script."

export function pixelPlanHooks(
  ticketId: string,
  selections: readonly RenderSelection[],
): Pick<PlanInput, "prepare" | "onTask"> {
  const manifests = new Map<string, RenderManifest>()
  return {
    async prepare(c, snapshots) {
      if (selections.length === 0)
        throw new OrchestratorError(
          "invalid",
          "Choose a script and images for at least one product.",
        )
      const params = new Map<string, Record<string, unknown>>()
      for (const s of selections) {
        const target = snapshots.find((x) => x.product.id === s.productId)
        if (!target)
          throw new OrchestratorError(
            "not-found",
            "One of the chosen products isn't part of this ticket.",
          )
        if (params.has(s.productId))
          throw new OrchestratorError(
            "invalid",
            "Choose one script per product.",
          )
        const name =
          String(target.product.name ?? "") ||
          `Product #${target.product.position + 1}`
        const row = (
          await c.query(
            "SELECT run_id FROM quill_scripts WHERE id = $1 AND ticket_id = $2 AND product_id = $3",
            [s.scriptId, ticketId, s.productId],
          )
        ).rows[0]
        if (!row)
          throw new OrchestratorError(
            "not-found",
            `That script isn't one of “${name}”'s scripts.`,
          )
        const script = await getScript(c, ticketId, row.run_id, s.scriptId)
        if (!script || script.integrity !== "verified")
          throw new OrchestratorError(
            "invalid",
            `“${name}”'s script fails its checksum check, so Pixel won't render it.`,
          )
        const doc = script.document
        if (!doc.pixel.textCompatible)
          throw new OrchestratorError(
            "invalid",
            `“${name}”'s script doesn't fit Pixel's text limits (${doc.pixel.textIssues.join(" ")}). Nothing is cut automatically: shorten the product name, then write a new script.`,
          )
        const report = await verifyScoutReport(c, doc.report.id)
        if (
          !report?.intact ||
          report.checksum !== doc.report.checksum ||
          report.reportVersion !== doc.report.version
        )
          throw new OrchestratorError(
            "invalid",
            `“${name}”'s script refers to research that no longer verifies. Run Scout and Quill again.`,
          )
        if (target.checksum !== doc.snapshotChecksum)
          throw new OrchestratorError(
            "stale-research",
            `“${name}” has changed since this script was written (script version ${script.scriptVersion}). ${STALE_STEPS}`,
          )
        // Images: from the script's own frozen input, still current, distinct.
        const ids = s.assetIds
        if (
          !Array.isArray(ids) ||
          ids.length < MEDIA_LIMITS.minCount ||
          ids.length > MEDIA_LIMITS.maxCount
        )
          throw new OrchestratorError(
            "invalid",
            `Choose ${MEDIA_LIMITS.minCount}–${MEDIA_LIMITS.maxCount} images for “${name}”.`,
          )
        if (
          new Set(ids).size !== ids.length ||
          ids.some((id) => !UUID.test(id))
        )
          throw new OrchestratorError(
            "invalid",
            `Each image can be chosen once for “${name}”.`,
          )
        const frozen =
          (
            target.data.product as {
              assets?: {
                id: string
                kind: string
                mimeType: string
                sha256: string
              }[]
            }
          ).assets ?? []
        const assets: { id: string; sha256: string }[] = []
        for (const id of ids) {
          const a = frozen.find((x) => x.id === id)
          if (!a || a.kind !== "image" || !IMAGE_TYPES.has(a.mimeType))
            throw new OrchestratorError(
              "invalid",
              `An image chosen for “${name}” isn't one of the still images this script's input included. ${STALE_STEPS}`,
            )
          const current = (
            await c.query(
              "SELECT sha256 FROM ticket_assets WHERE id = $1 AND ticket_id = $2 AND product_id = $3 AND kind = 'image'",
              [id, ticketId, s.productId],
            )
          ).rows[0]
          if (!current || current.sha256 !== a.sha256)
            throw new OrchestratorError(
              "invalid",
              `An image chosen for “${name}” was removed or changed. ${STALE_STEPS}`,
            )
          assets.push({ id, sha256: a.sha256 })
        }
        const rights = String(
          (target.data.product as { mediaRights?: string }).mediaRights ??
            "unspecified",
        )
        if (rights === "unspecified" && s.rightsAcknowledged !== true)
          throw new OrchestratorError(
            "invalid",
            `“${name}”'s media rights are unspecified. Confirm you may use these images (or set the product's media rights, then research and write it again).`,
          )
        const manifest: RenderManifest = {
          ticketId,
          productId: s.productId,
          script: {
            id: script.id,
            version: script.scriptVersion,
            checksum: script.checksum,
            runId: script.runId,
          },
          report: {
            id: doc.report.id,
            version: doc.report.version,
            checksum: doc.report.checksum,
          },
          snapshotChecksum: target.checksum,
          assets,
          rightsAcknowledged: s.rightsAcknowledged === true,
          renderConfig: RENDER_CONFIG,
        }
        manifests.set(s.productId, manifest)
        params.set(s.productId, {
          manifestChecksum: manifestChecksum(manifest),
        })
      }
      return params
    },
    async onTask(c: pg.PoolClient, task) {
      const m = manifests.get(task.productId)
      if (!m) throw new Error("no manifest for this product")
      await c.query(
        `INSERT INTO pixel_render_jobs (run_id, ticket_id, task_id, snapshot_id, product_id, script_id, script_version, script_checksum,
                                        report_id, report_version, report_checksum, snapshot_checksum, asset_ids, asset_sha256,
                                        rights_acknowledged, render_config, manifest_checksum)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          task.runId,
          m.ticketId,
          task.taskId,
          task.snapshotId,
          m.productId,
          m.script.id,
          m.script.version,
          m.script.checksum,
          m.report.id,
          m.report.version,
          m.report.checksum,
          m.snapshotChecksum,
          m.assets.map((a) => a.id),
          m.assets.map((a) => a.sha256),
          m.rightsAcknowledged,
          m.renderConfig,
          manifestChecksum(m),
        ],
      )
    },
  }
}

/** The manifest as stored, for re-verification at render time. */
export function manifestFromRow(
  r: Record<string, unknown>,
  scriptRunId: string,
): RenderManifest {
  return {
    ticketId: r.ticket_id as string,
    productId: r.product_id as string,
    script: {
      id: r.script_id as string,
      version: r.script_version as number,
      checksum: r.script_checksum as string,
      runId: scriptRunId,
    },
    report: {
      id: r.report_id as string,
      version: r.report_version as number,
      checksum: r.report_checksum as string,
    },
    snapshotChecksum: r.snapshot_checksum as string,
    assets: (r.asset_ids as string[]).map((id, i) => ({
      id,
      sha256: (r.asset_sha256 as string[])[i],
    })),
    rightsAcknowledged: r.rights_acknowledged as boolean,
    renderConfig: r.render_config as typeof RENDER_CONFIG,
  }
}
