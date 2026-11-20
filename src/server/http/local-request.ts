import "server-only"

/**
 * Header-based check that a request comes from this computer's own browser.
 *
 * Stops the two realistic browser attacks against a local dev server:
 * - DNS rebinding: a web page on evil.example re-points its domain at
 *   127.0.0.1. The browser then sends `Host: evil.example`, which fails here.
 * - Cross-site requests: another site's page calling this endpoint sends a
 *   foreign `Origin` / `Sec-Fetch-Site: cross-site`, which fails here.
 *
 * Headers are client-controlled, so this does NOT stop a program on another
 * machine that can reach the port and forges every header. The network
 * boundary for that is binding the server to loopback:
 * `yarn dev -H 127.0.0.1` / `yarn start -H 127.0.0.1` (see the video docs).
 */

export type LocalRequestCheck =
  | { ok: true }
  | {
      ok: false
      reason:
        "host" | "forwarded-for" | "forwarded-host" | "origin" | "fetch-site"
    }

/** Accepts 127.0.0.0/8, ::1 and their IPv4-mapped IPv6 forms. */
export function isLoopbackAddress(raw: string) {
  const address = raw
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") return true
  const v4 = address.replace(/^::ffff:/, "")
  const parts = v4.split(".")
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  )
}

/** "localhost:3000" / "127.0.0.1" / "[::1]:3000" → is it this machine? */
export function isLoopbackHost(rawHost: string) {
  const host = rawHost.trim().toLowerCase()
  let hostname: string
  if (host.startsWith("[")) {
    const end = host.indexOf("]")
    if (end === -1) return false
    hostname = host.slice(1, end)
    const rest = host.slice(end + 1)
    if (rest !== "" && !/^:\d{1,5}$/.test(rest)) return false
  } else {
    const [name, port, ...extra] = host.split(":")
    if (extra.length > 0 || (port !== undefined && !/^\d{1,5}$/.test(port)))
      return false
    hostname = name
  }
  return hostname === "localhost" || isLoopbackAddress(hostname)
}

export function checkLocalRequest(headers: Headers): LocalRequestCheck {
  const host = headers.get("host")
  if (!host || !isLoopbackHost(host)) return { ok: false, reason: "host" }

  const forwardedHost = headers.get("x-forwarded-host")
  if (forwardedHost !== null && !isLoopbackHost(forwardedHost))
    return { ok: false, reason: "forwarded-host" }

  // Next.js fills this in from the socket when the client didn't send one.
  const forwardedFor = headers.get("x-forwarded-for")
  if (
    forwardedFor !== null &&
    !forwardedFor.split(",").every((part) => isLoopbackAddress(part))
  )
    return { ok: false, reason: "forwarded-for" }

  const origin = headers.get("origin")
  if (origin !== null) {
    let ok = false
    try {
      const url = new URL(origin)
      ok =
        (url.protocol === "http:" || url.protocol === "https:") &&
        isLoopbackHost(url.host)
    } catch {
      ok = false
    }
    if (!ok) return { ok: false, reason: "origin" }
  }

  const fetchSite = headers.get("sec-fetch-site")
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none")
    return { ok: false, reason: "fetch-site" }

  return { ok: true }
}
