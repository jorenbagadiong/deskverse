import type { TicketEventType } from "@/lib/tickets/types"

/**
 * Activity events (DV-004B). Pure. Details are deliberately small and
 * non-sensitive: field names, statuses, counts and media kinds. Never URLs,
 * file names, paths or free text the owner typed.
 */

export interface NewEvent {
  type: TicketEventType
  productId?: string | null
  assetId?: string | null
  details?: Record<string, unknown>
}

/** Field names only, sorted, so "what changed" is visible without the values. */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): string[] {
  return Object.keys(after)
    .filter((key) => !sameValue(before[key], after[key]))
    .sort()
}

/** Deep equality with object keys sorted (jsonb reorders keys). */
export function sameValue(a: unknown, b: unknown) {
  return stable(a) === stable(b)
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object" && !(value instanceof Date))
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`
  return JSON.stringify(value)
}

export const event = {
  ticketCreated: (): NewEvent => ({ type: "ticket_created" }),
  ticketEdited: (fields: string[]): NewEvent => ({
    type: "ticket_edited",
    details: { fields },
  }),
  productAdded: (productId: string, position: number): NewEvent => ({
    type: "product_added",
    productId,
    details: { position: position + 1 },
  }),
  productUpdated: (
    productId: string,
    fields: string[],
    references?: { before: number; after: number },
  ): NewEvent => ({
    type: "product_updated",
    productId,
    details: references ? { fields, references } : { fields },
  }),
  productMoved: (productId: string, from: number, to: number): NewEvent => ({
    type: "product_moved",
    productId,
    details: { from: from + 1, to: to + 1 },
  }),
  productRemoved: (productId: string, assets: number): NewEvent => ({
    type: "product_removed",
    productId,
    details: { assets },
  }),
  assetUploaded: (
    productId: string,
    assetId: string,
    kind: "image" | "video",
    bytes: number,
  ): NewEvent => ({
    type: "asset_uploaded",
    productId,
    assetId,
    details: { kind, bytes },
  }),
  assetRemoved: (
    productId: string,
    assetId: string,
    kind: "image" | "video",
  ): NewEvent => ({
    type: "asset_removed",
    productId,
    assetId,
    details: { kind },
  }),
  markedReady: (): NewEvent => ({ type: "marked_ready" }),
  returnedToDraft: (reason: "owner" | "edited"): NewEvent => ({
    type: "returned_to_draft",
    details: { reason },
  }),
  archived: (from: "draft" | "ready"): NewEvent => ({
    type: "archived",
    details: { from },
  }),
  restored: (): NewEvent => ({ type: "restored" }),
}
