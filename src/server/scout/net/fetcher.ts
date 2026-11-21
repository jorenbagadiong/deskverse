import { createHash } from "node:crypto"
import dns from "node:dns"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import { setTimeout as sleep } from "node:timers/promises"
import tls from "node:tls"
import zlib from "node:zlib"

import type { SourceOutcome } from "@/lib/scout/types"
import { canonicalAddress, classifyAddress } from "@/server/scout/net/address"
import {
  parseRobots,
  ROBOTS_MAX_BYTES,
  robotsAllows,
  type RobotsPolicy,
} from "@/server/scout/net/robots"
import { checkSourceUrl } from "@/server/scout/net/url"

/**
 * Scout's safe HTTP retrieval (DV-005A). Never `fetch(userUrl)`.
 *
 * For every request (the page, each redirect hop, robots.txt):
 *  1. the URL passes checkSourceUrl (http/https, default port, no
 *     credentials, no numeric or local-only host);
 *  2. the host name is resolved ONCE and every returned address must be
 *     public (classifyAddress), or nothing is fetched;
 *  3. the socket connects to exactly that validated address (the request
 *     never resolves the name again, so DNS rebinding between check and
 *     connect is impossible), and the connected peer address is checked
 *     again after connecting;
 *  4. only fixed headers are sent: a descriptive User-Agent, Accept and
 *     Accept-Encoding. No cookies, Authorization, Referer or environment
 *     values. TLS certificates are verified (servername = host name);
 *  5. responses are bounded: connect and total timeouts, AbortSignal,
 *     a byte limit enforced while streaming (and on decompressed bytes),
 *     and an allow-list of content types. Nothing is executed.
 * Redirects are followed manually (≤ 3 hops), each hop re-validated from
 * step 1; https → http downgrades are refused. robots.txt is honoured per
 * origin. Requests to one host are paced, and Retry-After is reported.
 *
 * `NetworkDeps` is injectable so tests can point fake public addresses at
 * local fixture servers without loosening any of these checks.
 */

export const SCOUT_USER_AGENT =
  "DeskverseScout/1.0 (+local research assistant; reads only owner-supplied reference pages; honours robots.txt)"

export interface NetworkDeps {
  /** All addresses for a host name. */
  resolve(host: string, signal: AbortSignal): Promise<string[]>
  /** A TCP socket to exactly `address:port`. */
  dial(address: string, port: number): net.Socket
  /**
   * Wraps a socket in verified TLS for `servername`. Production: tls.connect
   * with certificate verification. The fixture network (tests only) passes
   * the socket through, because fixture sites run without certificates.
   */
  secure?(socket: net.Socket, servername: string): net.Socket
}

const verifiedTls = (socket: net.Socket, servername: string) =>
  tls.connect({
    socket,
    servername,
    ALPNProtocols: ["http/1.1"],
    rejectUnauthorized: true,
  })

export const realNetwork: NetworkDeps = {
  async resolve(host, signal) {
    const lookup = dns.promises.lookup(host, { all: true, verbatim: true })
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason)
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      })
    })
    const results = await Promise.race([lookup, aborted])
    return results.map((r) => r.address)
  },
  dial(address, port) {
    const socket = net.connect({
      host: address,
      port,
      family: net.isIPv6(address) ? 6 : 4,
    })
    socket.once("connect", () => {
      // Defence in depth: the peer must be the address that was validated.
      if (
        canonicalAddress(socket.remoteAddress ?? "") !==
        canonicalAddress(address)
      )
        socket.destroy(new Error("connected address differs"))
    })
    return socket
  },
  secure: verifiedTls,
}

export interface FetchLimits {
  maxPageBytes: number
  requestTimeoutMs: number
  connectTimeoutMs: number
  maxRedirects: number
  hostIntervalMs: number
}

export const DEFAULT_FETCH_LIMITS: FetchLimits = {
  maxPageBytes: 2 * 1024 * 1024,
  requestTimeoutMs: 15_000,
  connectTimeoutMs: 5_000,
  maxRedirects: 3,
  hostIntervalMs: 1_000,
}

const PAGE_TYPES = ["text/html", "application/xhtml+xml", "text/plain"]

