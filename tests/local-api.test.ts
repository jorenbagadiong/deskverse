import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { GET as getCapabilities } from "@/app/api/studio/pixel/capabilities/route"
import { POST as uploadAsset } from "@/app/api/studio/pixel/jobs/[jobId]/assets/route"
import { POST as startRender } from "@/app/api/studio/pixel/jobs/[jobId]/render/route"
import { GET as getJob } from "@/app/api/studio/pixel/jobs/[jobId]/route"
import { GET as getVideo } from "@/app/api/studio/pixel/jobs/[jobId]/video/route"
import { POST as createJob } from "@/app/api/studio/pixel/jobs/route"
import { createRenderJobId } from "@/lib/video/ids"
import { MEDIA_LIMITS } from "@/lib/video/validation"
import {
  BodyTooLargeError,
  guardLocalApi,
  localRenderingDisabledReason,
  readJsonBody,
  readLimitedBody,
  requireJson,
} from "@/server/http/local-api"
import { downloadSlug, parseByteRange } from "@/server/http/range"

const LOCAL = "http://localhost:3000"

function request(
  url: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
) {
  // Node's Request derives Host from the URL; tests set it explicitly.
  return new Request(`${LOCAL}${url}`, {
    ...init,
    headers: { host: "localhost:3000", ...init.headers },
  })
}

/** NextRequest-like: the routes only use .nextUrl on GET handlers. */
function nextRequest(url: string, headers: Record<string, string> = {}) {
  const r = request(url, { headers }) as Request & { nextUrl: URL }
  r.nextUrl = new URL(`${LOCAL}${url}`)
  return r as never
}

const ctx = (jobId: string) => ({ params: Promise.resolve({ jobId }) }) as never

let dataDir: string
const savedEnv = { ...process.env }

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "deskverse-api-"))
  process.env.DESKVERSE_DATA_DIR = dataDir
  for (const key of ["VERCEL", "NETLIFY", "DESKVERSE_DISABLE_LOCAL_RENDERING"])
    delete process.env[key]
})

afterAll(async () => {
  process.env = savedEnv
  await fs.rm(dataDir, { recursive: true, force: true })
})

