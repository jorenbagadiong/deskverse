import type { CampaignSelection } from "@/lib/orchestrator/types"
import { isUuid } from "@/lib/tickets/validation"
import { openAssetFile } from "@/server/tickets/media"
import { fileDigest } from "@/server/vera/video"
import {
  canonicalJson,
  sha256,
  type Queryable,
} from "@/server/orchestrator/canonical"
import { OrchestratorError } from "@/server/orchestrator/store"
import { checkSourceUrl, sameDestination } from "@/server/scout/net/url"

interface FrozenAsset {
  id: string
  kind: string
  mimeType: string
  extension: string
  byteSize: number
  sha256: string
}

export function parseCampaignSelections(value: unknown): CampaignSelection[] {
  const invalid = () =>
    new OrchestratorError(
      "invalid",
      "Select each product once, choose 3–6 distinct images in order, and confirm media use for each product.",
    )
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    throw invalid()
  const products = new Set<string>()
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw invalid()
    const { productId, assetIds, rightsAcknowledged, ...extra } =
      item as Record<string, unknown>
    if (
      Object.keys(extra).length ||
      typeof productId !== "string" ||
      !isUuid(productId) ||
      rightsAcknowledged !== true ||
      !Array.isArray(assetIds) ||
      assetIds.length < 3 ||
      assetIds.length > 6 ||
      assetIds.some((id: unknown) => typeof id !== "string" || !isUuid(id))
    )
      throw invalid()
    const id = productId.toLowerCase()
    const images = (assetIds as string[]).map((asset) => asset.toLowerCase())
    if (products.has(id) || new Set(images).size !== images.length)
      throw invalid()
    products.add(id)
    return { productId: id, assetIds: images, rightsAcknowledged: true }
  })
}

export function checksumSelection(
  snapshotChecksum: string,
  selection: CampaignSelection,
) {
  return sha256(canonicalJson({ snapshotChecksum, selection }))
}

export function eligibleImage(
  asset: FrozenAsset | undefined,
): asset is FrozenAsset {
  return Boolean(
    asset?.kind === "image" &&
    ["image/jpeg", "image/png", "image/webp"].includes(asset.mimeType) &&
    /^[0-9a-f]{64}$/.test(asset.sha256),
  )
}

export async function verifyCampaignMedia(
  db: Queryable,
  ticketId: string,
  selections: CampaignSelection[],
  dataRoot: string,
) {
  const verified = new Map<string, string>()
  const rows = (
    await db.query(
      "SELECT id, product_id, kind, mime_type, extension, byte_size, sha256 FROM ticket_assets WHERE ticket_id = $1 AND id = ANY($2::uuid[])",
      [ticketId, selections.flatMap((selection) => selection.assetIds)],
    )
  ).rows
  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const selection of selections) {
    for (const id of selection.assetIds) {
      const row = byId.get(id)
      if (
        !row ||
        row.product_id !== selection.productId ||
        !eligibleImage({
          id,
          kind: row.kind,
          mimeType: row.mime_type,
          extension: row.extension,
          byteSize: Number(row.byte_size),
          sha256: row.sha256,
        })
      )
        throw new OrchestratorError(
          "invalid",
          "Each selected still image must belong to its own product on this ticket.",
        )
      try {
        const { file } = await openAssetFile(dataRoot, {
          ticketId,
          id,
          extension: row.extension,
          byteSize: Number(row.byte_size),
        })
        if ((await fileDigest(file)) !== row.sha256)
          throw new Error("checksum mismatch")
      } catch {
        throw new OrchestratorError(
          "invalid",
          "A selected image is missing, unsafe, or has changed. Upload it again and review your selection.",
        )
      }
      verified.set(id, row.sha256)
    }
  }
  return verified
}

export function validateFrozenSelection(
  selection: CampaignSelection,
  product: {
    name: unknown
    affiliateUrl: unknown
    references: { url: string }[]
    assets: FrozenAsset[]
  },
  verified: Map<string, string>,
) {
  if (
    !String(product.name ?? "").trim() ||
    !product.references.some(
      (source) =>
        checkSourceUrl(source.url).ok &&
        !sameDestination(source.url, String(product.affiliateUrl ?? "")),
    )
  )
    throw new OrchestratorError(
      "not-ready",
      "Every selected product needs a name and a research reference besides its affiliate link.",
    )
  for (const id of selection.assetIds) {
    const asset = product.assets.find((image) => image.id === id)
    if (!eligibleImage(asset) || verified.get(id) !== asset.sha256)
      throw new OrchestratorError(
        "stale-version",
        "A selected image changed while the campaign was being prepared. Reload and review your selection.",
      )
  }
}
