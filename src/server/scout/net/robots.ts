/**
 * robots.txt (RFC 9309) for Scout (DV-005A).
 *
 * Groups for Scout's product token ("DeskverseScout") apply if present,
 * otherwise the "*" groups. The most specific (longest) matching rule wins;
 * on a tie, Allow wins. "*" matches any run of characters and a trailing
 * "$" anchors the end. /robots.txt itself is always allowed.
 *
 * What happens when robots.txt can't be read is decided by the fetcher:
 * 404/410 and similar → no restrictions (as the RFC says); 401/403 →
 * treated as a full disallow; 429, 5xx, timeouts and network errors →
 * "permission unknown" → Scout fails closed and doesn't fetch the page.
 */

export const ROBOTS_TOKEN = "DeskverseScout"
/** RFC 9309 requires parsing at least 500 KiB. */
export const ROBOTS_MAX_BYTES = 512 * 1024

interface Rule {
  allow: boolean
  pattern: string
}

export interface RobotsPolicy {
  /** Rules that apply to Scout (its own group, else "*"). */
  rules: Rule[]
  /** Which group applied: "scout", "*" or "none". */
  group: "scout" | "*" | "none"
}

export function parseRobots(text: string, token = ROBOTS_TOKEN): RobotsPolicy {
  const own: Rule[] = []
  const star: Rule[] = []
  let ownFound = false
  let starFound = false
  let agents: string[] = []
  let inRules = false
  for (const rawLine of text.slice(0, ROBOTS_MAX_BYTES).split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim()
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (key === "user-agent") {
      if (inRules) {
        agents = []
        inRules = false
      }
      agents.push(value.split("/")[0].trim().toLowerCase())
      continue
    }
    if (key !== "allow" && key !== "disallow") continue
    inRules = true
    if (agents.length === 0) continue
    const forOwn = agents.includes(token.toLowerCase())
    const forStar = agents.includes("*")
    if (forOwn) ownFound = true
    if (forStar) starFound = true
    if (value === "") continue // "Disallow:" with no path allows everything
    const rule = { allow: key === "allow", pattern: value }
    if (forOwn) own.push(rule)
    if (forStar) star.push(rule)
  }
  if (ownFound) return { rules: own, group: "scout" }
  if (starFound) return { rules: star, group: "*" }
  return { rules: [], group: "none" }
}

function patternMatches(pattern: string, path: string) {
  const anchored = pattern.endsWith("$")
  const body = anchored ? pattern.slice(0, -1) : pattern
  const regex = new RegExp(
    `^${body
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}${anchored ? "$" : ""}`,
  )
  return regex.test(path)
}

/** Normalises percent-encoding so "/a%2db" and "/a-b" compare as the RFC asks. */
function normalisePath(path: string) {
  return path.replace(/%([0-9a-fA-F]{2})/g, (m, h: string) => {
    const c = String.fromCharCode(parseInt(h, 16))
    return /[A-Za-z0-9\-._~]/.test(c) ? c : m.toUpperCase()
  })
}

/** Whether Scout may fetch `pathAndQuery` (e.g. "/p/123?x=1"). */
export function robotsAllows(policy: RobotsPolicy, pathAndQuery: string) {
  const path = normalisePath(pathAndQuery || "/")
  if (path === "/robots.txt") return true
  let best: Rule | null = null
  for (const rule of policy.rules) {
    const pattern = normalisePath(rule.pattern)
    if (!patternMatches(pattern, path)) continue
    if (
      !best ||
      pattern.length > best.pattern.length ||
      (pattern.length === best.pattern.length && rule.allow && !best.allow)
    )
      best = { allow: rule.allow, pattern }
  }
  return best ? best.allow : true
}
