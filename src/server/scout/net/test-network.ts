import net from "node:net"

import type { NetworkDeps } from "@/server/scout/net/fetcher"

/**
 * TEST ONLY (DV-005A): a fake "internet" for Scout's fixture sites.
 *
 * Host names ending in ".example" resolve to a fake PUBLIC address, and
 * any connection the fetcher makes is delivered to the local fixture
 * server, which routes by Host header. Specific names can be made to
 * resolve to private/loopback addresses (to prove they are refused).
 *
 * Every production check still runs unchanged (URL rules, address
 * classification of what the resolver returns, robots.txt, redirects,
 * limits). Only the resolver, the socket's destination and the TLS layer
 * are swapped (fixture sites have no certificates; real TLS verification
 * is exercised by the live smoke test, yarn scout:smoke). The worker refuses to use this
 * unless the database is a guarded test database (testNetworkAllowed).
 */

export interface TestNetworkSpec {
  /** The fixture server's port on 127.0.0.1. */
  port: number
  /** Extra host → addresses (e.g. a name that resolves to 10.0.0.5). */
  hosts?: Record<string, string[]>
  /** Product-name substring whose first attempt is killed before commit. */
  crashBeforeCommit?: string
  /** Rebinding: these names resolve differently on the 2nd lookup. */
  rebind?: Record<string, [string[], string[]]>
}

export const FIXTURE_PUBLIC_ADDRESS = "93.184.216.34"

export function parseTestNetwork(raw: string): TestNetworkSpec {
  const spec = JSON.parse(raw) as TestNetworkSpec
  if (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535)
    throw new Error("DESKVERSE_SCOUT_TEST_NETWORK needs a port")
  return spec
}

export function testNetwork(spec: TestNetworkSpec): NetworkDeps & {
  lookups: string[]
  dials: string[]
} {
  const lookups: string[] = []
  const dials: string[] = []
  const seen = new Map<string, number>()
  return {
    lookups,
    dials,
    async resolve(host) {
      lookups.push(host)
      const n = (seen.get(host) ?? 0) + 1
      seen.set(host, n)
      const rebind = spec.rebind?.[host]
      if (rebind) return n === 1 ? rebind[0] : rebind[1]
      if (spec.hosts?.[host]) return spec.hosts[host]
      if (host.endsWith(".example")) return [FIXTURE_PUBLIC_ADDRESS]
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
        code: "ENOTFOUND",
      })
    },
    dial(address) {
      dials.push(address)
      return net.connect({ host: "127.0.0.1", port: spec.port })
    },
    // Fixture sites have no certificates: "https" is carried as plain HTTP.
    secure: (socket) => socket,
  }
}
