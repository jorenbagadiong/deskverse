import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  startFixtureSites,
  type FixtureSites,
} from "../scripts/scout/fixture-sites"
import { classifyAddress, parseIPv6 } from "@/server/scout/net/address"
import {
  DEFAULT_FETCH_LIMITS,
  FetchCancelled,
  parseRetryAfter,
  realNetwork,
  SCOUT_USER_AGENT,
  ScoutFetcher,
} from "@/server/scout/net/fetcher"
import { parseRobots, robotsAllows } from "@/server/scout/net/robots"
import {
  FIXTURE_PUBLIC_ADDRESS,
  testNetwork,
  type TestNetworkSpec,
} from "@/server/scout/net/test-network"
import { checkSourceUrl, sameDestination } from "@/server/scout/net/url"

/**
 * DV-005A: Scout's retrieval security (SSRF), against the OWASP SSRF
 * Prevention Cheat Sheet: scheme/port/credential rules, address
 * classification (IPv4, IPv6, mapped forms), DNS rebinding, redirects,
 * size/type/time limits, robots.txt and cancellation. Pages come from
 * local fixture sites through the injected test network; every
 * production check runs unchanged.
 */

describe("address classification", () => {
  it.each([
    "127.0.0.1",
    "127.10.20.30",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.100.100.200",
    "192.0.0.170",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:8.8.8.8",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "2001::1",
    "fec0::1",
    "fe80::1%eth0",
    "not-an-ip",
  ])("refuses %s", (address) => {
    const verdict = classifyAddress(address)
    expect(verdict.public).toBe(false)
    expect(verdict.reason).toBeTruthy()
  })

  it.each([
    "8.8.8.8",
    "93.184.216.34",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "2a00:1450:4001::200e",
  ])("allows public %s", (address) =>
    expect(classifyAddress(address)).toEqual({ public: true, reason: null }),
  )

  it("parses IPv6 forms strictly", () => {
    expect(parseIPv6("::ffff:1.2.3.4")?.slice(10)).toEqual([
      0xff, 0xff, 1, 2, 3, 4,
    ])
    expect(parseIPv6("1::2::3")).toBeNull()
    expect(parseIPv6("12345::")).toBeNull()
  })
})

describe("source URL rules", () => {
  it.each([
    ["file:///etc/passwd", "scheme"],
    ["ftp://files.example.com/a", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["data:text/html,hi", "scheme"],
    ["gopher://example.com/", "scheme"],
    ["https://user:pass@shop.example.com/", "credentials"],
    ["https://token@shop.example.com/", "credentials"],
    ["https://shop.example.com:8443/", "port"],
    ["http://shop.example.com:22/", "port"],
    ["http://127.0.0.1/", "ip_literal"],
    ["http://2130706433/", "ip_literal"],
    ["http://0x7f.0.0.1/", "ip_literal"],
    ["http://0177.0.0.1/", "ip_literal"],
    ["http://127.1/", "ip_literal"],
    ["http://[::1]/", "ip_literal"],
    ["http://[::ffff:127.0.0.1]/", "ip_literal"],
    ["http://169.254.169.254/latest/meta-data/", "ip_literal"],
    ["http://8.8.8.8/", "ip_literal"],
    ["http://localhost/", "local_name"],
    ["http://LOCALHOST./", "local_name"],
    ["http://app.localhost/", "local_name"],
    ["http://printer.local/", "local_name"],
    ["http://intranet/", "local_name"],
    ["http://db.internal/", "local_name"],
    ["http://router.home.arpa/", "local_name"],
    ["not a url", "invalid"],
  ])("refuses %s (%s)", (url, problem) => {
    const r = checkSourceUrl(url)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problem).toBe(problem)
  })

  it("accepts public http(s) pages and drops the fragment", () => {
    const r = checkSourceUrl("https://Shop.Example.com:443/p/1?x=2#reviews")
    expect(r.ok && r.href).toBe("https://shop.example.com/p/1?x=2")
    expect(r.ok && r.port).toBe(443)
  })

  it("compares destinations by host and path", () => {
    expect(
      sameDestination(
        "https://www.shop.example.com/p/1/",
        "https://shop.example.com/p/1?ref=x",
      ),
    ).toBe(true)
    expect(
      sameDestination(
        "https://shop.example.com/p/1",
        "https://shop.example.com/p/2",
      ),
    ).toBe(false)
  })
})

