import { parse, type DefaultTreeAdapterTypes } from "parse5"

import { extractJsonLd, type JsonLdResult } from "@/server/scout/extract/jsonld"

/**
 * Turns a retrieved page into bounded, attributable text (DV-005A).
 *
 * HTML is parsed with parse5 (a spec-compliant parser that never runs
 * scripts or loads anything). Script, style, template, SVG, iframes,
 * forms' controls, navigation and hidden elements are skipped; JSON-LD
 * script blocks are read as data only. The result is a list of short
 * passages (≤ 600 characters, each with a human-readable location) and
 * label/value facts from specification tables, definition lists and
 * "Label: value" lines. Nothing of the page is executed or rendered.
 */

type Node = DefaultTreeAdapterTypes.ChildNode
type Element = DefaultTreeAdapterTypes.Element

export type PassageKind =
  "heading" | "paragraph" | "list" | "row" | "term" | "text" | "line"

export interface Passage {
  text: string
  location: string
  kind: PassageKind
  /** Text addressed to AI systems ("ignore previous instructions"…). Never used as evidence. */
  suspicious: boolean
}

export interface TextFact {
  label: string
  value: string
  passage: number
  method: "html-table" | "html-list" | "html-text" | "text-plain"
}

export interface PageSignals {
  visibleChars: number
  scripts: number
  javascriptMessage: boolean
  captcha: boolean
  login: boolean
  paywall: boolean
  suspiciousPassages: number
}

export interface PageContent {
  title: string | null
  h1: string | null
  lang: string | null
  canonical: string | null
  meta: {
    description: string | null
    ogTitle: string | null
    siteName: string | null
  }
  jsonLd: JsonLdResult
  passages: Passage[]
  facts: TextFact[]
  signals: PageSignals
}

export const MAX_PASSAGE_CHARS = 600
const MAX_PASSAGES = 600

const SKIP = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "math",
  "iframe",
  "object",
  "embed",
  "canvas",
  "head",
  "nav",
  "button",
  "select",
  "option",
  "input",
  "textarea",
  "video",
  "audio",
  "picture",
  "img",
  "map",
])

const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "caption",
  "details",
  "dialog",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "hgroup",
  "hr",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "thead",
  "tfoot",
  "ul",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "body",
])

export const SUSPICIOUS =
  /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|above|earlier|all|system)\b[^.]{0,20}\b(instructions?|prompts?|rules)\b|\bsystem prompt\b|\byou are (now )?(an? )?(ai|assistant|language model|chatgpt|llm)\b|\bas an ai\b|\bdeveloper mode\b|\bjailbreak\b|\b(assistant|system)\s*:/i

const CAPTCHA =
  /\b(verify (that )?you are (a )?human|are you a (robot|human)|unusual traffic from your|complete the security check|captcha|bot (check|detection)|press (and|&) hold|checking your browser)\b/i
const JS_MESSAGE =
  /\b(enable|turn on|activate) javascript\b|\bjavascript (is )?(required|disabled|needed)\b|\byour browser does not support javascript\b/i
const PAYWALL =
  /\b(subscribe (now )?to (continue|read|keep reading|unlock)|this (article|content) is (only )?(for|available to) (paid )?subscribers|already a subscriber\?)/i
const LOGIN = /\b(sign in|log in|login)\b/i

const collapse = (s: string) => s.replace(/\s+/g, " ").trim()
const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s

function attr(el: Element, name: string) {
  return el.attrs.find((a) => a.name === name)?.value ?? null
}

function isElement(node: Node): node is Element {
  return "tagName" in node && Array.isArray((node as Element).attrs)
}

function hidden(el: Element) {
  if (attr(el, "hidden") !== null) return true
  if (attr(el, "aria-hidden") === "true") return true
  const style = (attr(el, "style") ?? "").toLowerCase().replace(/\s/g, "")
  return style.includes("display:none") || style.includes("visibility:hidden")
}

