import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  ne,
  or,
  sql,
} from "drizzle-orm"

import {
  assetEndpoint,
  formatTicketNumber,
  TICKET_LIMITS,
  type MediaRights,
  type PublishingPreferences,
  type ReferenceKind,
  type TicketAsset,
  type TicketAssetKind,
  type TicketAssetMimeType,
  type TicketDetail,
  type TicketEvent,
  type TicketEventType,
  type TicketList,
  type TicketPlatform,
  type TicketPriority,
  type TicketProduct,
  type TicketStatus,
  type TicketSummary,
} from "@/lib/tickets/types"
import {
  canTransition,
  likePattern,
  readinessIssues,
  type Issue,
  type ListQuery,
  type NewTicket,
  type ProductFields,
  type ReferenceInput,
  type TicketFields,
} from "@/lib/tickets/validation"
import type { DeskverseDatabase } from "@/server/db/pool"
import {
  affiliateTickets,
  ticketAssets,
  ticketEvents,
  ticketProducts,
  ticketReferences,
} from "@/server/db/schema"
import {
  changedFields,
  event,
  sameValue,
  type NewEvent,
} from "@/server/tickets/events"

/**
 * Affiliate Ticket persistence (DV-004B).
 *
 * Every write runs in one transaction that first locks the ticket row
 * (SELECT … FOR UPDATE). That serialises all changes to one ticket, so
 * product positions, media limits and the version counter stay consistent,
 * and the activity event commits or rolls back with the change it
 * describes. Every content change bumps `version`; a Ready ticket whose
 * content changes returns to Draft, with its own event.
 *
 * Nested lookups always match the full chain (ticket → product → asset),
 * so an ID from one ticket can never reach another ticket's data.
 */

export type TicketErrorCode =
  | "not-found"
  | "conflict"
  | "archived"
  | "not-ready"
  | "invalid-transition"
  | "limit"

export class TicketError extends Error {
  constructor(
    readonly code: TicketErrorCode,
    message: string,
    readonly issues: Issue[] = [],
  ) {
    super(message)
    this.name = "TicketError"
  }
}

type Tx = Parameters<Parameters<DeskverseDatabase["transaction"]>[0]>[0]
type Db = DeskverseDatabase | Tx