describe("robots.txt", () => {
  it("prefers Scout's own group, then *, longest match wins and Allow wins ties", () => {
    const policy = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: DeskverseScout\nDisallow: /private\nAllow: /private/specs$\nDisallow: /*.pdf$\n",
    )
    expect(policy.group).toBe("scout")
    expect(robotsAllows(policy, "/products/1")).toBe(true)
    expect(robotsAllows(policy, "/private/x")).toBe(false)
    expect(robotsAllows(policy, "/private/specs")).toBe(true)
    expect(robotsAllows(policy, "/manual.pdf")).toBe(false)
    expect(robotsAllows(policy, "/robots.txt")).toBe(true)
  })

  it("falls back to * and treats an empty Disallow as allow-all", () => {
    expect(
      robotsAllows(parseRobots("User-agent: *\nDisallow: /cart\n"), "/cart/1"),
    ).toBe(false)
    expect(
      robotsAllows(parseRobots("User-agent: *\nDisallow:\n"), "/anything"),
    ).toBe(true)
    expect(parseRobots("User-agent: Googlebot\nDisallow: /\n").group).toBe(
      "none",
    )
  })

  it("normalises percent-encoding", () => {
    expect(
      robotsAllows(parseRobots("User-agent: *\nDisallow: /a-b\n"), "/a%2db"),
    ).toBe(false)
  })
})

describe("Retry-After", () => {
  it("reads seconds and dates", () => {
    expect(parseRetryAfter("120")).toBe(120_000)
    expect(
      parseRetryAfter(new Date(Date.now() + 5_000).toUTCString(), Date.now()),
    ).toBeGreaterThan(3_000)
    expect(parseRetryAfter("soon")).toBeNull()
  })
})

describe("safe fetcher (fixture sites, injected network)", () => {
  let sites: FixtureSites
  beforeAll(async () => {
    sites = await startFixtureSites({ hang: ["hang.example"] })
  })
  afterAll(() => sites.close())

  const fetcher = (spec: Partial<TestNetworkSpec> = {}, limits = {}) => {
    const network = testNetwork({ port: sites.port, ...spec })
    return {
      network,
      fetcher: new ScoutFetcher(network, {
        ...DEFAULT_FETCH_LIMITS,
        hostIntervalMs: 0,
        requestTimeoutMs: 3_000,
        ...limits,
      }),
    }
  }
  const signal = () => new AbortController().signal

  it("reads an allowed page and records its checksum and final URL", async () => {
    const { fetcher: f } = fetcher()
    const r = await f.fetchPage("https://acme.example/kettles/k200", signal())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.finalUrl).toBe("https://acme.example/kettles/k200")
    expect(r.contentType).toBe("text/html")
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.transport).toBe("https")
  })

  it("sends only fixed headers: no cookies, credentials, referrer or environment values", async () => {
    process.env.SCOUT_TEST_SECRET = "s3cr3t-value"
    const { fetcher: f } = fetcher()
    await f.fetchPage("https://norobots.example/page", signal())
    const sent = sites.requests.filter((r) => r.host === "norobots.example")
    expect(sent.length).toBeGreaterThan(0)
    for (const r of sent) {
      expect(r.headers["user-agent"]).toBe(SCOUT_USER_AGENT)
      expect(r.headers.cookie).toBeUndefined()
      expect(r.headers.authorization).toBeUndefined()
      expect(r.headers.referer).toBeUndefined()
      expect(JSON.stringify(r.headers)).not.toContain("s3cr3t-value")
      expect(Object.keys(r.headers).sort()).toEqual(
        [
          "accept",
          "accept-encoding",
          "accept-language",
          "connection",
          "host",
          "user-agent",
        ].sort(),
      )
    }
    delete process.env.SCOUT_TEST_SECRET
  })

  it.each([
    ["https://redirect.example/to-loopback", "blocked_address"],
    ["https://redirect.example/to-local-name", "blocked_address"],
    ["https://redirect.example/to-metadata", "blocked_address"],
    ["https://redirect.example/to-private-dns", "blocked_address"],
    ["https://redirect.example/downgrade", "redirect_refused"],
    ["https://redirect.example/to-port", "redirect_refused"],
    ["https://redirect.example/to-file", "redirect_refused"],
    ["https://redirect.example/loop", "too_many_redirects"],
    ["https://redirect.example/chain0", "too_many_redirects"],
    ["https://redirect.example/no-location", "redirect_refused"],
  ])("refuses the redirect %s (%s)", async (url, outcome) => {
    const { fetcher: f, network } = fetcher({
      hosts: { "private-dns.example": ["10.0.0.5"] },
    })
    const r = await f.fetchPage(url, signal())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.outcome).toBe(outcome)
    // Nothing was ever dialled except the validated fixture address.
    expect(new Set(network.dials)).toEqual(new Set([FIXTURE_PUBLIC_ADDRESS]))
  })

  it("follows a short redirect chain, re-validating every hop", async () => {
    const { fetcher: f, network } = fetcher()
    const r = await f.fetchPage("https://redirect.example/chain1", signal())
    expect(r.ok && r.finalUrl).toBe("https://acme.example/kettles/k200")
    expect(r.ok && r.redirects).toBe(2)
    expect(network.lookups).toEqual(
      expect.arrayContaining(["redirect.example", "acme.example"]),
    )
  })

  it("refuses a public name that resolves to a private address (any of them)", async () => {
    for (const addresses of [
      ["10.0.0.5"],
      ["127.0.0.1"],
      ["93.184.216.34", "192.168.0.10"],
      ["::ffff:127.0.0.1"],
      ["fd00::1"],
    ]) {
      const { fetcher: f, network } = fetcher({
        hosts: { "evil.example": addresses },
      })
      const r = await f.fetchPage("https://evil.example/page", signal())
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.outcome).toBe("blocked_address")
      expect(network.dials).toEqual([])
    }
  })

  it("defeats DNS rebinding: every connection uses the address it validated", async () => {
    // First lookup (robots.txt) is public, the second (the page) is loopback.
    const { fetcher: f, network } = fetcher({
      rebind: { "rebind.example": [[FIXTURE_PUBLIC_ADDRESS], ["127.0.0.1"]] },
    })
    const r = await f.fetchPage("https://rebind.example/page", signal())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.outcome).toBe("blocked_address")
    expect(network.lookups.filter((h) => h === "rebind.example")).toHaveLength(
      2,
    )
    expect(network.dials).toEqual([FIXTURE_PUBLIC_ADDRESS])
  })

  it("checks the connected peer address in the real network dialler", async () => {
    // realNetwork.dial destroys a socket whose peer differs from the validated address.
    const s = realNetwork.dial("127.0.0.1", sites.port)
    await new Promise<void>((resolve) =>
      s.once("connect", () => resolve()).once("error", () => resolve()),
    )
    expect(s.destroyed).toBe(false)
    s.destroy()
  })

  it.each([
    ["https://big.example/chunked", "too_large"],
    ["https://big.example/declared", "too_large"],
    ["https://big.example/gzip-bomb", "too_large"],
    ["https://pdf.example/manual.pdf", "unsupported_type"],
    ["https://forbidden.example/lamp-l5", "forbidden"],
    ["https://shop.example/nothing-here", "not_found"],
    ["https://blocked.example/lamp-l5", "robots_disallowed"],
    ["https://robots5xx.example/page", "robots_unavailable"],
    ["https://scoutonly.example/private", "robots_disallowed"],
    ["https://unknown-host.test/page", "dns_failed"],
  ])("fails closed on %s (%s)", async (url, outcome) => {
    const { fetcher: f } = fetcher()
    const r = await f.fetchPage(url, signal())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.outcome).toBe(outcome)
  })

  it("never transfers more than the page limit", async () => {
    const { fetcher: f } = fetcher({}, { maxPageBytes: 256 * 1024 })
    const r = await f.fetchPage("https://big.example/chunked", signal())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/256 KB/)
  })

  it("honours Scout's own robots group and missing robots.txt", async () => {
    const { fetcher: f } = fetcher()
    expect(
      (await f.fetchPage("https://scoutonly.example/public", signal())).ok,
    ).toBe(true)
    expect(
      (await f.fetchPage("https://norobots.example/page", signal())).ok,
    ).toBe(true)
  })

  it("reports rate limits and outages as retryable, with Retry-After", async () => {
    const { fetcher: f } = fetcher()
    const limited = await f.fetchPage(
      "https://ratelimit.example/page",
      signal(),
    )
    expect(limited).toMatchObject({
      ok: false,
      outcome: "rate_limited",
      retryable: true,
      retryAfterMs: 120_000,
    })
    const down = await f.fetchPage("https://down.example/page", signal())
    expect(down).toMatchObject({
      ok: false,
      outcome: "server_error",
      retryable: true,
    })
  })

  it("times out a site that never answers", async () => {
    const { fetcher: f } = fetcher({}, { requestTimeoutMs: 400 })
    const started = Date.now()
    const r = await f.fetchPage("https://hang.example/page", signal())
    expect(r).toMatchObject({ ok: false, outcome: "timeout", retryable: true })
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it("stops promptly when cancelled mid-request", async () => {
    const { fetcher: f } = fetcher({}, { requestTimeoutMs: 10_000 })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const started = Date.now()
    await expect(
      f.fetchPage("https://hang.example/page", controller.signal),
    ).rejects.toBeInstanceOf(FetchCancelled)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("reads plain text sources", async () => {
    const { fetcher: f } = fetcher()
    const r = await f.fetchPage("https://text.example/specs.txt", signal())
    expect(r.ok && r.contentType).toBe("text/plain")
  })

  it("paces requests to one host", async () => {
    const { fetcher: f } = fetcher({}, { hostIntervalMs: 300 })
    const started = Date.now()
    await f.fetchPage("https://norobots.example/page", signal()) // robots + page
    await f.fetchPage("https://norobots.example/page", signal()) // page (robots cached)
    expect(Date.now() - started).toBeGreaterThanOrEqual(550)
  })
})
