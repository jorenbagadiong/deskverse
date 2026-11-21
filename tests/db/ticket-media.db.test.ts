import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { validateNewTicket } from "@/lib/tickets/validation"
import { journal } from "@/server/db/journal"
import { migrationsFolder, runMigrations } from "@/server/db/migrations"
import {
  createDatabase,
  createPool,
  type DeskverseDatabase,
} from "@/server/db/pool"
import { createRunner } from "@/server/process/run-executable"
import {
  assetFilePath,
  DEFAULT_MEDIA_LIMITS,
  deleteAssetFile,
  openAssetFile,
  reconcileTicketMedia,
  storeUpload,
  TicketMediaError,
  type TicketMediaLimits,
} from "@/server/tickets/media"
import { MediaRejected } from "@/server/tickets/media-verify"
import {
  addProduct,
  createTicket,
  findAsset,
  getTicket,
  listEvents,
  removeAssetRecord,
  removeProduct,
  TicketError,
} from "@/server/tickets/repository"

import { createScratchDatabase, type ScratchDatabase } from "./helpers"

/**
 * DV-004B: Affiliate Ticket media with real FFmpeg/FFprobe, a scratch
 * database and a temporary data folder (never ~/.local/share/deskverse).
 */

const tools = {
  run: createRunner({ timeoutMs: 60_000 }),
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
}

let scratch: ScratchDatabase
let pool: ReturnType<typeof createPool>
let db: DeskverseDatabase
let temp: string
let dataRoot: string
const fixtures: Record<string, Buffer> = {}

function ffmpeg(args: string[], out: string) {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args, out])
  return fs.readFile(out)
}

beforeAll(async () => {
  scratch = await createScratchDatabase("media")
  pool = createPool(scratch.config)
  await runMigrations(pool, journal, migrationsFolder())
  db = createDatabase(pool)
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-ticket-media-"))
  dataRoot = path.join(temp, "data")
  const f = (name: string) => path.join(temp, name)
  const pattern = ["-f", "lavfi", "-i", "testsrc2=size=640x480:rate=30"]
  fixtures.png = await ffmpeg([...pattern, "-frames:v", "1"], f("a.png"))
  fixtures.jpeg = await ffmpeg(
    [...pattern, "-frames:v", "1", "-q:v", "3"],
    f("a.jpg"),
  )
  fixtures.webp = await ffmpeg([...pattern, "-frames:v", "1"], f("a.webp"))
  fixtures.tiny = await ffmpeg(
    ["-f", "lavfi", "-i", "color=red:size=100x100", "-frames:v", "1"],
    f("tiny.png"),
  )
  fixtures.mp4 = await ffmpeg(
    [
      ...pattern,
      "-t",
      "2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
    ],
    f("clip.mp4"),
  )
  fixtures.mov = await ffmpeg(
    [...pattern, "-t", "1", "-c:v", "libx264", "-f", "mov"],
    f("clip.mov"),
  )
  fixtures.long = await ffmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      "color=blue:size=320x240:rate=5",
      "-t",
      "8",
      "-c:v",
      "libx264",
    ],
    f("long.mp4"),
  )
})

afterAll(async () => {
  await pool?.end()
  await scratch?.drop()
  if (temp) await fs.rm(temp, { recursive: true, force: true })
})

function stream(bytes: Uint8Array, chunk = 16 * 1024) {
  let offset = 0
  let pulled = 0
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset >= bytes.length) return controller.close()
        const next = bytes.subarray(offset, offset + chunk)
        offset += next.length
        pulled += next.length
        controller.enqueue(next)
      },
    },
    { highWaterMark: 0 },
  ) // count only what the server actually reads
  return { body, pulled: () => pulled }
}

async function setup(title = "Media ticket") {
  const input = validateNewTicket({ title, requestId: randomUUID() })
  if (!input.ok) throw new Error("bad")
  const { ticket } = await createTicket(db, input.value)
  const { productId } = await addProduct(db, ticket.id, randomUUID(), {
    name: "Lamp",
  })
  return { ticketId: ticket.id, productId }
}

function upload(
  ids: { ticketId: string; productId: string },
  bytes: Uint8Array,
  declaredType: string,
  extra: {
    limits?: TicketMediaLimits
    fileName?: string
    beforeRecord?: () => void
  } = {},
) {
  return storeUpload({
    db,
    dataRoot,
    ...ids,
    body: stream(bytes).body,
    declaredLength: bytes.length,
    declaredType,
    fileName: extra.fileName ?? "upload",
    limits: extra.limits ?? DEFAULT_MEDIA_LIMITS,
    tools,
    beforeRecord: extra.beforeRecord,
  })
}

