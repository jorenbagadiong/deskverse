import net from "node:net"

/**
 * Public/non-public IP address classification for Scout's retrieval
 * (DV-005A). Scout may only connect to globally routable unicast
 * addresses. Everything else (loopback, private, link-local, cloud
 * metadata, carrier-grade NAT, documentation, benchmarking, multicast,
 * reserved, IPv4-mapped/compatible/translated IPv6…) is refused.
 *
 * IPv4 uses a deny-list of the IANA special-purpose ranges. IPv6 uses an
 * allow-list (only 2000::/3 global unicast) minus the special ranges inside
 * it, so new or exotic forms fail closed.
 */

export interface AddressVerdict {
  public: boolean
  /** Why it isn't public (shown to the owner in source records). */
  reason: string | null
}

type Range = [bytes: number[], prefix: number, reason: string]

const v4 = (a: string, prefix: number, reason: string): Range => [
  a.split(".").map(Number),
  prefix,
  reason,
]

const IPV4_DENY: Range[] = [
  v4("0.0.0.0", 8, "an unspecified (“this network”) address"),
  v4("10.0.0.0", 8, "a private network address"),
  v4("100.64.0.0", 10, "a carrier-grade NAT address"),
  v4("127.0.0.0", 8, "a loopback (this computer) address"),
  v4("169.254.0.0", 16, "a link-local or cloud metadata address"),
  v4("172.16.0.0", 12, "a private network address"),
  v4("192.0.0.0", 24, "an IETF protocol address"),
  v4("192.0.2.0", 24, "a documentation address"),
  v4("192.31.196.0", 24, "a reserved (AS112) address"),
  v4("192.52.193.0", 24, "a reserved (AMT) address"),
  v4("192.88.99.0", 24, "a reserved 6to4 relay address"),
  v4("192.168.0.0", 16, "a private network address"),
  v4("192.175.48.0", 24, "a reserved (AS112) address"),
  v4("198.18.0.0", 15, "a benchmarking address"),
  v4("198.51.100.0", 24, "a documentation address"),
  v4("203.0.113.0", 24, "a documentation address"),
  v4("224.0.0.0", 4, "a multicast address"),
  v4("240.0.0.0", 4, "a reserved or broadcast address"),
]

/** Strict dotted-quad parser (four decimal octets, no leading zeros). */
export function parseIPv4(text: string): number[] | null {
  const parts = text.split(".")
  if (parts.length !== 4) return null
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    bytes.push(n)
  }
  return bytes
}

/** RFC 4291 text form → 16 bytes. Refuses zone IDs ("%eth0"). */
export function parseIPv6(text: string): number[] | null {
  if (text.includes("%")) return null
  let head = text
  let tail4: number[] | null = null
  const lastColon = head.lastIndexOf(":")
  if (head.slice(lastColon + 1).includes(".")) {
    tail4 = parseIPv4(head.slice(lastColon + 1))
    if (!tail4) return null
    head = `${head.slice(0, lastColon + 1)}0:0`
  }
  const halves = head.split("::")
  if (halves.length > 2) return null
  const groups = (s: string) => (s === "" ? [] : s.split(":"))
  const left = groups(halves[0])
  const right = halves.length === 2 ? groups(halves[1]) : []
  const missing = 8 - left.length - right.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const all = [
    ...left,
    ...Array<string>(Math.max(missing, 0)).fill("0"),
    ...right,
  ]
  if (all.length !== 8) return null
  const bytes: number[] = []
  for (const g of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    const n = parseInt(g, 16)
    bytes.push(n >> 8, n & 0xff)
  }
  if (tail4) bytes.splice(12, 4, ...tail4)
  return bytes
}

function inRange(bytes: number[], base: number[], prefix: number) {
  for (let bit = 0; bit < prefix; bit++) {
    const i = bit >> 3
    const mask = 0x80 >> (bit & 7)
    if ((bytes[i] & mask) !== (base[i] & mask)) return false
  }
  return true
}

function classifyV4(bytes: number[]): AddressVerdict {
  for (const [base, prefix, reason] of IPV4_DENY)
    if (inRange(bytes, base, prefix)) return { public: false, reason }
  return { public: true, reason: null }
}

const hex = (s: string) => parseIPv6(s)!

const IPV6_DENY_INSIDE_GLOBAL: Range[] = [
  [hex("2001::"), 23, "an IETF protocol address (e.g. Teredo)"],
  [hex("2001:db8::"), 32, "a documentation address"],
  [hex("2002::"), 16, "a 6to4 address (it embeds an IPv4 address)"],
  [hex("3fff::"), 20, "a documentation address"],
]

function classifyV6(bytes: number[]): AddressVerdict {
  const zeroUntil = (n: number) => bytes.slice(0, n).every((b) => b === 0)
  if (zeroUntil(16)) return { public: false, reason: "an unspecified address" }
  if (zeroUntil(15) && bytes[15] === 1)
    return { public: false, reason: "a loopback (this computer) address" }
  if (zeroUntil(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    const inner = classifyV4(bytes.slice(12))
    return {
      public: false,
      reason: `an IPv4-mapped IPv6 address${inner.public ? "" : ` (${inner.reason})`}`,
    }
  }
  if (zeroUntil(12))
    return {
      public: false,
      reason: "an IPv4-compatible IPv6 address (deprecated)",
    }
  if (
    inRange(bytes, hex("64:ff9b::"), 96) ||
    inRange(bytes, hex("64:ff9b:1::"), 48)
  )
    return {
      public: false,
      reason: "a NAT64 address (it embeds an IPv4 address)",
    }
  if (inRange(bytes, hex("fc00::"), 7))
    return { public: false, reason: "a private (unique local) IPv6 address" }
  if (inRange(bytes, hex("fe80::"), 10))
    return { public: false, reason: "a link-local IPv6 address" }
  if (inRange(bytes, hex("fec0::"), 10))
    return { public: false, reason: "a site-local IPv6 address" }
  if (bytes[0] === 0xff) return { public: false, reason: "a multicast address" }
  if (!inRange(bytes, hex("2000::"), 3))
    return { public: false, reason: "a reserved IPv6 address" }
  for (const [base, prefix, reason] of IPV6_DENY_INSIDE_GLOBAL)
    if (inRange(bytes, base, prefix)) return { public: false, reason }
  return { public: true, reason: null }
}

/** Classifies a literal IP address. Anything unparseable is not public. */
export function classifyAddress(address: string): AddressVerdict {
  const bare = address.replace(/^\[|\]$/g, "")
  if (net.isIPv4(bare)) {
    const bytes = parseIPv4(bare)
    return bytes
      ? classifyV4(bytes)
      : { public: false, reason: "an unusual IPv4 notation" }
  }
  if (net.isIPv6(bare)) {
    const bytes = parseIPv6(bare)
    return bytes
      ? classifyV6(bytes)
      : { public: false, reason: "an unusual IPv6 notation" }
  }
  return { public: false, reason: "not an IP address" }
}

/** Canonical comparison form (so "::ffff:1.2.3.4" and its hex form compare equal). */
export function canonicalAddress(address: string): string | null {
  const bare = address.replace(/^\[|\]$/g, "")
  if (net.isIPv4(bare)) return parseIPv4(bare)?.join(".") ?? null
  const bytes = net.isIPv6(bare) ? parseIPv6(bare) : null
  if (!bytes) return null
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2)
    groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16))
  return groups.join(":")
}