export interface FetchedPage {
  ok: true
  requestedUrl: string
  finalUrl: string
  status: number
  contentType: string
  charset: string | null
  body: Buffer
  byteCount: number
  sha256: string
  retrievedAt: string
  redirects: number
  transport: "https" | "http"
}

export interface FetchFailure {
  ok: false
  requestedUrl: string
  finalUrl: string | null
  outcome: SourceOutcome
  message: string
  status: number | null
  /** Worth trying again later (rate limits, outages, timeouts). */
  retryable: boolean
  retryAfterMs: number | null
  retrievedAt: string
}

export type FetchResult = FetchedPage | FetchFailure

/** Thrown when the caller's signal aborts (cancellation, lost lease, shutdown). */
export class FetchCancelled extends Error {}

interface Raw {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer | null
  bytes: number
}

class Refused extends Error {
  constructor(
    readonly outcome: SourceOutcome,
    message: string,
    readonly retryable = false,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
  }
}

export function parseRetryAfter(
  value: string | string[] | undefined,
  now = Date.now(),
): number | null {
  const v = Array.isArray(value) ? value[0] : value
  if (!v) return null
  if (/^\d{1,7}$/.test(v.trim())) return Number(v.trim()) * 1000
  const at = Date.parse(v)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

function contentTypeOf(headers: http.IncomingHttpHeaders) {
  const raw = (headers["content-type"] ?? "").toString()
  const [type, ...params] = raw.split(";")
  const charset = params
    .map((p) => p.trim().split("="))
    .find(([k]) => k?.toLowerCase() === "charset")?.[1]
  return {
    type: type.trim().toLowerCase(),
    charset: charset
      ? charset.replace(/^"|"$/g, "").trim().toLowerCase()
      : null,
  }
}

export class ScoutFetcher {
  private readonly robotsCache = new Map<
    string,
    { at: number; policy: RobotsPolicy | null; failure: Refused | null }
  >()
  private readonly nextSlot = new Map<string, number>()

  constructor(
    private readonly network: NetworkDeps = realNetwork,
    private readonly limits: FetchLimits = DEFAULT_FETCH_LIMITS,
    private readonly userAgent = SCOUT_USER_AGENT,
    private readonly robotsTtlMs = 30 * 60_000,
  ) {}

  /** Fetches one page for research. Never throws except FetchCancelled. */
  async fetchPage(rawUrl: string, signal: AbortSignal): Promise<FetchResult> {
    const fail = (
      e: Refused,
      finalUrl: string | null = null,
    ): FetchFailure => ({
      ok: false,
      requestedUrl: rawUrl,
      finalUrl,
      outcome: e.outcome,
      message: e.message,
      status: e.status,
      retryable: e.retryable,
      retryAfterMs: e.retryAfterMs,
      retrievedAt: new Date().toISOString(),
    })
    let checked = checkSourceUrl(rawUrl)
    if (!checked.ok)
      return fail(
        new Refused(
          checked.problem === "ip_literal" || checked.problem === "local_name"
            ? "blocked_address"
            : "invalid_url",
          checked.message,
        ),
      )
    const startedHttps = checked.url.protocol === "https:"
    let current = checked
    try {
      for (let hop = 0; ; hop++) {
        await this.checkRobots(current.url, signal)
        const raw = await this.request(current, signal, {
          accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5",
          maxBytes: this.limits.maxPageBytes,
          types: PAGE_TYPES,
        })
        if (raw.status >= 300 && raw.status < 400 && raw.status !== 304) {
          const location = raw.headers.location
          if (!location)
            throw new Refused(
              "redirect_refused",
              `The page redirects (HTTP ${raw.status}) without saying where to.`,
              false,
              raw.status,
            )
          if (hop >= this.limits.maxRedirects)
            throw new Refused(
              "too_many_redirects",
              `More than ${this.limits.maxRedirects} redirects.`,
              false,
              raw.status,
            )
          let next: URL
          try {
            next = new URL(location, current.url)
          } catch {
            throw new Refused(
              "redirect_refused",
              "The page redirects to an invalid address.",
            )
          }
          checked = checkSourceUrl(next.href)
          if (!checked.ok)
            throw new Refused(
              checked.problem === "ip_literal" ||
                checked.problem === "local_name"
                ? "blocked_address"
                : "redirect_refused",
              `The page redirects somewhere Scout won't go: ${checked.message}`,
            )
          if (startedHttps && next.protocol === "http:")
            throw new Refused(
              "redirect_refused",
              "The page redirects from https to insecure http.",
            )
          current = checked
          continue
        }
        this.statusProblem(raw)
        const { type, charset } = contentTypeOf(raw.headers)
        return {
          ok: true,
          requestedUrl: rawUrl,
          finalUrl: current.href,
          status: raw.status,
          contentType: type,
          charset,
          body: raw.body!,
          byteCount: raw.bytes,
          sha256: createHash("sha256").update(raw.body!).digest("hex"),
          retrievedAt: new Date().toISOString(),
          redirects: hop,
          transport: current.url.protocol === "https:" ? "https" : "http",
        }
      }
    } catch (error) {
      if (error instanceof FetchCancelled) throw error
      if (error instanceof Refused) return fail(error, current.href)
      return fail(
        new Refused("network_error", "The site couldn't be reached.", true),
        current.href,
      )
    }
  }

  /** Maps an HTTP status to a source outcome (throws Refused) or returns for 200/203. */
  private statusProblem(raw: Raw) {
    const s = raw.status
    if (s === 200 || s === 203) return
    const retryAfter = parseRetryAfter(raw.headers["retry-after"])
    if (s === 401 || s === 407)
      throw new Refused("login_required", "The page needs a login.", false, s)
    if (s === 402)
      throw new Refused("paywall", "The page is behind a paywall.", false, s)
    if (s === 403 || s === 451)
      throw new Refused(
        "forbidden",
        `The site refused access (HTTP ${s}).`,
        false,
        s,
      )
    if (s === 404 || s === 410)
      throw new Refused(
        "not_found",
        `The page doesn't exist (HTTP ${s}).`,
        false,
        s,
      )
    if (s === 429)
      throw new Refused(
        "rate_limited",
        "The site asked Scout to slow down (HTTP 429).",
        true,
        s,
        retryAfter,
      )
    if (s >= 500)
      throw new Refused(
        "server_error",
        `The site had a problem (HTTP ${s}).`,
        true,
        s,
        retryAfter,
      )
    throw new Refused(
      "http_error",
      `Unexpected response (HTTP ${s}).`,
      false,
      s,
    )
  }

  /** robots.txt for the URL's origin (cached), or Refused. */
  private async checkRobots(url: URL, signal: AbortSignal) {
    const origin = url.origin
    let entry = this.robotsCache.get(origin)
    if (!entry || Date.now() - entry.at > this.robotsTtlMs) {
      entry = { at: Date.now(), ...(await this.loadRobots(url, signal)) }
      this.robotsCache.set(origin, entry)
    }
    if (entry.failure) throw entry.failure
    if (entry.policy && !robotsAllows(entry.policy, url.pathname + url.search))
      throw new Refused(
        "robots_disallowed",
        "The site's robots.txt doesn't allow automated access to this page.",
      )
  }

  private async loadRobots(
    pageUrl: URL,
    signal: AbortSignal,
  ): Promise<{ policy: RobotsPolicy | null; failure: Refused | null }> {
    let target = checkSourceUrl(new URL("/robots.txt", pageUrl.origin).href)
    for (let hop = 0; hop <= this.limits.maxRedirects; hop++) {
      if (!target.ok)
        return {
          policy: null,
          failure: new Refused(
            "robots_unavailable",
            "robots.txt redirects somewhere Scout won't go, so permission couldn't be confirmed.",
          ),
        }
      let raw: Raw
      try {
        raw = await this.request(target, signal, {
          accept: "text/plain,*/*;q=0.1",
          maxBytes: ROBOTS_MAX_BYTES,
          types: null,
        })
      } catch (error) {
        if (error instanceof FetchCancelled) throw error
        if (error instanceof Refused && error.outcome === "too_large")
          return { policy: parseRobots(""), failure: null }
        // The site itself can't be reached safely: report that, not robots.
        if (
          error instanceof Refused &&
          [
            "dns_failed",
            "blocked_address",
            "timeout",
            "network_error",
          ].includes(error.outcome)
        )
          return { policy: null, failure: error }
        return {
          policy: null,
          failure: new Refused(
            "robots_unavailable",
            `robots.txt couldn't be read (${error instanceof Refused ? error.message.replace(/\.$/, "") : "network error"}), so permission couldn't be confirmed.`,
            !(error instanceof Refused) || error.retryable,
          ),
        }
      }
      const s = raw.status
      if (s >= 300 && s < 400 && raw.headers.location) {
        try {
          target = checkSourceUrl(
            new URL(raw.headers.location, target.url).href,
          )
        } catch {
          target = { ok: false, problem: "invalid", message: "" }
        }
        continue
      }
      if (s >= 200 && s < 300)
        return {
          policy: parseRobots((raw.body ?? Buffer.alloc(0)).toString("utf8")),
          failure: null,
        }
      if (s === 401 || s === 403)
        return {
          policy: null,
          failure: new Refused(
            "robots_disallowed",
            `The site refuses robots.txt (HTTP ${s}); Scout treats that as no permission.`,
          ),
        }
      if (s === 429 || s >= 500)
        return {
          policy: null,
          failure: new Refused(
            "robots_unavailable",
            `robots.txt is temporarily unavailable (HTTP ${s}), so permission couldn't be confirmed.`,
            true,
            s,
            parseRetryAfter(raw.headers["retry-after"]),
          ),
        }
      // Other 4xx (404, 410…): no robots.txt, so no restrictions (RFC 9309).
      return { policy: parseRobots(""), failure: null }
    }
    return {
      policy: null,
      failure: new Refused(
        "robots_unavailable",
        "robots.txt redirects too many times, so permission couldn't be confirmed.",
      ),
    }
  }

  /** Waits for this host's next request slot (polite pacing). */
  private async pace(host: string, signal: AbortSignal) {
    const now = Date.now()
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0)
    this.nextSlot.set(host, slot + this.limits.hostIntervalMs)
    if (slot > now)
      try {
        await sleep(slot - now, undefined, { signal })
      } catch {
        throw new FetchCancelled("cancelled")
      }
  }

  /** One validated request. 3xx responses are returned without a body. */
  private async request(
    target: Extract<ReturnType<typeof checkSourceUrl>, { ok: true }>,
    signal: AbortSignal,
    opts: { accept: string; maxBytes: number; types: string[] | null },
  ): Promise<Raw> {
    if (signal.aborted) throw new FetchCancelled("cancelled")
    await this.pace(target.host, signal)
    const timeout = AbortSignal.timeout(this.limits.requestTimeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    let addresses: string[]
    try {
      addresses = await this.network.resolve(target.host, combined)
    } catch {
      if (signal.aborted) throw new FetchCancelled("cancelled")
      if (timeout.aborted)
        throw new Refused("timeout", "Looking up the site timed out.", true)
      throw new Refused(
        "dns_failed",
        "The site's name couldn't be found (DNS).",
        false,
      )
    }
    if (addresses.length === 0)
      throw new Refused(
        "dns_failed",
        "The site's name couldn't be found (DNS).",
      )
    for (const address of addresses) {
      const verdict = classifyAddress(address)
      if (!verdict.public)
        throw new Refused(
          "blocked_address",
          `The site's name points at ${verdict.reason}, which Scout never contacts.`,
        )
    }
    const address = addresses.find((a) => net.isIPv4(a)) ?? addresses[0]
    const secure = target.url.protocol === "https:"

    return new Promise<Raw>((resolve, reject) => {
      // Assigned once the request exists; finish() may run before that.
      const pending: { req?: http.ClientRequest } = {}
      let settled = false
      const finish = (error: Error | null, value?: Raw) => {
        if (settled) return
        settled = true
        clearTimeout(connectTimer)
        combined.removeEventListener("abort", onAbort)
        if (error) {
          pending.req?.destroy()
          reject(error)
        } else resolve(value!)
      }
      const onAbort = () =>
        finish(
          signal.aborted
            ? new FetchCancelled("cancelled")
            : new Refused(
                "timeout",
                "The site took too long to respond.",
                true,
              ),
        )
      combined.addEventListener("abort", onAbort, { once: true })

      let connectTimer: ReturnType<typeof setTimeout> | undefined
      const createConnection = () => {
        const raw = this.network.dial(address, target.port)
        connectTimer = setTimeout(
          () =>
            finish(
              new Refused("timeout", "Connecting to the site timed out.", true),
            ),
          this.limits.connectTimeoutMs,
        )
        raw.once("connect", () => clearTimeout(connectTimer))
        if (!secure) return raw
        return (this.network.secure ?? verifiedTls)(raw, target.host)
      }
      const options: http.RequestOptions = {
        method: "GET",
        host: target.host,
        port: target.port,
        path: `${target.url.pathname}${target.url.search}`,
        headers: {
          Host: target.url.host,
          "User-Agent": this.userAgent,
          Accept: opts.accept,
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "en;q=1, *;q=0.5",
          Connection: "close",
        },
        createConnection:
          createConnection as unknown as http.RequestOptions["createConnection"],
        maxHeaderSize: 32 * 1024,
      }
      const req = (secure ? https : http).request(options, (response) => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400) {
          response.resume()
          return finish(null, {
            status,
            headers: response.headers,
            body: null,
            bytes: 0,
          })
        }
        if (status !== 200 && status !== 203) {
          response.resume()
          return finish(null, {
            status,
            headers: response.headers,
            body: null,
            bytes: 0,
          })
        }
        // Record why first, then tear the streams down (destroying emits
        // "aborted"/"error", which must not overwrite the real reason).
        let stream: NodeJS.ReadableStream = response
        const refuse = (error: Refused) => {
          finish(error)
          ;(
            stream as NodeJS.ReadableStream & { destroy?: () => void }
          ).destroy?.()
          response.destroy()
        }
        const { type } = contentTypeOf(response.headers)
        if (opts.types && !opts.types.includes(type)) {
          return refuse(
            new Refused(
              "unsupported_type",
              type
                ? `Scout reads web pages and plain text, not ${type}.`
                : "The site didn't say what kind of content it sent.",
              false,
              status,
            ),
          )
        }
        const declared = Number(response.headers["content-length"])
        if (Number.isFinite(declared) && declared > opts.maxBytes) {
          return refuse(
            new Refused(
              "too_large",
              `The page is larger than Scout's ${Math.round(opts.maxBytes / 1024)} KB limit.`,
              false,
              status,
            ),
          )
        }
        const encoding = (response.headers["content-encoding"] ?? "identity")
          .toString()
          .trim()
          .toLowerCase()
        if (encoding === "gzip" || encoding === "x-gzip")
          stream = response.pipe(zlib.createGunzip())
        else if (encoding === "deflate")
          stream = response.pipe(zlib.createInflate())
        else if (encoding === "br")
          stream = response.pipe(zlib.createBrotliDecompress())
        else if (encoding !== "identity" && encoding !== "") {
          return refuse(
            new Refused(
              "unsupported_type",
              `The page uses an unsupported encoding (${encoding}).`,
              false,
              status,
            ),
          )
        }
        const chunks: Buffer[] = []
        let bytes = 0
        stream.on("data", (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > opts.maxBytes) {
            return refuse(
              new Refused(
                "too_large",
                `The page is larger than Scout's ${Math.round(opts.maxBytes / 1024)} KB limit.`,
                false,
                status,
              ),
            )
          }
          chunks.push(chunk)
        })
        stream.on("end", () =>
          finish(null, {
            status,
            headers: response.headers,
            body: Buffer.concat(chunks),
            bytes,
          }),
        )
        stream.on("error", () =>
          finish(
            new Refused(
              "network_error",
              "The page couldn't be read completely.",
              true,
              status,
            ),
          ),
        )
        response.on("aborted", () =>
          finish(
            new Refused(
              "network_error",
              "The connection closed before the page finished.",
              true,
              status,
            ),
          ),
        )
      })
      pending.req = req
      req.on("error", (error: NodeJS.ErrnoException) => {
        const code = error.code ?? ""
        finish(
          code.startsWith("ERR_TLS") ||
            code.includes("CERT") ||
            /certificate|SSL|TLS/i.test(error.message)
            ? new Refused(
                "network_error",
                "The site's secure connection (TLS certificate) couldn't be verified.",
                false,
              )
            : new Refused(
                "network_error",
                "The site couldn't be reached.",
                true,
              ),
        )
      })
      req.end()
    })
  }
}