async function rejectedWith(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).not.toBeNull()
  return error as Error
}

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => [])) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await filesUnder(full)))
    else out.push(path.relative(dataRoot, full))
  }
  return out.sort()
}

describe("ticket media uploads", () => {
  it("stores JPEG, PNG, WebP and MP4 privately, with checksums and an event", async () => {
    const ids = await setup()
    const png = await upload(ids, fixtures.png, "image/png", {
      fileName: "../../etc/Lamp front.png",
    })
    const jpeg = await upload(ids, fixtures.jpeg, "image/jpeg")
    const webp = await upload(ids, fixtures.webp, "image/webp")
    const video = await upload(ids, fixtures.mp4, "video/mp4", {
      fileName: "demo.mp4",
    })
    expect(png).toMatchObject({
      kind: "image",
      mimeType: "image/png",
      width: 640,
      height: 480,
      sizeBytes: fixtures.png.length,
      sha256: sha(fixtures.png),
      displayName: "Lamp front.png",
      durationSeconds: null,
    })
    expect(jpeg.mimeType).toBe("image/jpeg")
    expect(webp.mimeType).toBe("image/webp")
    expect(video).toMatchObject({
      kind: "video",
      mimeType: "video/mp4",
      width: 640,
      height: 480,
    })
    expect(video.durationSeconds).toBeCloseTo(2, 0)
    // API shape never includes a disk path.
    expect(JSON.stringify([png, video])).not.toContain(dataRoot)
    expect(png.url).toBe(
      `/api/tickets/${ids.ticketId}/products/${ids.productId}/assets/${png.id}`,
    )

    const file = assetFilePath(dataRoot, ids.ticketId, png.id, "png")
    expect(path.relative(dataRoot, file)).toBe(
      `tickets/${ids.ticketId}/assets/${png.id}.png`,
    )
    expect(sha(await fs.readFile(file))).toBe(png.sha256)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700)
    expect(
      await fs.readdir(path.join(dataRoot, "tickets", ids.ticketId, "staging")),
    ).toEqual([])
    const events = await listEvents(db, ids.ticketId)
    expect(events.filter((e) => e.type === "asset_uploaded")).toHaveLength(4)
    expect(JSON.stringify(events)).not.toMatch(/Lamp front|\.png|tickets\//)
  })

  it.each([
    [
      "an HTML file sent as PNG",
      Buffer.from("<!doctype html><script>alert(1)</script>"),
      "image/png",
      /aren't a JPEG, PNG, WebP image or MP4/,
    ],
    [
      "a PNG sent as JPEG",
      "png",
      "image/jpeg",
      /are a PNG image, not the image\/jpeg/,
    ],
    [
      "an MP4 sent as PNG",
      "mp4",
      "image/png",
      /are an MP4 video, not the image\/png/,
    ],
    [
      "a QuickTime .mov sent as MP4",
      "mov",
      "video/mp4",
      /aren't a JPEG, PNG, WebP image or MP4/,
    ],
    [
      "an unsupported type (GIF)",
      Buffer.from("GIF89a"),
      "image/gif",
      /Upload JPEG, PNG or WebP images, or MP4/,
    ],
    ["SVG", Buffer.from("<svg/>"), "image/svg+xml", /Upload JPEG, PNG or WebP/],
    ["a too-small image", "tiny", "image/png", /too small \(100×100\)/],
  ])("rejects %s", async (_, source, type, message) => {
    const ids = await setup()
    const bytes = typeof source === "string" ? fixtures[source] : source
    const error = await rejectedWith(upload(ids, bytes, type))
    expect(error).toBeInstanceOf(MediaRejected)
    expect(error.message).toMatch(message)
    expect(
      await filesUnder(path.join(dataRoot, "tickets", ids.ticketId)),
    ).toEqual([])
    expect((await getTicket(db, ids.ticketId))!.products[0].assets).toEqual([])
  })

  it.each([
    ["a truncated PNG", "png", "image/png"],
    ["a truncated JPEG", "jpeg", "image/jpeg"],
    ["a truncated MP4", "mp4", "video/mp4"],
  ])("rejects %s (valid header, damaged body)", async (_, source, type) => {
    const ids = await setup()
    const bytes = fixtures[source].subarray(
      0,
      Math.floor(fixtures[source].length * 0.6),
    )
    const error = await rejectedWith(upload(ids, bytes, type))
    expect(error).toBeInstanceOf(MediaRejected)
    expect(
      await filesUnder(path.join(dataRoot, "tickets", ids.ticketId)),
    ).toEqual([])
  })

  it("rejects a corrupted MP4 body and a clip over the length limit", async () => {
    const ids = await setup()
    const corrupt = Buffer.from(fixtures.mp4)
    for (
      let i = Math.floor(corrupt.length / 2);
      i < corrupt.length - 64;
      i += 97
    )
      corrupt[i] ^= 0xff
    expect(
      await rejectedWith(upload(ids, corrupt, "video/mp4")),
    ).toBeInstanceOf(MediaRejected)
    const long = await rejectedWith(
      upload(ids, fixtures.long, "video/mp4", {
        limits: { ...DEFAULT_MEDIA_LIMITS, maxVideoSeconds: 5 },
      }),
    )
    expect(long.message).toMatch(/8 s long\. Clips can be at most 5 s/)
  })

  it("enforces the size limit while streaming, before reading the whole upload", async () => {
    const ids = await setup()
    const big = Buffer.alloc(3 * 1024 * 1024, 7)
    big.set(fixtures.png.subarray(0, 64))
    const source = stream(big)
    const error = await rejectedWith(
      storeUpload({
        db,
        dataRoot,
        ...ids,
        body: source.body,
        declaredLength: null, // no Content-Length: only the streaming check applies
        declaredType: "image/png",
        fileName: "big.png",
        limits: { ...DEFAULT_MEDIA_LIMITS, maxImageBytes: 1024 * 1024 },
        tools,
      }),
    )
    expect(error).toBeInstanceOf(TicketMediaError)
    expect(error.message).toBe("Images must be 1 MB or smaller.")
    expect(source.pulled()).toBeLessThanOrEqual(1024 * 1024 + 32 * 1024)
    expect(
      await filesUnder(path.join(dataRoot, "tickets", ids.ticketId)),
    ).toEqual([])
    // A declared Content-Length over the limit is refused before reading.
    const declared = stream(fixtures.png)
    await rejectedWith(
      storeUpload({
        db,
        dataRoot,
        ...ids,
        body: declared.body,
        declaredLength: 50 * 1024 * 1024,
        declaredType: "image/png",
        fileName: "x.png",
        limits: DEFAULT_MEDIA_LIMITS,
        tools,
      }),
    )
    expect(declared.pulled()).toBe(0)
  })

  it("never keeps a file when the database step fails (no orphan, no record)", async () => {
    const ids = await setup()
    // 1. Failure right before the insert (e.g. the process is stopping).
    await rejectedWith(
      upload(ids, fixtures.png, "image/png", {
        beforeRecord: () => {
          throw new Error("simulated interruption")
        },
      }),
    )
    // 2. The product disappears while the upload is being verified.
    await rejectedWith(
      upload(ids, fixtures.png, "image/png", {
        beforeRecord: async () => {
          await removeProduct(db, ids.ticketId, ids.productId)
        },
      }),
    )
    expect(
      await filesUnder(path.join(dataRoot, "tickets", ids.ticketId)),
    ).toEqual([])
    const rows = await pool.query(
      "SELECT count(*)::int AS n FROM ticket_assets WHERE ticket_id = $1",
      [ids.ticketId],
    )
    expect(rows.rows[0].n).toBe(0)
  })

  it("refuses unsafe ids and symbolic links anywhere on the path", async () => {
    const ids = await setup()
    expect(() =>
      assetFilePath(dataRoot, "../../etc", randomUUID(), "png"),
    ).toThrow(TicketMediaError)
    expect(() =>
      assetFilePath(dataRoot, ids.ticketId, randomUUID(), "sh"),
    ).toThrow(TicketMediaError)
    await rejectedWith(
      upload({ ...ids, productId: "../x" }, fixtures.png, "image/png"),
    )

    // assets/ replaced by a link to somewhere else: uploads refuse to use it.
    const outside = path.join(temp, "outside")
    await fs.mkdir(outside, { recursive: true })
    const ticketDir = path.join(dataRoot, "tickets", ids.ticketId)
    await fs.mkdir(ticketDir, { recursive: true })
    await fs.symlink(outside, path.join(ticketDir, "assets"))
    const linked = await rejectedWith(upload(ids, fixtures.png, "image/png"))
    expect(linked.message).toMatch(/link/)
    expect(await fs.readdir(outside)).toEqual([])
    await fs.unlink(path.join(ticketDir, "assets"))

    // A stored file swapped for a link (e.g. to a secret) is never served.
    const asset = await upload(ids, fixtures.png, "image/png")
    const file = assetFilePath(dataRoot, ids.ticketId, asset.id, "png")
    const secret = path.join(temp, "secret.txt")
    await fs.writeFile(secret, "private")
    await fs.rm(file)
    await fs.symlink(secret, file)
    const row = (await findAsset(db, ids.ticketId, ids.productId, asset.id))!
    expect((await rejectedWith(openAssetFile(dataRoot, row))).message).toMatch(
      /symbolic link/,
    )
  })

  it("only finds an asset through its own ticket and product", async () => {
    const a = await setup("Owner")
    const b = await setup("Intruder")
    const asset = await upload(a, fixtures.png, "image/png")
    expect(
      await findAsset(db, a.ticketId, a.productId, asset.id),
    ).not.toBeNull()
    expect(await findAsset(db, b.ticketId, b.productId, asset.id)).toBeNull()
    expect(await findAsset(db, b.ticketId, a.productId, asset.id)).toBeNull()
    expect(await findAsset(db, a.ticketId, b.productId, asset.id)).toBeNull()
    await expect(
      upload(
        { ticketId: b.ticketId, productId: a.productId },
        fixtures.png,
        "image/png",
      ),
    ).rejects.toBeInstanceOf(TicketError)
  })

  it("removes an attachment: record first, then file; a missing file reads as gone", async () => {
    const ids = await setup()
    const asset = await upload(ids, fixtures.jpeg, "image/jpeg")
    const row = (await findAsset(db, ids.ticketId, ids.productId, asset.id))!
    const removed = await removeAssetRecord(
      db,
      ids.ticketId,
      ids.productId,
      asset.id,
    )
    await deleteAssetFile(dataRoot, removed)
    expect(
      await findAsset(db, ids.ticketId, ids.productId, asset.id),
    ).toBeNull()
    const missing = await rejectedWith(openAssetFile(dataRoot, row))
    expect(missing).toBeInstanceOf(TicketMediaError)
    expect((missing as TicketMediaError).code).toBe("missing")
    const types = (await listEvents(db, ids.ticketId)).map((e) => e.type)
    expect(types[0]).toBe("asset_removed")
  })

  it("reconciles: reports and quarantines orphans and unfinished uploads, never registered files", async () => {
    const ids = await setup("Reconcile")
    const keep = await upload(ids, fixtures.png, "image/png")
    const dir = path.join(dataRoot, "tickets", ids.ticketId)
    const orphanId = randomUUID()
    await fs.writeFile(
      path.join(dir, "assets", `${orphanId}.png`),
      fixtures.png,
    )
    await fs.writeFile(
      path.join(dir, "staging", `${randomUUID()}.part`),
      "half",
    )
    const report = await reconcileTicketMedia(db, dataRoot)
    expect(report.orphans).toContain(`${ids.ticketId}/assets/${orphanId}.png`)
    expect(
      report.staging.some((s) => s.startsWith(`${ids.ticketId}/staging/`)),
    ).toBe(true)
    expect(report.damaged.filter((d) => d.ticketId === ids.ticketId)).toEqual(
      [],
    )

    await reconcileTicketMedia(db, dataRoot, {
      apply: true,
      now: new Date("2026-11-21T00:00:00Z"),
    })
    expect(await fs.readdir(path.join(dir, "staging"))).toEqual([])
    expect(await fs.readdir(path.join(dir, "assets"))).toEqual([
      `${keep.id}.png`,
    ])
    expect(
      await fs.readFile(
        path.join(
          dataRoot,
          "tickets-orphaned",
          "20261121T000000Z",
          ids.ticketId,
          "assets",
          `${orphanId}.png`,
        ),
      ),
    ).toEqual(fixtures.png)

    // A registered file damaged on disk is reported, not touched.
    await fs.appendFile(
      assetFilePath(dataRoot, ids.ticketId, keep.id, "png"),
      "x",
    )
    const damaged = await reconcileTicketMedia(db, dataRoot)
    expect(damaged.damaged).toContainEqual({
      ticketId: ids.ticketId,
      assetId: keep.id,
      problem: "wrong size",
    })
  })
})