type TicketRow = typeof affiliateTickets.$inferSelect
type AssetRow = typeof ticketAssets.$inferSelect

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function summary(row: TicketRow, productCount: number): TicketSummary {
  return {
    id: row.id,
    number: row.number,
    displayNumber: formatTicketNumber(row.number),
    title: row.title,
    status: row.status as TicketStatus,
    priority: row.priority as TicketPriority,
    platform: row.platform as TicketPlatform,
    productCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function assetDto(row: AssetRow): TicketAsset {
  return {
    id: row.id,
    kind: row.kind as TicketAssetKind,
    mimeType: row.mimeType as TicketAssetMimeType,
    sizeBytes: row.byteSize,
    width: row.width,
    height: row.height,
    durationSeconds: row.durationMs === null ? null : row.durationMs / 1000,
    displayName: row.originalName,
    sha256: row.sha256,
    createdAt: row.createdAt.toISOString(),
    url: assetEndpoint(row.ticketId, row.productId, row.id),
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listTickets(
  db: DeskverseDatabase,
  query: ListQuery,
): Promise<TicketList> {
  const t = affiliateTickets
  const status =
    query.status === "all"
      ? undefined
      : query.status === "active"
        ? ne(t.status, "archived")
        : eq(t.status, query.status)
  const search = query.search
    ? or(
        ilike(t.title, likePattern(query.search)),
        query.number !== null ? eq(t.number, query.number) : undefined,
      )
    : undefined
  const where = and(status, search)
  const [{ total }] = await db.select({ total: count() }).from(t).where(where)
  const rows = await db
    .select({
      ticket: t,
      // Fully qualified: an unqualified "id" here would mean ticket_products.id.
      productCount: sql<number>`(SELECT count(*)::int FROM "ticket_products" AS p WHERE p."ticket_id" = "affiliate_tickets"."id")`,
    })
    .from(t)
    .where(where)
    .orderBy(desc(t.updatedAt), desc(t.number))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
  return {
    tickets: rows.map((r) => summary(r.ticket, r.productCount)),
    total,
    page: query.page,
    pageSize: query.pageSize,
  }
}

export async function getTicket(
  db: Db,
  ticketId: string,
): Promise<TicketDetail | null> {
  const [row] = await db
    .select()
    .from(affiliateTickets)
    .where(eq(affiliateTickets.id, ticketId))
  if (!row) return null
  const products = await db
    .select()
    .from(ticketProducts)
    .where(eq(ticketProducts.ticketId, ticketId))
    .orderBy(asc(ticketProducts.position))
  const references = await db
    .select()
    .from(ticketReferences)
    .where(eq(ticketReferences.ticketId, ticketId))
    .orderBy(asc(ticketReferences.position))
  const assets = await db
    .select()
    .from(ticketAssets)
    .where(eq(ticketAssets.ticketId, ticketId))
    .orderBy(asc(ticketAssets.position), asc(ticketAssets.createdAt))
  const productDtos: TicketProduct[] = products.map((p) => ({
    id: p.id,
    position: p.position,
    name: p.name,
    affiliateUrl: p.affiliateUrl,
    description: p.description,
    specifications: p.specifications,
    notes: p.notes,
    source: p.source,
    mediaRights: p.mediaRights as MediaRights,
    mediaRightsNote: p.mediaRightsNote,
    references: references
      .filter((r) => r.productId === p.id)
      .map((r) => ({
        id: r.id,
        kind: r.kind as ReferenceKind,
        url: r.url,
        label: r.label,
      })),
    assets: assets.filter((a) => a.productId === p.id).map(assetDto),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }))
  return {
    ...summary(row, products.length),
    description: row.description,
    instructions: row.instructions,
    publishingPreferences: row.publishingPreferences,
    version: row.version,
    readyAt: row.readyAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    products: productDtos,
  }
}

export async function listEvents(
  db: DeskverseDatabase,
  ticketId: string,
  limit = 200,
): Promise<TicketEvent[]> {
  const rows = await db
    .select()
    .from(ticketEvents)
    .where(eq(ticketEvents.ticketId, ticketId))
    .orderBy(desc(ticketEvents.createdAt), desc(ticketEvents.id))
    .limit(limit)
  return rows.map((r) => ({
    id: r.id,
    type: r.type as TicketEventType,
    productId: r.productId,
    assetId: r.assetId,
    details: r.details,
    createdAt: r.createdAt.toISOString(),
  }))
}

/** One asset, only if it belongs to that product of that ticket. */
export async function findAsset(
  db: DeskverseDatabase,
  ticketId: string,
  productId: string,
  assetId: string,
): Promise<AssetRow | null> {
  const [row] = await db
    .select()
    .from(ticketAssets)
    .where(
      and(
        eq(ticketAssets.id, assetId),
        eq(ticketAssets.productId, productId),
        eq(ticketAssets.ticketId, ticketId),
      ),
    )
  return row ?? null
}

/** Every registered asset (backups and reconciliation). */
export async function allAssets(db: Db): Promise<AssetRow[]> {
  return db.select().from(ticketAssets)
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

async function lockTicket(tx: Tx, ticketId: string): Promise<TicketRow> {
  const [row] = await tx
    .select()
    .from(affiliateTickets)
    .where(eq(affiliateTickets.id, ticketId))
    .for("update")
  if (!row)
    throw new TicketError("not-found", "That Affiliate Ticket doesn't exist.")
  return row
}

function assertEditable(row: TicketRow) {
  if (row.status === "archived")
    throw new TicketError(
      "archived",
      "This ticket is archived. Restore it to Draft to make changes.",
    )
}

function assertVersion(row: TicketRow, version: number) {
  if (row.version !== version)
    throw new TicketError(
      "conflict",
      "This ticket was changed elsewhere (another tab or window). Reload it to see the latest version, then make your change again.",
    )
}

async function addEvents(tx: Tx, ticketId: string, events: NewEvent[]) {
  if (events.length === 0) return
  await tx.insert(ticketEvents).values(
    events.map((e) => ({
      ticketId,
      type: e.type,
      productId: e.productId ?? null,
      assetId: e.assetId ?? null,
      details: e.details ?? {},
    })),
  )
}

/**
 * Records a content change: bumps the version, and a Ready ticket returns
 * to Draft (content changed after it was marked Ready).
 */
async function touchContent(tx: Tx, row: TicketRow, events: NewEvent[]) {
  const revert = row.status === "ready"
  await tx
    .update(affiliateTickets)
    .set({
      version: sql`${affiliateTickets.version} + 1`,
      updatedAt: sql`now()`,
      ...(revert ? { status: "draft", readyAt: null } : {}),
    })
    .where(eq(affiliateTickets.id, row.id))
  await addEvents(
    tx,
    row.id,
    revert ? [...events, event.returnedToDraft("edited")] : events,
  )
}

async function mustGet(tx: Tx, ticketId: string) {
  const ticket = await getTicket(tx, ticketId)
  if (!ticket)
    throw new TicketError("not-found", "That Affiliate Ticket doesn't exist.")
  return ticket
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

/** Creates a ticket; a repeated requestId returns the original instead. */
export async function createTicket(
  db: DeskverseDatabase,
  input: NewTicket,
): Promise<{ ticket: TicketDetail; created: boolean }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(affiliateTickets)
      .values({
        title: input.title,
        description: input.description,
        instructions: input.instructions,
        priority: input.priority,
        platform: input.platform,
        publishingPreferences: input.publishingPreferences,
        createRequestId: input.requestId,
      })
      .onConflictDoNothing({ target: affiliateTickets.createRequestId })
      .returning()
    if (!row) {
      const [existing] = await tx
        .select({ id: affiliateTickets.id })
        .from(affiliateTickets)
        .where(eq(affiliateTickets.createRequestId, input.requestId))
      return { ticket: await mustGet(tx, existing.id), created: false }
    }
    await addEvents(tx, row.id, [event.ticketCreated()])
    return { ticket: await mustGet(tx, row.id), created: true }
  })
}

export async function updateTicket(
  db: DeskverseDatabase,
  ticketId: string,
  version: number,
  patch: Partial<TicketFields>,
): Promise<TicketDetail> {
  return db.transaction(async (tx) => {
    const row = await lockTicket(tx, ticketId)
    assertEditable(row)
    assertVersion(row, version)
    const fields = changedFields(
      row as unknown as Record<string, unknown>,
      patch,
    )
    if (fields.length === 0) return mustGet(tx, ticketId)
    await tx
      .update(affiliateTickets)
      .set(
        patch as Partial<TicketRow> & {
          publishingPreferences?: PublishingPreferences
        },
      )
      .where(eq(affiliateTickets.id, ticketId))
    await touchContent(tx, row, [event.ticketEdited(fields)])
    return mustGet(tx, ticketId)
  })
}

export async function changeStatus(
  db: DeskverseDatabase,
  ticketId: string,
  version: number,
  to: TicketStatus,
): Promise<TicketDetail> {
  return db.transaction(async (tx) => {
    const row = await lockTicket(tx, ticketId)
    assertVersion(row, version)
    const from = row.status as TicketStatus
    if (from === to) return mustGet(tx, ticketId)
    if (!canTransition(from, to))
      throw new TicketError(
        "invalid-transition",
        from === "archived"
          ? "Restore an archived ticket to Draft first."
          : `A ${from} ticket can't become ${to}.`,
      )
    if (to === "ready") {
      const products = await tx
        .select({
          name: ticketProducts.name,
          affiliateUrl: ticketProducts.affiliateUrl,
        })
        .from(ticketProducts)
        .where(eq(ticketProducts.ticketId, ticketId))
      const issues = readinessIssues({ title: row.title, products })
      if (issues.length > 0)
        throw new TicketError(
          "not-ready",
          "This ticket isn't ready yet.",
          issues,
        )
    }
    await tx
      .update(affiliateTickets)
      .set({
        status: to,
        readyAt: to === "ready" ? sql`now()` : null,
        archivedAt: to === "archived" ? sql`now()` : null,
        version: sql`${affiliateTickets.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(affiliateTickets.id, ticketId))
    const record =
      to === "ready"
        ? event.markedReady()
        : to === "archived"
          ? event.archived(from as "draft" | "ready")
          : from === "archived"
            ? event.restored()
            : event.returnedToDraft("owner")
    await addEvents(tx, ticketId, [record])
    return mustGet(tx, ticketId)
  })
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

async function replaceReferences(
  tx: Tx,
  ticketId: string,
  productId: string,
  references: ReferenceInput[],
) {
  await tx
    .delete(ticketReferences)
    .where(
      and(
        eq(ticketReferences.productId, productId),
        eq(ticketReferences.ticketId, ticketId),
      ),
    )
  if (references.length > 0)
    await tx.insert(ticketReferences).values(
      references.map((r, position) => ({
        ticketId,
        productId,
        position,
        kind: r.kind,
        url: r.url,
        label: r.label,
      })),
    )
}

function productColumns(fields: Partial<ProductFields>) {
  // References live in their own table.
  const { references: _references, ...columns } = fields
  void _references
  return columns
}

export async function addProduct(
  db: DeskverseDatabase,
  ticketId: string,
  requestId: string,
  fields: Partial<ProductFields>,
): Promise<{ ticket: TicketDetail; productId: string; created: boolean }> {
  return db.transaction(async (tx) => {
    const row = await lockTicket(tx, ticketId)
    const [existing] = await tx
      .select({ id: ticketProducts.id, ticketId: ticketProducts.ticketId })
      .from(ticketProducts)
      .where(eq(ticketProducts.createRequestId, requestId))
    if (existing) {
      if (existing.ticketId !== ticketId)
        throw new TicketError(
          "conflict",
          "That request was already used for another ticket.",
        )
      return {
        ticket: await mustGet(tx, ticketId),
        productId: existing.id,
        created: false,
      }
    }
    assertEditable(row)
    const [{ n }] = await tx
      .select({ n: count() })
      .from(ticketProducts)
      .where(eq(ticketProducts.ticketId, ticketId))
    if (n >= TICKET_LIMITS.productsPerTicket)
      throw new TicketError(
        "limit",
        `A ticket can hold up to ${TICKET_LIMITS.productsPerTicket} products. Start another ticket for the rest.`,
      )
    const [product] = await tx
      .insert(ticketProducts)
      .values({
        ...productColumns(fields),
        ticketId,
        position: n,
        createRequestId: requestId,
      })
      .returning({ id: ticketProducts.id })
    if (fields.references)
      await replaceReferences(tx, ticketId, product.id, fields.references)
    await touchContent(tx, row, [event.productAdded(product.id, n)])
    return {
      ticket: await mustGet(tx, ticketId),
      productId: product.id,
      created: true,
    }
  })
}

async function lockProduct(tx: Tx, ticketId: string, productId: string) {
  const [product] = await tx
    .select()
    .from(ticketProducts)
    .where(
      and(
        eq(ticketProducts.id, productId),
        eq(ticketProducts.ticketId, ticketId),
      ),
    )
  if (!product)
    throw new TicketError(
      "not-found",
      "That product isn't part of this ticket.",
    )
  return product
}

export async function updateProduct(
  db: DeskverseDatabase,
  ticketId: string,
  productId: string,
  fields: Partial<ProductFields>,
  position?: number,
): Promise<TicketDetail> {
  return db.transaction(async (tx) => {
    const row = await lockTicket(tx, ticketId)
    assertEditable(row)
    const product = await lockProduct(tx, ticketId, productId)
    const events: NewEvent[] = []

    const columns = productColumns(fields)
    const changed = changedFields(
      product as unknown as Record<string, unknown>,
      columns,
    )
    let referenceCounts: { before: number; after: number } | undefined
    if (fields.references) {
      const before = await tx
        .select({
          kind: ticketReferences.kind,
          url: ticketReferences.url,
          label: ticketReferences.label,
        })
        .from(ticketReferences)
        .where(eq(ticketReferences.productId, productId))
        .orderBy(asc(ticketReferences.position))
      if (!sameValue(before, fields.references)) {
        await replaceReferences(tx, ticketId, productId, fields.references)
        changed.push("references")
        referenceCounts = {
          before: before.length,
          after: fields.references.length,
        }
      }
    }
    if (
      Object.keys(columns).length > 0 &&
      changed.some((f) => f !== "references")
    )
      await tx
        .update(ticketProducts)
        .set({ ...columns, updatedAt: sql`now()` })
        .where(eq(ticketProducts.id, productId))
    else if (changed.includes("references"))
      await tx
        .update(ticketProducts)
        .set({ updatedAt: sql`now()` })
        .where(eq(ticketProducts.id, productId))
    if (changed.length > 0)
      events.push(
        event.productUpdated(productId, changed.sort(), referenceCounts),
      )

    if (position !== undefined && position !== product.position) {
      const siblings = await tx
        .select({ id: ticketProducts.id })
        .from(ticketProducts)
        .where(eq(ticketProducts.ticketId, ticketId))
        .orderBy(asc(ticketProducts.position))
      const target = Math.min(Math.max(position, 0), siblings.length - 1)
      if (target !== product.position) {
        const order = siblings.map((s) => s.id).filter((id) => id !== productId)
        order.splice(target, 0, productId)
        await renumber(tx, order)
        events.push(event.productMoved(productId, product.position, target))
      }
    }
    if (events.length > 0) await touchContent(tx, row, events)
    return mustGet(tx, ticketId)
  })
}

async function renumber(tx: Tx, orderedIds: string[]) {
  for (const [position, id] of orderedIds.entries())
    await tx
      .update(ticketProducts)
      .set({ position })
      .where(
        and(eq(ticketProducts.id, id), ne(ticketProducts.position, position)),
      )
}

/** Removes a product (its references and media records cascade). Returns the media files to delete. */
export async function removeProduct(
  db: DeskverseDatabase,
  ticketId: string,
  productId: string,
): Promise<{ ticket: TicketDetail; removedAssets: AssetRow[] }> {
  return db.transaction(async (tx) => {
    const row = await lockTicket(tx, ticketId)
    assertEditable(row)
    await lockProduct(tx, ticketId, productId)
    const removedAssets = await tx
      .select()
      .from(ticketAssets)
      .where(
        and(
          eq(ticketAssets.productId, productId),
          eq(ticketAssets.ticketId, ticketId),
        ),
      )
    await tx
      .delete(ticketProducts)
      .where(
        and(
          eq(ticketProducts.id, productId),
          eq(ticketProducts.ticketId, ticketId),
        ),
      )
    const rest = await tx
      .select({ id: ticketProducts.id })
      .from(ticketProducts)
      .where(eq(ticketProducts.ticketId, ticketId))
      .orderBy(asc(ticketProducts.position))
    await renumber(
      tx,
      rest.map((r) => r.id),
    )
    await touchContent(tx, row, [
      event.productRemoved(productId, removedAssets.length),
    ])
    return { ticket: await mustGet(tx, ticketId), removedAssets }
  })
}

// ---------------------------------------------------------------------------
// Assets (the file is already in place; see media.ts)
// ---------------------------------------------------------------------------

export interface NewAssetRecord {
  id: string
  kind: TicketAssetKind
  mimeType: TicketAssetMimeType
  extension: string
  byteSize: number
  sha256: string
  width: number
  height: number
  durationMs: number | null
  originalName: string
}

export interface AssetLimits {
  imagesPerProduct: number
  videosPerProduct: number
  maxTicketBytes: number
}

/**
 * Checks ownership and limits under the ticket lock, then records the asset.
 * Throws (and records nothing) if any check fails.
 */
export async function recordAsset(
  db: DeskverseDatabase,
  ticketId: string,
  productId: string,
  asset: NewAssetRecord,
  limits: AssetLimits,
): Promise<TicketAsset> {
  return db.transaction(async (tx) => {
    const row = await lockTicket(tx, ticketId)
    assertEditable(row)
    await lockProduct(tx, ticketId, productId)
    const existing = await tx
      .select({ kind: ticketAssets.kind, position: ticketAssets.position })
      .from(ticketAssets)
      .where(eq(ticketAssets.productId, productId))
    const sameKind = existing.filter((a) => a.kind === asset.kind).length
    const max =
      asset.kind === "image" ? limits.imagesPerProduct : limits.videosPerProduct
    if (sameKind >= max)
      throw new TicketError(
        "limit",
        `A product can have up to ${max} ${asset.kind === "image" ? "images" : "video clips"}. Remove one first.`,
      )
    const [{ bytes }] = await tx
      .select({
        bytes: sql<number>`coalesce(sum(${ticketAssets.byteSize}), 0)::bigint`,
      })
      .from(ticketAssets)
      .where(eq(ticketAssets.ticketId, ticketId))
    if (Number(bytes) + asset.byteSize > limits.maxTicketBytes)
      throw new TicketError(
        "limit",
        "This ticket's media would exceed its storage limit. Remove some files first.",
      )
    const position = existing.reduce((m, a) => Math.max(m, a.position + 1), 0)
    const [inserted] = await tx
      .insert(ticketAssets)
      .values({ ...asset, ticketId, productId, position })
      .returning()
    await touchContent(tx, row, [
      event.assetUploaded(productId, asset.id, asset.kind, asset.byteSize),
    ])
    return assetDto(inserted)
  })
}

/** Removes the record; the caller deletes the file after this commits. */
export async function removeAssetRecord(
  db: DeskverseDatabase,
  ticketId: string,
  productId: string,
  assetId: string,
): Promise<AssetRow> {
  return db.transaction(async (tx) => {
    const row = await lockTicket(tx, ticketId)
    assertEditable(row)
    await lockProduct(tx, ticketId, productId)
    const [removed] = await tx
      .delete(ticketAssets)
      .where(
        and(
          eq(ticketAssets.id, assetId),
          eq(ticketAssets.productId, productId),
          eq(ticketAssets.ticketId, ticketId),
        ),
      )
      .returning()
    if (!removed)
      throw new TicketError(
        "not-found",
        "That file isn't attached to this product.",
      )
    await touchContent(tx, row, [
      event.assetRemoved(productId, assetId, removed.kind as TicketAssetKind),
    ])
    return removed
  })
}

/** Which of these asset IDs exist (reconciliation). */
export async function existingAssetIds(db: Db, ids: string[]) {
  if (ids.length === 0) return new Set<string>()
  const rows = await db
    .select({ id: ticketAssets.id })
    .from(ticketAssets)
    .where(inArray(ticketAssets.id, ids))
  return new Set(rows.map((r) => r.id))
}
