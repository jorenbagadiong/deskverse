import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { TICKET_LIMITS } from "@/lib/tickets/types"
import {
  parseListQuery,
  validateNewTicket,
  type NewTicket,
} from "@/lib/tickets/validation"
import { journal } from "@/server/db/journal"
import { migrationsFolder, runMigrations } from "@/server/db/migrations"
import {
  createDatabase,
  createPool,
  type DeskverseDatabase,
} from "@/server/db/pool"
import {
  addProduct,
  changeStatus,
  createTicket,
  getTicket,
  listEvents,
  listTickets,
  recordAsset,
  removeAssetRecord,
  removeProduct,
  TicketError,
  updateProduct,
  updateTicket,
} from "@/server/tickets/repository"
import { classifyDatabaseError } from "@/server/db/errors"

import { createScratchDatabase, type ScratchDatabase } from "./helpers"

/** DV-004B: Affiliate Ticket persistence on a guarded scratch database. */

let scratch: ScratchDatabase
let pool: ReturnType<typeof createPool>
let db: DeskverseDatabase

beforeAll(async () => {
  scratch = await createScratchDatabase("tickets")
  pool = createPool(scratch.config, { max: 10 })
  await runMigrations(pool, journal, migrationsFolder())
  db = createDatabase(pool)
})
afterAll(async () => {
  await pool?.end()
  await scratch?.drop()
})

function newTicket(title: string, extra: Partial<NewTicket> = {}): NewTicket {
  const result = validateNewTicket({ title, requestId: randomUUID(), ...extra })
  if (!result.ok) throw new Error(JSON.stringify(result.issues))
  return result.value
}

const query = (params: Record<string, string> = {}) => {
  const result = parseListQuery(new URLSearchParams(params))
  if (!result.ok) throw new Error("bad query")
  return result.value
}

async function expectTicketError(
  promise: Promise<unknown>,
  code: TicketError["code"],
) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(TicketError)
  expect((error as TicketError).code).toBe(code)
  return error as TicketError
}

const newImage = (
  overrides: Partial<Parameters<typeof recordAsset>[3]> = {},
) => ({
  id: randomUUID(),
  kind: "image" as const,
  mimeType: "image/png" as const,
  extension: "png",
  byteSize: 1000,
  sha256: "a".repeat(64),
  width: 800,
  height: 800,
  durationMs: null,
  originalName: "photo.png",
  ...overrides,
})

const LIMITS = {
  imagesPerProduct: 2,
  videosPerProduct: 1,
  maxTicketBytes: 10_000,
}

