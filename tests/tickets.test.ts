import { describe, expect, it, vi } from "vitest"

import { GET as listRoute, POST as createRoute } from "@/app/api/tickets/route"
import { PATCH as patchTicketRoute } from "@/app/api/tickets/[ticketId]/route"
import { POST as uploadRoute } from "@/app/api/tickets/[ticketId]/products/[productId]/assets/route"
import {
  formatTicketNumber,
  TICKET_LIMITS,
  TICKET_TEXT_LIMITS,
} from "@/lib/tickets/types"
import {
  canTransition,
  isUuid,
  likePattern,
  mediaCompleteness,
  normalizeMultiline,
  parseListQuery,
  readinessIssues,
  validateNewTicket,
  validateProductPatch,
  validateReferences,
  validateTicketPatch,
  validateTitle,
  validateWebUrl,
} from "@/lib/tickets/validation"
import { manifestProblems } from "@/server/backup/manifest"
import { changedFields, event, sameValue } from "@/server/tickets/events"
import {
  assetFilePath,
  DEFAULT_MEDIA_LIMITS,
  displayName,
  readMediaLimits,
  TicketMediaError,
} from "@/server/tickets/media"
import {
  MediaRejected,
  parseVideoProbe,
  sniffTicketMedia,
} from "@/server/tickets/media-verify"

/** DV-004B unit tests: no database, no FFmpeg. */

const UUID = "3f2b8c1e-9d4a-4b6e-8f1a-2c3d4e5f6a7b"
const ok = <T>(r: { ok: true; value: T } | { ok: false }) => {
  if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r)}`)
  return r.value
}
const issues = (r: {
  ok: boolean
  issues?: { path: string; message: string }[]
}) => (r.ok ? [] : r.issues!)

describe("ticket numbers", () => {
  it.each([
    [1, "AFT-0001"],
    [42, "AFT-0042"],
    [9999, "AFT-9999"],
    [12345, "AFT-12345"],
  ])("formats %i as %s", (n, text) => expect(formatTicketNumber(n)).toBe(text))
})

describe("ticket validation", () => {
  it("normalizes and bounds the title", () => {
    expect(ok(validateTitle("  Spring \n  launch  "))).toBe("Spring launch")
    expect(issues(validateTitle(""))[0].message).toBe("Enter title.")
    expect(issues(validateTitle("ab"))[0].message).toMatch(
      /at least 3 characters/,
    )
    expect(issues(validateTitle("!!!"))[0].message).toMatch(/letter or number/)
    expect(issues(validateTitle("x".repeat(121)))[0].message).toMatch(
      /120 characters or fewer \(currently 121\)/,
    )
    expect(issues(validateTitle(42))[0].message).toBe("Title must be text.")
    // Bidirectional override characters could visually disguise a title.
    expect(
      issues(validateTitle(`Sale ${String.fromCharCode(0x202e)}gnp.exe`))[0]
        .message,
    ).toMatch(/invisible or control/)
  })

  it("keeps paragraphs in long text but tidies whitespace", () => {
    expect(normalizeMultiline("  Line 1  \r\n\r\n\r\n\r\nLine 2\t \n")).toBe(
      "Line 1\n\nLine 2",
    )
  })

  it("creates with defaults and requires a request id", () => {
    const created = ok(
      validateNewTicket({
        title: "Ten products",
        requestId: "a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789",
      }),
    )
    expect(created).toMatchObject({
      priority: "normal",
      platform: "tiktok",
      description: "",
      publishingPreferences: { schedule: "", notes: "" },
    })
    expect(
      issues(validateNewTicket({ title: "Ten products" })).map((i) => i.path),
    ).toEqual(["requestId"])
    expect(
      issues(validateNewTicket({ requestId: "a1b2c3d4-e5f6-4789-a012" })).map(
        (i) => i.path,
      ),
    ).toContain("title")
  })

  it("refuses unknown fields, bad choices and wrong shapes", () => {
    const result = validateTicketPatch({
      title: "OK title",
      status: "ready",
      priority: "urgent",
      platform: "myspace",
      publishingPreferences: { schedule: "Daily", extra: 1 },
    })
    expect(
      issues(result)
        .map((i) => i.path)
        .sort(),
    ).toEqual(["platform", "priority", "publishingPreferences.extra", "status"])
    expect(issues(validateTicketPatch([]))[0].message).toMatch(/JSON object/)
  })
})

describe("web URL validation (stored only, never fetched)", () => {
  it.each([
    [
      "https://www.amazon.com/dp/B0ABC?tag=me-20",
      "https://www.amazon.com/dp/B0ABC?tag=me-20",
    ],
    ["  http://shop.example.co.uk/p  ", "http://shop.example.co.uk/p"],
    ["https://EXAMPLE.com/Path", "https://example.com/Path"],
    ["https://bücher.example/x", "https://xn--bcher-kva.example/x"],
  ])("accepts %s", (raw, normalized) => {
    expect(ok(validateWebUrl(raw, "u", "Link"))).toBe(normalized)
  })

  it.each([
    ["", /Enter link/],
    ["javascript:alert(1)", /must start with https:\/\/ or http:\/\//],
    ["data:text/html,<script>", /must start with https/],
    ["file:///etc/passwd", /must start with https/],
    ["ftp://example.com/x", /must start with https/],
    ["https://user:pass@example.com", /can't contain a user name or password/],
    ["https://user@example.com", /can't contain a user name or password/],
    ["https://localhost/x", /needs a website name/],
    ["https://intranet/x", /needs a website name/],
    ["https://exa mple.com", /spaces or control characters/],
    ["example.com/product", /full web address/],
    [`https://example.com/${"a".repeat(2100)}`, /2048 characters or fewer/],
  ])("rejects %s", (raw, message) => {
    expect(issues(validateWebUrl(raw, "u", "Link"))[0].message).toMatch(message)
  })

  it("lets a Draft product leave its affiliate link empty", () => {
    expect(ok(validateProductPatch({ affiliateUrl: "  " }))).toEqual({
      affiliateUrl: "",
    })
  })
})

