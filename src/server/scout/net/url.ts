import net from "node:net"

import { classifyAddress } from "@/server/scout/net/address"

/**
 * Which URLs Scout may request at all (DV-005A), checked before any DNS
 * lookup and again for every redirect hop:
 * - http: or https: only (no file:, ftp:, data:, gopher:…);
 * - no user name or password in the URL;
 * - the scheme's default port only (80 / 443), so no arbitrary ports;
 * - a DNS host name, never a numeric address (the WHATWG parser already
 *   turns "2130706433", "0x7f.1" and "[::ffff:7f00:1]" into IP literals,
 *   so alternate notations are caught here too);
 * - no single-label or local-only names (localhost, *.local, *.internal…).
 * Fragments are dropped (never sent).
 */

export type UrlProblem =
  "invalid" | "scheme" | "credentials" | "port" | "ip_literal" | "local_name"

export type SourceUrl =
  | {
      ok: true
      url: URL
      /** Lower-case host name without a trailing dot. */
      host: string
      port: 80 | 443
      href: string
    }
  | { ok: false; problem: UrlProblem; message: string }

const LOCAL_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "private",
  "home.arpa",
  "onion",
]

export function checkSourceUrl(raw: string): SourceUrl {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048)
    return {
      ok: false,
      problem: "invalid",
      message: "Not a usable web address.",
    }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return {
      ok: false,
      problem: "invalid",
      message: "Not a usable web address.",
    }
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return {
      ok: false,
      problem: "scheme",
      message: `Scout only reads http and https pages, not ${url.protocol.replace(":", "")} links.`,
    }
  if (url.username || url.password)
    return {
      ok: false,
      problem: "credentials",
      message:
        "The address contains a user name or password; Scout never sends credentials.",
    }
  if (url.port !== "")
    return {
      ok: false,
      problem: "port",
      message: `Scout only uses the standard web port, not port ${url.port}.`,
    }
  const host = url.hostname.toLowerCase().replace(/\.$/, "")
  const bare = host.replace(/^\[|\]$/g, "")
  if (net.isIP(bare)) {
    const verdict = classifyAddress(bare)
    return {
      ok: false,
      problem: "ip_literal",
      message: verdict.public
        ? "Use the site's name rather than a numeric address."
        : `The address points at ${verdict.reason}.`,
    }
  }
  if (!host.includes(".") || host.startsWith(".") || host.includes(".."))
    return {
      ok: false,
      problem: "local_name",
      message: "That host name only works on a local network.",
    }
  if (LOCAL_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`)))
    return {
      ok: false,
      problem: "local_name",
      message: "That host name only works on this computer or a local network.",
    }
  url.hash = ""
  url.hostname = host
  return {
    ok: true,
    url,
    host,
    port: url.protocol === "https:" ? 443 : 80,
    href: url.href,
  }
}

/** Same host and path, ignoring the query and a trailing slash. */
export function sameDestination(a: string, b: string) {
  const x = checkSourceUrl(a)
  const y = checkSourceUrl(b)
  if (!x.ok || !y.ok) return false
  const trim = (p: string) => p.replace(/\/+$/, "") || "/"
  return (
    x.host.replace(/^www\./, "") === y.host.replace(/^www\./, "") &&
    trim(x.url.pathname) === trim(y.url.pathname)
  )
}