describe("Affiliate Tickets", () => {
  it("creates a ticket with a number, defaults and a created event", async () => {
    const { ticket, created } = await createTicket(
      db,
      newTicket("  November   campaign ", {
        description: "Ten products\r\n\r\n\r\nfor TikTok",
        platform: "youtube_shorts",
        priority: "high",
        publishingPreferences: { schedule: "One a day", notes: "" },
      }),
    )
    expect(created).toBe(true)
    expect(ticket).toMatchObject({
      title: "November campaign",
      description: "Ten products\n\nfor TikTok",
      status: "draft",
      priority: "high",
      platform: "youtube_shorts",
      version: 1,
      productCount: 0,
      products: [],
      publishingPreferences: { schedule: "One a day", notes: "" },
    })
    expect(ticket.displayNumber).toMatch(/^AFT-\d{4,}$/)
    expect(ticket.id).toMatch(/^[0-9a-f-]{36}$/)
    const events = await listEvents(db, ticket.id)
    expect(events.map((e) => e.type)).toEqual(["ticket_created"])
  })

  it("returns the same ticket for a repeated submission", async () => {
    const input = newTicket("Duplicate click")
    const first = await createTicket(db, input)
    const second = await createTicket(db, input)
    expect(second.created).toBe(false)
    expect(second.ticket.id).toBe(first.ticket.id)
    expect((await listEvents(db, first.ticket.id)).length).toBe(1)
  })

  it("allocates unique numbers under concurrent creation", async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        createTicket(db, newTicket(`Parallel ${i}`)),
      ),
    )
    const numbers = results.map((r) => r.ticket.number)
    expect(new Set(numbers).size).toBe(25)
    expect(new Set(results.map((r) => r.ticket.displayNumber)).size).toBe(25)
  })

  it("enforces critical rules in the database itself", async () => {
    const errors = await Promise.all([
      pool
        .query("INSERT INTO affiliate_tickets (title) VALUES ('x')")
        .catch((e) => e),
      pool
        .query(
          "INSERT INTO affiliate_tickets (title, status) VALUES ('Valid title', 'processing')",
        )
        .catch((e) => e),
      pool
        .query(
          "INSERT INTO affiliate_tickets (title, number) VALUES ('Valid title', 999999)",
        )
        .catch((e) => e),
      pool
        .query(
          "INSERT INTO ticket_products (ticket_id, position) VALUES ($1, 0)",
          [randomUUID()],
        )
        .catch((e) => e),
    ])
    expect(errors.map((e) => e.code)).toEqual([
      "23514",
      "23514",
      "428C9",
      "23503",
    ])
  })

  it("holds many products, with references, in order", async () => {
    const { ticket } = await createTicket(db, newTicket("Ten products"))
    let detail = ticket
    for (let i = 0; i < 12; i++) {
      const result = await addProduct(db, ticket.id, randomUUID(), {
        name: `Product ${i + 1}`,
        affiliateUrl: `https://shop.example.com/p/${i + 1}?tag=me-20`,
        references:
          i === 0
            ? [
                {
                  kind: "listing",
                  url: "https://shop.example.com/p/1",
                  label: "Listing",
                },
                {
                  kind: "review",
                  url: "https://reviews.example.org/p1",
                  label: "",
                },
              ]
            : [],
      })
      detail = result.ticket
    }
    expect(detail.products.map((p) => p.name)).toEqual(
      Array.from({ length: 12 }, (_, i) => `Product ${i + 1}`),
    )
    expect(detail.products.map((p) => p.position)).toEqual([
      ...Array(12).keys(),
    ])
    expect(detail.products[0].references.map((r) => r.kind)).toEqual([
      "listing",
      "review",
    ])
    expect(detail.version).toBe(13)

    // Move product 12 to the top; positions stay dense.
    const moved = await updateProduct(
      db,
      ticket.id,
      detail.products[11].id,
      {},
      0,
    )
    expect(moved.products[0].name).toBe("Product 12")
    expect(moved.products.map((p) => p.position)).toEqual([...Array(12).keys()])

    // Remove one; the rest close the gap.
    const removed = await removeProduct(db, ticket.id, moved.products[5].id)
    expect(removed.ticket.products).toHaveLength(11)
    expect(removed.ticket.products.map((p) => p.position)).toEqual([
      ...Array(11).keys(),
    ])

    const list = await listTickets(db, query({ q: "Ten products" }))
    expect(list.tickets[0]).toMatchObject({
      title: "Ten products",
      productCount: 11,
    })
  })

  it("replaces references, refuses duplicate links, and records only what changed", async () => {
    const { ticket } = await createTicket(db, newTicket("References"))
    const { productId } = await addProduct(db, ticket.id, randomUUID(), {
      name: "Lamp",
    })
    await updateProduct(db, ticket.id, productId, {
      references: [
        {
          kind: "manufacturer",
          url: "https://maker.example.com/lamp",
          label: "Specs",
        },
      ],
    })
    const unchanged = await updateProduct(db, ticket.id, productId, {
      name: "Lamp",
      references: [
        {
          kind: "manufacturer",
          url: "https://maker.example.com/lamp",
          label: "Specs",
        },
      ],
    })
    const events = await listEvents(db, ticket.id)
    const updates = events.filter((e) => e.type === "product_updated")
    expect(updates).toHaveLength(1)
    expect(updates[0].details).toEqual({
      fields: ["references"],
      references: { before: 0, after: 1 },
    })
    expect(JSON.stringify(events)).not.toContain("maker.example.com")
    expect(unchanged.version).toBe(3)

    const duplicate = await pool
      .query(
        "INSERT INTO ticket_references (ticket_id, product_id, position, kind, url) VALUES ($1, $2, 1, 'other', 'https://maker.example.com/lamp')",
        [ticket.id, productId],
      )
      .catch((e) => e)
    expect(duplicate.code).toBe("23505")
  })

  it("rolls a failed write back completely (no product, no event, same version)", async () => {
    const { ticket } = await createTicket(db, newTicket("Rollback"))
    const before = await listEvents(db, ticket.id)
    const error = await addProduct(db, ticket.id, randomUUID(), {
      name: "x".repeat(121), // passes no validator; the database check refuses it
    }).catch((e) => e)
    expect(error.cause?.code ?? error.code).toBe("23514")
    const after = await getTicket(db, ticket.id)
    expect(after!.products).toEqual([])
    expect(after!.version).toBe(1)
    expect(await listEvents(db, ticket.id)).toEqual(before)
  })

  it("refuses stale versions (another tab) with a conflict", async () => {
    const { ticket } = await createTicket(db, newTicket("Two tabs"))
    await updateTicket(db, ticket.id, 1, { description: "first" })
    await expectTicketError(
      updateTicket(db, ticket.id, 1, { description: "second" }),
      "conflict",
    )
    expect((await getTicket(db, ticket.id))!.description).toBe("first")
  })

  it("marks Ready only when a product has a name and affiliate link; edits return it to Draft", async () => {
    const { ticket } = await createTicket(db, newTicket("Lifecycle"))
    const notReady = await expectTicketError(
      changeStatus(db, ticket.id, 1, "ready"),
      "not-ready",
    )
    expect(notReady.issues[0].message).toBe("Add at least one product.")

    const added = await addProduct(db, ticket.id, randomUUID(), { name: "Mug" })
    const stillNot = await expectTicketError(
      changeStatus(db, ticket.id, added.ticket.version, "ready"),
      "not-ready",
    )
    expect(stillNot.issues[0].message).toMatch(
      /needs a name and a valid affiliate link/,
    )

    const linked = await updateProduct(db, ticket.id, added.productId, {
      affiliateUrl: "https://shop.example.com/mug",
    })
    const ready = await changeStatus(db, ticket.id, linked.version, "ready")
    expect(ready.status).toBe("ready")
    expect(ready.readyAt).not.toBeNull()

    // Any content change returns it to Draft, with its own event.
    const edited = await updateProduct(db, ticket.id, added.productId, {
      notes: "Blue",
    })
    expect(edited.status).toBe("draft")
    expect(edited.readyAt).toBeNull()
    const types = (await listEvents(db, ticket.id)).map((e) => e.type)
    // Newest first; both new events share one transaction.
    expect(types.slice(0, 3)).toEqual([
      "returned_to_draft",
      "product_updated",
      "marked_ready",
    ])
    const back = (await listEvents(db, ticket.id)).find(
      (e) => e.type === "returned_to_draft",
    )
    expect(back!.details).toEqual({ reason: "edited" })
  })

  it("archives (read-only) and restores to Draft", async () => {
    const { ticket } = await createTicket(db, newTicket("Archive me"))
    const { ticket: withProduct, productId } = await addProduct(
      db,
      ticket.id,
      randomUUID(),
      {
        name: "Thing",
      },
    )
    const archived = await changeStatus(
      db,
      ticket.id,
      withProduct.version,
      "archived",
    )
    expect(archived).toMatchObject({ status: "archived" })
    expect(archived.archivedAt).not.toBeNull()
    await expectTicketError(
      updateTicket(db, ticket.id, archived.version, { title: "New" }),
      "archived",
    )
    await expectTicketError(
      addProduct(db, ticket.id, randomUUID(), {}),
      "archived",
    )
    await expectTicketError(
      updateProduct(db, ticket.id, productId, { name: "x" }),
      "archived",
    )
    await expectTicketError(removeProduct(db, ticket.id, productId), "archived")
    await expectTicketError(
      changeStatus(db, ticket.id, archived.version, "ready"),
      "invalid-transition",
    )
    // Still readable, hidden from the default (active) list.
    expect((await getTicket(db, ticket.id))!.products).toHaveLength(1)
    const active = await listTickets(db, query({ q: "Archive me" }))
    expect(active.total).toBe(0)
    const archivedList = await listTickets(
      db,
      query({ q: "Archive me", status: "archived" }),
    )
    expect(archivedList.total).toBe(1)

    const restored = await changeStatus(
      db,
      ticket.id,
      archived.version,
      "draft",
    )
    expect(restored).toMatchObject({ status: "draft", archivedAt: null })
    const types = (await listEvents(db, ticket.id)).map((e) => e.type)
    expect(types.slice(0, 2)).toEqual(["restored", "archived"])
  })

  it("never lets one ticket reach another ticket's products or media", async () => {
    const a = await createTicket(db, newTicket("Ticket A"))
    const b = await createTicket(db, newTicket("Ticket B"))
    const pa = await addProduct(db, a.ticket.id, randomUUID(), { name: "A1" })
    const asset = await recordAsset(
      db,
      a.ticket.id,
      pa.productId,
      newImage(),
      LIMITS,
    )

    await expectTicketError(
      updateProduct(db, b.ticket.id, pa.productId, { name: "hijack" }),
      "not-found",
    )
    await expectTicketError(
      removeProduct(db, b.ticket.id, pa.productId),
      "not-found",
    )
    await expectTicketError(
      recordAsset(db, b.ticket.id, pa.productId, newImage(), LIMITS),
      "not-found",
    )
    await expectTicketError(
      removeAssetRecord(db, b.ticket.id, pa.productId, asset.id),
      "not-found",
    )
    // Even with B's real product, A's asset can't be removed through it.
    const pb = await addProduct(db, b.ticket.id, randomUUID(), { name: "B1" })
    await expectTicketError(
      removeAssetRecord(db, b.ticket.id, pb.productId, asset.id),
      "not-found",
    )
    // The database refuses a reference or asset whose ticket differs from its product's.
    const crossed = await pool
      .query(
        "INSERT INTO ticket_references (ticket_id, product_id, position, kind, url) VALUES ($1, $2, 0, 'other', 'https://x.example.com')",
        [b.ticket.id, pa.productId],
      )
      .catch((e) => e)
    expect(crossed.code).toBe("23503")
    expect((await getTicket(db, a.ticket.id))!.products[0]).toMatchObject({
      name: "A1",
    })
  })

  it("enforces media limits under the ticket lock, and cascades on product removal", async () => {
    const { ticket } = await createTicket(db, newTicket("Media limits"))
    const { productId } = await addProduct(db, ticket.id, randomUUID(), {
      name: "Cam",
    })
    // Two parallel uploads racing for the last image slot: exactly one wins.
    await recordAsset(db, ticket.id, productId, newImage(), LIMITS)
    const raced = await Promise.allSettled([
      recordAsset(db, ticket.id, productId, newImage(), LIMITS),
      recordAsset(db, ticket.id, productId, newImage(), LIMITS),
    ])
    expect(raced.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(
      (raced.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason.code,
    ).toBe("limit")
    await expectTicketError(
      recordAsset(
        db,
        ticket.id,
        productId,
        newImage({
          kind: "video",
          mimeType: "video/mp4",
          extension: "mp4",
          durationMs: 1000,
          byteSize: 9_000,
        }),
        LIMITS,
      ),
      "limit",
    )
    const { removedAssets, ticket: after } = await removeProduct(
      db,
      ticket.id,
      productId,
    )
    expect(removedAssets).toHaveLength(2)
    expect(after.products).toEqual([])
    const left = await pool.query(
      "SELECT count(*)::int AS n FROM ticket_assets WHERE ticket_id = $1",
      [ticket.id],
    )
    expect(left.rows[0].n).toBe(0)
    const removedEvent = (await listEvents(db, ticket.id)).find(
      (e) => e.type === "product_removed",
    )
    expect(removedEvent!.details).toEqual({ assets: 2 })
  })

  it("lists with pagination, status filters, title search and ticket-number search", async () => {
    const tag = `Paginate ${randomUUID().slice(0, 6)}`
    const made = []
    for (let i = 0; i < 7; i++)
      made.push((await createTicket(db, newTicket(`${tag} ${i}`))).ticket)
    const page1 = await listTickets(db, query({ q: tag, pageSize: "3" }))
    const page3 = await listTickets(
      db,
      query({ q: tag, pageSize: "3", page: "3" }),
    )
    expect(page1).toMatchObject({ total: 7, page: 1, pageSize: 3 })
    expect(page1.tickets).toHaveLength(3)
    expect(page3.tickets).toHaveLength(1)
    // Newest change first.
    expect(page1.tickets[0].title).toBe(`${tag} 6`)
    const byNumber = await listTickets(db, query({ q: made[2].displayNumber }))
    expect(byNumber.tickets.map((t) => t.id)).toContain(made[2].id)
    const literal = await listTickets(db, query({ q: "%" }))
    expect(literal.tickets.every((t) => t.title.includes("%"))).toBe(true)
    await changeStatus(db, made[0].id, made[0].version, "archived")
    expect((await listTickets(db, query({ q: tag }))).total).toBe(6)
    expect(
      (await listTickets(db, query({ q: tag, status: "all" }))).total,
    ).toBe(7)
    expect(
      (await listTickets(db, query({ q: tag, status: "draft" }))).total,
    ).toBe(6)
  })

  it("keeps everything across reconnecting", async () => {
    const { ticket } = await createTicket(db, newTicket("Survives restarts"))
    await addProduct(db, ticket.id, randomUUID(), {
      name: "Kettle",
      affiliateUrl: "https://shop.example.com/kettle",
      references: [
        {
          kind: "demo_video",
          url: "https://video.example.com/k",
          label: "Demo",
        },
      ],
    })
    const other = createPool(scratch.config)
    try {
      const reread = await getTicket(createDatabase(other), ticket.id)
      expect(reread!.products[0]).toMatchObject({
        name: "Kettle",
        affiliateUrl: "https://shop.example.com/kettle",
        references: [
          {
            kind: "demo_video",
            url: "https://video.example.com/k",
            label: "Demo",
          },
        ],
      })
    } finally {
      await other.end()
    }
  })

  it("fails cleanly, without partial writes, when the database is unreachable", async () => {
    const dead = createPool(
      { ...scratch.config, port: 1 },
      { connectionTimeoutMs: 500 },
    )
    try {
      const error = await createTicket(
        createDatabase(dead),
        newTicket("Offline"),
      ).catch((e) => e)
      expect(classifyDatabaseError(error).failure).toBe("offline")
    } finally {
      await dead.end()
    }
    expect((await listTickets(db, query({ q: "Offline" }))).total).toBe(0)
  })

  it("allows the documented product capacity and refuses one more", async () => {
    const { ticket } = await createTicket(db, newTicket("Capacity"))
    await pool.query(
      "INSERT INTO ticket_products (ticket_id, position) SELECT $1, g FROM generate_series(0, $2 - 1) g",
      [ticket.id, TICKET_LIMITS.productsPerTicket],
    )
    await expectTicketError(
      addProduct(db, ticket.id, randomUUID(), {}),
      "limit",
    )
  })
})