describe("local rendering gate", () => {
  it("is disabled on hosting platforms and by explicit opt-out", () => {
    expect(localRenderingDisabledReason({})).toBeNull()
    expect(localRenderingDisabledReason({ VERCEL: "1" })).toMatch(/hosted site/)
    expect(localRenderingDisabledReason({ NETLIFY: "true" })).toMatch(
      /hosted site/,
    )
    expect(localRenderingDisabledReason({ K_SERVICE: "app" })).toMatch(
      /hosted site/,
    )
    expect(
      localRenderingDisabledReason({ DESKVERSE_DISABLE_LOCAL_RENDERING: "1" }),
    ).toMatch(/turned off/)
  })

  it("answers 503 when disabled and 403 for non-local callers", async () => {
    const local = request("/api/studio/pixel/jobs", { method: "POST" })
    expect(guardLocalApi(local, {})).toBeNull()
    expect(guardLocalApi(local, { VERCEL: "1" })?.status).toBe(503)
    for (const headers of [
      { host: "evil.example" },
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { "x-forwarded-for": "203.0.113.7" },
    ] as Record<string, string>[])
      expect(
        guardLocalApi(request("/x", { headers }), {})?.status,
        JSON.stringify(headers),
      ).toBe(403)
  })

  it("requires JSON for the render request (blocks form-based CSRF)", () => {
    expect(
      requireJson(
        request("/x", {
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      ),
    ).toBeNull()
    expect(
      requireJson(request("/x", { headers: { "content-type": "text/plain" } }))
        ?.status,
    ).toBe(415)
    expect(
      requireJson(
        request("/x", {
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
      )?.status,
    ).toBe(415)
  })
})

describe("upload size limits", () => {
  it("refuses an oversized declared length before reading anything", async () => {
    let pulled = false
    // highWaterMark 0: pull() only runs if someone actually reads the body.
    const body = new ReadableStream(
      {
        pull(controller) {
          pulled = true
          controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    const r = new Request(`${LOCAL}/x`, {
      method: "POST",
      body,
      headers: { "content-length": String(MEDIA_LIMITS.maxBytes + 1) },
      duplex: "half",
    } as RequestInit)
    await expect(
      readLimitedBody(r, MEDIA_LIMITS.maxBytes),
    ).rejects.toBeInstanceOf(BodyTooLargeError)
    expect(pulled).toBe(false)
  })

  it("stops streaming as soon as an undeclared body passes the limit", async () => {
    let chunks = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks++
        controller.enqueue(new Uint8Array(1024))
        if (chunks > 1000) controller.close()
      },
    })
    const r = new Request(`${LOCAL}/x`, {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit)
    await expect(readLimitedBody(r, 4096)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    )
    expect(chunks).toBeLessThan(10)
  })

  it("reads bodies within the limit and parses bounded JSON", async () => {
    const r = request("/x", { method: "POST", body: "hello" })
    expect(new TextDecoder().decode(await readLimitedBody(r, 10))).toBe("hello")
    const ok = await readJsonBody(
      request("/x", { method: "POST", body: '{"a":1}' }),
      100,
    )
    expect(ok).toEqual({ ok: true, value: { a: 1 } })
    const bad = await readJsonBody(
      request("/x", { method: "POST", body: "{oops" }),
      100,
    )
    expect(bad.ok ? 0 : bad.response.status).toBe(400)
    const big = await readJsonBody(
      request("/x", { method: "POST", body: "x".repeat(200) }),
      100,
    )
    expect(big.ok ? 0 : big.response.status).toBe(413)
  })
})

describe("video byte ranges and names", () => {
  it("parses the ranges a video player sends", () => {
    expect(parseByteRange(null, 1000)).toBeNull()
    expect(parseByteRange("bytes=0-", 1000)).toEqual({ start: 0, end: 999 })
    expect(parseByteRange("bytes=100-199", 1000)).toEqual({
      start: 100,
      end: 199,
    })
    expect(parseByteRange("bytes=900-5000", 1000)).toEqual({
      start: 900,
      end: 999,
    })
    expect(parseByteRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 })
    expect(parseByteRange("bytes=1000-", 1000)).toBe("unsatisfiable")
    expect(parseByteRange("bytes=500-100", 1000)).toBe("unsatisfiable")
    expect(parseByteRange("bytes=0-1,5-9", 1000)).toBeNull()
    expect(parseByteRange("items=0-1", 1000)).toBeNull()
  })

  it("makes ASCII-only download names", () => {
    expect(downloadSlug("Trailblazer Travel Mug")).toBe(
      "trailblazer-travel-mug",
    )
    expect(downloadSlug("Café « Crème » 2.0!")).toBe("cafe-creme-2-0")
    expect(downloadSlug('../"evil"\r\nname')).toBe("evil-name")
    expect(downloadSlug("☕☕")).toBe("pixel-video")
  })
})

describe("route handlers enforce the local-only boundary", () => {
  it("rejects every endpoint from another host", async () => {
    const id = createRenderJobId()
    const foreign = { host: "evil.example" }
    const responses = await Promise.all([
      getCapabilities(nextRequest("/api/studio/pixel/capabilities", foreign)),
      createJob(
        request("/api/studio/pixel/jobs", { method: "POST", headers: foreign }),
      ),
      getJob(
        request(`/api/studio/pixel/jobs/${id}`, { headers: foreign }),
        ctx(id),
      ),
      uploadAsset(
        request(`/api/studio/pixel/jobs/${id}/assets`, {
          method: "POST",
          headers: foreign,
        }),
        ctx(id),
      ),
      startRender(
        request(`/api/studio/pixel/jobs/${id}/render`, {
          method: "POST",
          headers: foreign,
        }),
        ctx(id),
      ),
      getVideo(
        nextRequest(`/api/studio/pixel/jobs/${id}/video`, foreign),
        ctx(id),
      ),
    ])
    expect(responses.map((r) => r.status)).toEqual([
      403, 403, 403, 403, 403, 403,
    ])
  })

  it("rejects malformed job IDs without touching storage", async () => {
    for (const bad of ["../../etc", "job_123", "%2e%2e"]) {
      expect((await getJob(request("/x"), ctx(bad))).status).toBe(404)
      expect((await getVideo(nextRequest("/x"), ctx(bad))).status).toBe(404)
    }
  })

  it("rejects uploads of the wrong type or size before reading them", async () => {
    const id = createRenderJobId()
    const svg = await uploadAsset(
      request(`/api/studio/pixel/jobs/${id}/assets`, {
        method: "POST",
        headers: { "content-type": "image/svg+xml" },
        body: "<svg/>",
      }),
      ctx(id),
    )
    expect(svg.status).toBe(415)
    const huge = await uploadAsset(
      request(`/api/studio/pixel/jobs/${id}/assets`, {
        method: "POST",
        headers: {
          "content-type": "image/png",
          "content-length": String(MEDIA_LIMITS.maxBytes + 1),
        },
      }),
      ctx(id),
    )
    expect(huge.status).toBe(413)
  })

  it("requires JSON to start a render", async () => {
    const id = createRenderJobId()
    const form = await startRender(
      request(`/api/studio/pixel/jobs/${id}/render`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "product=x",
      }),
      ctx(id),
    )
    expect(form.status).toBe(415)
  })

  it("creates jobs in the private data directory and never serves unfinished video", async () => {
    const created = await createJob(
      request("/api/studio/pixel/jobs", { method: "POST" }),
    )
    expect(created.status).toBe(201)
    const { jobId } = (await created.json()) as { jobId: string }
    expect(jobId).toMatch(/^job_[0-9a-f]{32}$/)
    await expect(
      fs.access(path.join(dataDir, "video", "jobs", jobId, "job.json")),
    ).resolves.toBeUndefined()

    const status = await getJob(
      request(`/api/studio/pixel/jobs/${jobId}`),
      ctx(jobId),
    )
    const body = (await status.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      jobId,
      state: "draft",
      videoUrl: null,
      downloadUrl: null,
      output: null,
    })
    expect(JSON.stringify(body)).not.toContain(dataDir)

    const video = await getVideo(
      nextRequest(`/api/studio/pixel/jobs/${jobId}/video`),
      ctx(jobId),
    )
    expect(video.status).toBe(404)
    const unknown = createRenderJobId()
    expect((await getJob(request("/x"), ctx(unknown))).status).toBe(404)
  })
})