describe("product and reference validation", () => {
  it("validates every field and reports each problem by path", () => {
    const result = validateProductPatch({
      name: "x".repeat(121),
      affiliateUrl: "nope",
      mediaRights: "stolen",
      references: [
        { kind: "listing", url: "https://a.example.com" },
        { kind: "blog", url: "x" },
      ],
      price: 10,
    })
    expect(
      issues(result)
        .map((i) => i.path)
        .sort(),
    ).toEqual([
      "affiliateUrl",
      "mediaRights",
      "name",
      "price",
      "references.1.kind",
      "references.1.url",
    ])
  })

  it("accepts an empty Draft product", () => {
    expect(ok(validateProductPatch({}))).toEqual({})
  })

  it("bounds and de-duplicates references", () => {
    const many = Array.from(
      { length: TICKET_LIMITS.referencesPerProduct + 1 },
      (_, i) => ({
        kind: "other",
        url: `https://ref${i}.example.com`,
      }),
    )
    expect(issues(validateReferences(many))[0].message).toMatch(
      /at most 20 reference links/,
    )
    const dup = validateReferences([
      { kind: "review", url: "https://r.example.com/a" },
      { kind: "other", url: "https://R.example.com/a" },
    ])
    expect(issues(dup)).toEqual([
      {
        path: "references.1.url",
        message: "This link is already in the list.",
      },
    ])
  })
})

describe("lifecycle", () => {
  it("allows only the DV-004B transitions", () => {
    expect(canTransition("draft", "ready")).toBe(true)
    expect(canTransition("ready", "draft")).toBe(true)
    expect(canTransition("draft", "archived")).toBe(true)
    expect(canTransition("ready", "archived")).toBe(true)
    expect(canTransition("archived", "draft")).toBe(true)
    expect(canTransition("archived", "ready")).toBe(false)
  })

  it("needs a title and one product with a name and a valid affiliate link", () => {
    expect(
      readinessIssues({ title: "Good title", products: [] })[0].message,
    ).toBe("Add at least one product.")
    expect(
      readinessIssues({
        title: "Good title",
        products: [{ name: "Mug", affiliateUrl: "" }],
      })[0].message,
    ).toMatch(/needs a name and a valid affiliate link/)
    expect(
      readinessIssues({
        title: "Good title",
        products: [
          { name: "", affiliateUrl: "https://a.example.com" },
          { name: "Mug", affiliateUrl: "https://shop.example.com/mug" },
        ],
      }),
    ).toEqual([])
    expect(
      readinessIssues({
        title: "x",
        products: [{ name: "Mug", affiliateUrl: "https://a.example.com" }],
      }),
    ).toHaveLength(1)
  })

  it("reports media completeness separately (Pixel needs 3 images later)", () => {
    expect(mediaCompleteness([{ kind: "image" }, { kind: "video" }])).toEqual({
      images: 1,
      videos: 1,
      pixelReady: false,
    })
    expect(
      mediaCompleteness([
        { kind: "image" },
        { kind: "image" },
        { kind: "image" },
      ]).pixelReady,
    ).toBe(true)
  })
})

