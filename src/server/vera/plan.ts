import { VERA_RULESET } from "@/lib/vera/types"
import { OrchestratorError, type PlanInput } from "@/server/orchestrator/store"
import { ticketRenderStorage } from "@/server/pixel/store"
import { resolveDataRoot } from "@/server/video/storage"
import { loadInputs, LineageError } from "./inputs"
import { fileDigest } from "./video"

export interface ReviewSelection {
  productId: string
  deliverableId: string
}
export function veraPlanHooks(
  ticketId: string,
  selections: readonly ReviewSelection[],
  dataRoot = resolveDataRoot(),
): Pick<PlanInput, "prepare"> {
  return {
    async prepare(c, snapshots) {
      if (!selections.length || selections.length > 100)
        throw new OrchestratorError(
          "invalid",
          "Choose 1–100 completed Pixel videos.",
        )
      const params = new Map<string, Record<string, unknown>>()
      for (const s of selections) {
        if (
          params.has(s.productId) ||
          !snapshots.some((x) => x.product.id === s.productId)
        )
          throw new OrchestratorError(
            "invalid",
            "Choose one video per product from this ticket.",
          )
        let inputs
        try {
          inputs = await loadInputs(c, ticketId, s.deliverableId)
        } catch (e) {
          if (e instanceof LineageError)
            throw new OrchestratorError("invalid", e.message)
          throw e
        }
        if (inputs.pin.productId !== s.productId)
          throw new OrchestratorError(
            "invalid",
            "The video belongs to another product.",
          )
        const file = await ticketRenderStorage(dataRoot)
          .resolveCompletedOutput(inputs.deliverable.pixel_job_id)
          .catch(() => null)
        if (
          !file ||
          file.sizeBytes !== inputs.pin.byteSize ||
          (await fileDigest(file.path)) !== inputs.pin.sha256
        )
          throw new OrchestratorError(
            "invalid",
            "The pinned MP4 is missing or its bytes changed. Restore the original or render a new Pixel version.",
          )
        params.set(s.productId, { veraPin: inputs.pin, ruleset: VERA_RULESET })
      }
      return params
    },
  }
}