/** Plain text of an element (inline content only, skipping SKIP elements). */
function textOf(node: Node, depth = 0): string {
  if (depth > 60) return ""
  if (node.nodeName === "#text")
    return (node as DefaultTreeAdapterTypes.TextNode).value
  if (!isElement(node)) return ""
  if (SKIP.has(node.tagName) || hidden(node)) return ""
  const inner = node.childNodes
    .map((c) => textOf(c, depth + 1))
    .join(node.tagName === "br" ? "" : "")
  return node.tagName === "br" || BLOCK.has(node.tagName) ? ` ${inner} ` : inner
}

/** Splits long text at sentence ends into chunks of at most MAX_PASSAGE_CHARS. */
export function chunk(text: string): string[] {
  if (text.length <= MAX_PASSAGE_CHARS) return [text]
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text]
  const out: string[] = []
  let current = ""
  for (const s of sentences.map((x) => x.trim())) {
    if (!s) continue
    if ((current ? current.length + 1 : 0) + s.length <= MAX_PASSAGE_CHARS)
      current = current ? `${current} ${s}` : s
    else {
      if (current) out.push(current)
      current = s.length > MAX_PASSAGE_CHARS ? clip(s, MAX_PASSAGE_CHARS) : s
    }
  }
  if (current) out.push(current)
  return out
}

/** Labels that are page furniture, never product facts. */
const NAVIGATIONAL =
  /^(see also|website|web site|references?|external links?|sources?|notes?|citations?|edit|share|tags?|categories|category|related|links?|menu|home|contents)$/i

/** A usable fact label: starts with a letter, short, not navigation. */
export const factLabel = (label: string) =>
  /^[\p{L}]/u.test(label) &&
  label.length <= 60 &&
  !NAVIGATIONAL.test(label.trim())