describe("list queries", () => {
  it("defaults to active tickets, page 1 of 20", () => {
    expect(ok(parseListQuery(new URLSearchParams()))).toEqual({
      status: "active",
      search: "",
      number: null,
      page: 1,
      pageSize: 20,
    })
  })
  it.each([
    ["AFT-0007", 7],
    ["aft7", 7],
    ["0042", 42],
    ["lamp", null],
  ])("recognises ticket number searches: %s", (q, number) => {
    expect(ok(parseListQuery(new URLSearchParams({ q }))).number).toBe(number)
  })
  it.each([
    [{ status: "deleted" }, "status"],
    [{ page: "0" }, "page"],
    [{ page: "-1" }, "page"],
    [{ pageSize: "51" }, "pageSize"],
    [{ pageSize: "abc" }, "pageSize"],
  ])("refuses %o", (params, path) => {
    expect(issues(parseListQuery(new URLSearchParams(params)))[0].path).toBe(
      path,
    )
  })
  it("bounds the search and escapes LIKE wildcards", () => {
    const long = ok(parseListQuery(new URLSearchParams({ q: "x".repeat(500) })))
    expect(long.search).toHaveLength(TICKET_TEXT_LIMITS.search)
    expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%")
  })
  it("recognises generated ids only", () => {
    expect(isUuid(UUID)).toBe(true)
    expect(isUuid("../../etc")).toBe(false)
    expect(isUuid(UUID.toUpperCase())).toBe(false)
  })
})

describe("activity events", () => {
  it("records which fields changed, never their values", () => {
    expect(
      changedFields(
        { title: "A", description: "same" },
        { title: "B", description: "same" },
      ),
    ).toEqual(["title"])
    expect(
      sameValue({ schedule: "", notes: "x" }, { notes: "x", schedule: "" }),
    ).toBe(true)
    const e = event.productUpdated(UUID, ["affiliateUrl", "name"], {
      before: 1,
      after: 2,
    })
    expect(e).toEqual({
      type: "product_updated",
      productId: UUID,
      details: {
        fields: ["affiliateUrl", "name"],
        references: { before: 1, after: 2 },
      },
    })
    expect(event.assetUploaded(UUID, UUID, "image", 100).details).toEqual({
      kind: "image",
      bytes: 100,
    })
    expect(event.productMoved(UUID, 0, 4).details).toEqual({ from: 1, to: 5 })
  })
})