const LABEL_VALUE =
  /^([A-Za-z][A-Za-z0-9 ()/&.'’-]{1,40}?)\s*[:：]\s+(.{1,200})$/

export function decodeBody(body: Buffer, charset: string | null): string {
  let label = charset
  if (!label) {
    const head = body.subarray(0, 4096).toString("latin1")
    label =
      /<meta[^>]+charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i
        .exec(head)?.[1]
        ?.toLowerCase() ?? "utf-8"
  }
  try {
    return new TextDecoder(label, { fatal: false }).decode(body)
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(body)
  }
}

export function extractPlainText(text: string): PageContent {
  const passages: Passage[] = []
  const facts: TextFact[] = []
  let line = 0
  for (const raw of text.split(/\r?\n/)) {
    line++
    const t = collapse(raw)
    if (t.length < 2) continue
    for (const piece of chunk(t)) {
      if (passages.length >= MAX_PASSAGES) break
      const suspicious = SUSPICIOUS.test(piece)
      passages.push({
        text: piece,
        location: `Line ${line}`,
        kind: "line",
        suspicious,
      })
      const kv = LABEL_VALUE.exec(piece)
      if (kv && !suspicious && factLabel(kv[1].trim()))
        facts.push({
          label: kv[1].trim(),
          value: kv[2].trim(),
          passage: passages.length - 1,
          method: "text-plain",
        })
    }
  }
  const visible = passages.reduce((n, p) => n + p.text.length, 0)
  return {
    // A plain-text document conventionally starts with its title.
    title: passages[0] ? clip(passages[0].text, 300) : null,
    h1: null,
    lang: null,
    canonical: null,
    meta: { description: null, ogTitle: null, siteName: null },
    jsonLd: { products: [], blocks: 0, invalidBlocks: 0, paywalled: false },
    passages,
    facts,
    signals: {
      visibleChars: visible,
      scripts: 0,
      javascriptMessage: false,
      captcha: CAPTCHA.test(text.slice(0, 3000)) && visible < 3000,
      login: false,
      paywall: false,
      suspiciousPassages: passages.filter((p) => p.suspicious).length,
    },
  }
}

export function extractHtml(html: string): PageContent {
  const document = parse(html)
  let title: string | null = null
  let h1: string | null = null
  let lang: string | null = null
  let canonical: string | null = null
  const meta = {
    description: null as string | null,
    ogTitle: null as string | null,
    siteName: null as string | null,
  }
  const ldBlocks: string[] = []
  let scripts = 0
  let noscriptJs = false
  let password = false
  const passages: Passage[] = []
  const facts: TextFact[] = []
  let heading: string | null = null
  const counters: Record<string, number> = {}
  let buffer: string[] = []
  let pendingTerm: { text: string } | null = null

  const where = (kind: PassageKind) => {
    counters[kind] = (counters[kind] ?? 0) + 1
    const n = counters[kind]
    const what =
      kind === "heading"
        ? `Heading ${n}`
        : kind === "row"
          ? `Table row ${n}`
          : kind === "list"
            ? `List item ${n}`
            : kind === "term"
              ? `Definition ${n}`
              : kind === "paragraph"
                ? `Paragraph ${n}`
                : `Text block ${n}`
    return heading && kind !== "heading"
      ? `${what} under “${clip(heading, 60)}”`
      : what
  }

  const push = (
    text: string,
    kind: PassageKind,
    fact?: { label: string; value: string; method: TextFact["method"] },
  ) => {
    const t = collapse(text)
    if (t.length < 2 || passages.length >= MAX_PASSAGES) return
    const location = where(kind)
    for (const piece of chunk(t)) {
      if (passages.length >= MAX_PASSAGES) return
      const suspicious = SUSPICIOUS.test(piece)
      passages.push({ text: piece, location, kind, suspicious })
      if (suspicious) continue
      if (fact && piece === t)
        facts.push({ ...fact, passage: passages.length - 1 })
      else if (
        !fact &&
        (kind === "list" || kind === "paragraph" || kind === "text")
      ) {
        const kv = LABEL_VALUE.exec(piece)
        if (kv && factLabel(kv[1].trim()))
          facts.push({
            label: kv[1].trim(),
            value: kv[2].trim(),
            passage: passages.length - 1,
            method: kind === "list" ? "html-list" : "html-text",
          })
      }
    }
  }

  const flush = (kind: PassageKind) => {
    const text = buffer.join("")
    buffer = []
    push(text, kind)
  }

  const kindOf = (tag: string): PassageKind =>
    /^h[1-6]$/.test(tag)
      ? "heading"
      : tag === "li"
        ? "list"
        : tag === "p"
          ? "paragraph"
          : "text"

  const walkHead = (node: Node) => {
    if (!isElement(node)) return
    const tag = node.tagName
    if (tag === "title" && title === null)
      title = collapse(textOfRaw(node)) || null
    if (tag === "meta") {
      const key = (
        attr(node, "name") ??
        attr(node, "property") ??
        ""
      ).toLowerCase()
      const content = attr(node, "content")
      if (content) {
        if (key === "description")
          meta.description = clip(collapse(content), 400)
        if (key === "og:title") meta.ogTitle = clip(collapse(content), 300)
        if (key === "og:site_name") meta.siteName = clip(collapse(content), 120)
      }
    }
    if (
      tag === "link" &&
      (attr(node, "rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")
    )
      canonical = attr(node, "href")
    if (tag === "script") {
      scripts++
      if (/application\/ld\+json/i.test(attr(node, "type") ?? ""))
        ldBlocks.push(textOfRaw(node))
    }
    for (const child of node.childNodes) walkHead(child)
  }

  const walk = (node: Node, depth = 0) => {
    if (depth > 200) return
    if (node.nodeName === "#text") {
      buffer.push((node as DefaultTreeAdapterTypes.TextNode).value)
      return
    }
    if (!isElement(node)) return
    const tag = node.tagName
    if (tag === "script") {
      scripts++
      if (/application\/ld\+json/i.test(attr(node, "type") ?? ""))
        ldBlocks.push(textOfRaw(node))
      return
    }
    if (tag === "noscript") {
      if (JS_MESSAGE.test(textOfRaw(node))) noscriptJs = true
      return
    }
    if (
      tag === "input" &&
      (attr(node, "type") ?? "").toLowerCase() === "password"
    )
      password = true
    if (tag === "form" || tag === "div" || tag === "section")
      for (const child of node.childNodes)
        if (
          isElement(child) &&
          child.tagName === "input" &&
          (attr(child, "type") ?? "").toLowerCase() === "password"
        )
          password = true
    if (SKIP.has(tag) || hidden(node)) return
    if (tag === "br") {
      flush("text")
      return
    }
    if (tag === "tr") {
      flush("text")
      const cells = node.childNodes.filter(
        (c): c is Element =>
          isElement(c) && (c.tagName === "td" || c.tagName === "th"),
      )
      const texts = cells.map((c) => collapse(textOf(c))).filter(Boolean)
      if (texts.length === 2 && factLabel(texts[0].replace(/[:：]\s*$/, "")))
        push(`${texts[0].replace(/[:：]\s*$/, "")}: ${texts[1]}`, "row", {
          label: texts[0].replace(/[:：]\s*$/, ""),
          value: texts[1],
          method: "html-table",
        })
      else if (texts.length > 0) push(texts.join(" | "), "row")
      return
    }
    if (tag === "dt") {
      flush("text")
      pendingTerm = { text: collapse(textOf(node)) }
      return
    }
    if (tag === "dd") {
      flush("text")
      const value = collapse(textOf(node))
      if (
        pendingTerm?.text &&
        value &&
        factLabel(pendingTerm.text.replace(/[:：]\s*$/, ""))
      )
        push(`${pendingTerm.text.replace(/[:：]\s*$/, "")}: ${value}`, "term", {
          label: pendingTerm.text.replace(/[:：]\s*$/, ""),
          value,
          method: "html-table",
        })
      else push(value, "term")
      pendingTerm = null
      return
    }
    const block = BLOCK.has(tag)
    if (block) flush("text")
    for (const child of node.childNodes) walk(child, depth + 1)
    if (block) {
      const kind = kindOf(tag)
      if (kind === "heading") {
        const text = collapse(buffer.join(""))
        if (text) {
          heading = text
          if (tag === "h1" && !h1) h1 = clip(text, 300)
        }
      }
      flush(kind)
    }
  }

  for (const child of document.childNodes) {
    if (!isElement(child)) continue
    if (child.tagName === "html") lang = attr(child, "lang")
    for (const part of child.childNodes) {
      if (!isElement(part)) continue
      if (part.tagName === "head") walkHead(part)
      else walk(part)
    }
  }
  flush("text")

  const jsonLd = extractJsonLd(ldBlocks)
  const visibleChars = passages.reduce((n, p) => n + p.text.length, 0)
  const sample = `${title ?? ""} ${h1 ?? ""} ${passages
    .slice(0, 40)
    .map((p) => p.text)
    .join(" ")}`
  return {
    title: title ? clip(title, 300) : null,
    h1,
    lang,
    canonical,
    meta,
    jsonLd,
    passages,
    facts: facts.slice(0, 400),
    signals: {
      visibleChars,
      scripts,
      javascriptMessage: noscriptJs || JS_MESSAGE.test(sample),
      captcha: CAPTCHA.test(sample) && visibleChars < 3000,
      login:
        password &&
        visibleChars < 2500 &&
        LOGIN.test(`${title ?? ""} ${h1 ?? ""} ${sample}`),
      paywall:
        jsonLd.paywalled || (PAYWALL.test(sample) && visibleChars < 4000),
      suspiciousPassages: passages.filter((p) => p.suspicious).length,
    },
  }
}

/** All text below a node, raw (used for <title>, scripts and noscript). */
function textOfRaw(node: Node): string {
  if (node.nodeName === "#text")
    return (node as DefaultTreeAdapterTypes.TextNode).value
  if (!isElement(node)) return ""
  return node.childNodes.map(textOfRaw).join("")
}