describe("media identification and limits", () => {
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
  ])
  const ftyp = (brand: string) =>
    new Uint8Array([
      0,
      0,
      0,
      0x20,
      ...Buffer.from("ftyp"),
      ...Buffer.from(brand),
      0,
      0,
      0,
      0,
    ])

  it("identifies files by their bytes", () => {
    expect(sniffTicketMedia(png)).toBe("image/png")
    expect(sniffTicketMedia(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image/jpeg",
    )
    expect(sniffTicketMedia(ftyp("isom"))).toBe("video/mp4")
    expect(sniffTicketMedia(ftyp("mp42"))).toBe("video/mp4")
    expect(sniffTicketMedia(ftyp("qt  "))).toBeNull()
    expect(sniffTicketMedia(Buffer.from("<svg xmlns"))).toBeNull()
    expect(sniffTicketMedia(Buffer.from("MZ\x90\x00"))).toBeNull()
  })

  const probe = (stream: object, format: object = {}) =>
    JSON.stringify({
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1080,
          height: 1920,
          ...stream,
        },
      ],
      format: {
        format_name: "mov,mp4,m4a,3gp,3g2,mj2",
        duration: "12.5",
        ...format,
      },
    })
  const video = { maxSeconds: 300, maxSide: 4096, minSide: 144 }

  it("accepts a normal MP4 probe and reads its length", () => {
    expect(parseVideoProbe(probe({}), video)).toEqual({
      kind: "video",
      width: 1080,
      height: 1920,
      durationMs: 12500,
    })
  })
  it.each([
    [probe({}, { format_name: "matroska,webm" }), /isn't an MP4/],
    [probe({ codec_type: "audio" }), /contains no video/],
    [probe({ disposition: { attached_pic: 1 } }), /contains no video/],
    [probe({ codec_name: "prores" }), /unsupported codec/],
    [probe({ width: 100, height: 100 }), /too small/],
    [probe({ width: 8000 }), /too large/],
    [probe({}, { duration: "N/A" }), /length can't be read/],
    [probe({}, { duration: "301" }), /301 s long/],
    ["not json", /couldn't read/],
  ])("rejects probe %#", (stdout, message) => {
    expect(() => parseVideoProbe(stdout, video)).toThrow(MediaRejected)
    expect(() => parseVideoProbe(stdout, video)).toThrow(message)
  })

  it("reads limit overrides, ignoring invalid ones", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(readMediaLimits({})).toEqual(DEFAULT_MEDIA_LIMITS)
    expect(
      readMediaLimits({
        DESKVERSE_TICKET_MAX_VIDEO_MB: "50",
        DESKVERSE_TICKET_MAX_VIDEO_SECONDS: "60",
      }),
    ).toMatchObject({
      maxVideoBytes: 50 * 1024 * 1024,
      maxVideoSeconds: 60,
    })
    expect(
      readMediaLimits({ DESKVERSE_TICKET_MAX_VIDEO_MB: "1e9" }).maxVideoBytes,
    ).toBe(DEFAULT_MEDIA_LIMITS.maxVideoBytes)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it("builds paths from generated ids only", () => {
    expect(assetFilePath("/data", UUID, UUID, "png")).toBe(
      `/data/tickets/${UUID}/assets/${UUID}.png`,
    )
    for (const bad of ["..", "../x", "a/b", "", UUID.toUpperCase()])
      expect(() => assetFilePath("/data", bad, UUID, "png")).toThrow(
        TicketMediaError,
      )
    expect(() => assetFilePath("/data", UUID, UUID, "exe")).toThrow(
      TicketMediaError,
    )
  })

  it("keeps upload names for display only, stripped of paths and control characters", () => {
    expect(displayName("C:\\Users\\me\\Desktop\\lamp.png", "png")).toBe(
      "lamp.png",
    )
    expect(displayName("../../etc/passwd", "png")).toBe("passwd")
    expect(displayName("a\u0007b.png", "png")).toBe("ab.png")
    expect(displayName("", "mp4")).toBe("file.mp4")
  })
})

describe("backup manifest format 2", () => {
  const base = {
    format: "deskverse-backup",
    database: { file: "database.dump", bytes: 1, sha256: "a".repeat(64) },
    media: { files: [] },
  }
  const ticketFile = {
    path: `tickets/${UUID}/assets/${UUID}.png`,
    bytes: 1,
    sha256: "b".repeat(64),
  }

  it("accepts format 1 without ticket media and format 2 with it", () => {
    expect(manifestProblems({ ...base, formatVersion: 1 })).toEqual([])
    expect(
      manifestProblems({
        ...base,
        formatVersion: 2,
        ticketMedia: { source: "tickets", assets: 1, files: [ticketFile] },
      }),
    ).toEqual([])
  })
  it("refuses inconsistent or unsafe ticket media entries", () => {
    expect(manifestProblems({ ...base, formatVersion: 2 })).toContain(
      "ticket media section is missing or invalid",
    )
    expect(
      manifestProblems({ ...base, formatVersion: 1, ticketMedia: {} }),
    ).toContain("a version 1 backup can't contain ticket media")
    for (const bad of [
      `tickets/${UUID}/assets/../../x.png`,
      `tickets/${UUID}/staging/${UUID}.png`,
      `tickets/${UUID}/assets/${UUID}.sh`,
    ])
      expect(
        manifestProblems({
          ...base,
          formatVersion: 2,
          ticketMedia: {
            source: "tickets",
            assets: 1,
            files: [{ ...ticketFile, path: bad }],
          },
        }),
      ).toContain("ticket media file list has an invalid entry")
    expect(
      manifestProblems({
        ...base,
        formatVersion: 2,
        ticketMedia: { source: "tickets", assets: 2, files: [ticketFile] },
      }),
    ).toContain("ticket media count doesn't match its file list")
    expect(manifestProblems({ ...base, formatVersion: 4 })[0]).toMatch(
      /reads 1, 2 and 3/,
    )
  })
  it("accepts format 3 with ticket videos and refuses an inconsistent or unsafe video section", () => {
    const ticketMedia = { source: "tickets", assets: 1, files: [ticketFile] }
    const job = `ticket-renders/video/jobs/job_${"c".repeat(32)}`
    const file = (p: string) => ({
      path: `${job}/${p}`,
      bytes: 1,
      sha256: "d".repeat(64),
    })
    const ticketVideos = {
      source: "ticket-renders/video/jobs",
      deliverables: 1,
      bytes: 3,
      files: [file("job.json"), file("project.json"), file("output/video.mp4")],
    }
    expect(
      manifestProblems({
        ...base,
        formatVersion: 3,
        ticketMedia,
        ticketVideos,
      }),
    ).toEqual([])
    expect(
      manifestProblems({ ...base, formatVersion: 3, ticketMedia }),
    ).toContain("ticket video section is missing or invalid")
    expect(
      manifestProblems({
        ...base,
        formatVersion: 2,
        ticketMedia,
        ticketVideos,
      }),
    ).toContain("only a version 3 backup can contain ticket videos")
    for (const bad of [
      "output/../../x.mp4",
      "output/other.mp4",
      "work/frame.png",
      "assets/asset_x.sh",
    ])
      expect(
        manifestProblems({
          ...base,
          formatVersion: 3,
          ticketMedia,
          ticketVideos: { ...ticketVideos, files: [file(bad)] },
        }),
      ).toContain("ticket video file list has an invalid entry")
    expect(
      manifestProblems({
        ...base,
        formatVersion: 3,
        ticketMedia,
        ticketVideos: { ...ticketVideos, deliverables: 2 },
      }),
    ).toContain("ticket video count doesn't match its file list")
  })
})

describe("ticket API routes without a database", () => {
  const request = (
    url: string,
    init: RequestInit & { headers?: Record<string, string> } = {},
  ) =>
    Object.assign(
      new Request(`http://localhost:3000${url}`, {
        ...init,
        headers: { host: "localhost:3000", ...init.headers },
      }),
      { nextUrl: new URL(`http://localhost:3000${url}`) },
    )
  const json = (body: unknown) => ({
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
  const ctx = <T extends Record<string, string>>(params: T) => ({
    params: Promise.resolve(params),
  })

  it("refuses cross-site and rebinding requests", async () => {
    for (const headers of [
      { host: "evil.example" },
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
    ] as Record<string, string>[]) {
      const response = await listRoute(
        request("/api/tickets", { headers }) as never,
      )
      expect(response.status).toBe(403)
    }
  })

  it("validates before touching the database, then reports 503 when none is configured", async () => {
    vi.stubEnv("DATABASE_URL", "")
    try {
      const invalid = await createRoute(
        request("/api/tickets", json({ title: "x" })),
      )
      expect(invalid.status).toBe(400)
      const body = await invalid.json()
      expect(body.issues.map((i: { path: string }) => i.path).sort()).toEqual([
        "requestId",
        "title",
      ])

      const unconfigured = await createRoute(
        request(
          "/api/tickets",
          json({
            title: "Good title",
            requestId: "a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789",
          }),
        ),
      )
      expect(unconfigured.status).toBe(503)
      expect(unconfigured.headers.get("cache-control")).toBe("no-store")
      expect((await unconfigured.json()).message).toMatch(
        /need local PostgreSQL.*Nothing was saved/,
      )

      const list = await listRoute(
        request("/api/tickets?pageSize=999") as never,
      )
      expect(list.status).toBe(400)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("refuses non-JSON, oversized and malformed bodies", async () => {
    const form = await createRoute(
      request("/api/tickets", {
        method: "POST",
        body: "a=b",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    )
    expect(form.status).toBe(415)
    const big = await createRoute(
      request("/api/tickets", json({ title: "x".repeat(200_000) })),
    )
    expect(big.status).toBe(413)
    const broken = await createRoute(
      request("/api/tickets", {
        method: "POST",
        body: "{",
        headers: { "content-type": "application/json" },
      }),
    )
    expect(broken.status).toBe(400)
  })

  it("treats non-UUID ids as not found and needs a version to edit", async () => {
    const notFound = await patchTicketRoute(
      request("/api/tickets/../etc", {
        ...json({ version: 1, status: "ready" }),
        method: "PATCH",
      }),
      ctx({ ticketId: "../etc" }) as never,
    )
    expect(notFound.status).toBe(404)
    const upload = await uploadRoute(
      request(`/api/tickets/${UUID}/products/x/assets`, {
        method: "POST",
        body: "x",
      }),
      ctx({ ticketId: UUID, productId: "x" }) as never,
    )
    expect(upload.status).toBe(404)
    const noVersion = await patchTicketRoute(
      request(`/api/tickets/${UUID}`, {
        ...json({ status: "ready" }),
        method: "PATCH",
      }),
      ctx({ ticketId: UUID }) as never,
    )
    expect(noVersion.status).toBe(400)
    expect((await noVersion.json()).issues[0].path).toBe("version")
  })
})
