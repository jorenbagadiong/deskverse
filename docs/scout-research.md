# Scout research (DV-005A)

Scout is the first real Deskverse AI employee. For each product of a
Ready Affiliate Ticket it reads the reference pages **you** supplied, checks
your product facts against them, and saves an immutable, versioned
research brief in which every claim points at the exact passage behind it.

Scout prepares factual research for Quill (DV-005B). It doesn't write
adverts, scripts or videos, publish anything, or search the web.

## Contents

1. [What Scout does, and doesn't](#1-what-scout-does-and-doesnt)
2. [Turning research on](#2-turning-research-on)
3. [Sources: what Scout reads](#3-sources-what-scout-reads)
4. [Networking and SSRF controls](#4-networking-and-ssrf-controls)
5. [Extraction and evidence](#5-extraction-and-evidence)
6. [Claim rules](#6-claim-rules)
7. [The research brief](#7-the-research-brief)
8. [Optional local AI (Ollama)](#8-optional-local-ai-ollama)
9. [The research-only workflow](#9-the-research-only-workflow)
10. [Retries, Needs Input and new snapshots](#10-retries-needs-input-and-new-snapshots)
11. [Storage, versions, integrity and backups](#11-storage-versions-integrity-and-backups)
12. [API and UI](#12-api-and-ui)
13. [Commands](#13-commands)
14. [Tests and evidence](#14-tests-and-evidence)
15. [Known limitations](#15-known-limitations)
16. [Used by Quill (DV-005B)](#16-used-by-quill-dv-005b)

## 1. What Scout does, and doesn't

Per product, from the run's **frozen snapshot** only:

1. Takes the product's reference URLs (manufacturer pages first, at most
   5), never the affiliate link.
2. Retrieves each permitted page safely (section 4).
3. Extracts structured data (JSON-LD), specification tables, definition
   lists, "Label: value" lines and short text passages.
4. Checks the page is about this product (name and model tokens).
5. Compares your claims (Specifications, Description) with what the
   sources state.
6. Classifies each claim (supported, conflicting, unverified, insufficient
   evidence) with the evidence keys behind it.
7. Saves the brief, sources, evidence and claims in PostgreSQL, atomically,
   in the transaction that completes the task.

Scout never:

- invents specifications, prices, discounts, commissions, ratings,
  reviews, performance figures, health outcomes, certifications, warranty
  terms, delivery promises, stock levels or "best/better than" claims;
- claims a page was reviewed when it couldn't be read;
- treats your own description as evidence, or the affiliate link as a
  source;
- bypasses robots.txt, logins, paywalls or CAPTCHAs, runs page JavaScript,
  uses a headless browser, or uses a scraping/search service;
- changes your ticket, products or media.

## 2. Turning research on

Research is **off by default**: nothing leaves your computer until you
allow it. In `.env.local`:

```bash
DESKVERSE_SCOUT_RETRIEVAL=on
```

Restart the app and the worker. Research then runs in the worker
(`yarn worker:start`); the web app only plans runs and shows results.
`yarn scout:check` and the ticket's Scout Research section say whether a
worker that can run Scout has checked in recently.

All settings (bounded; out-of-range values fall back to the default):

| Variable                             | Default         | Range           | Meaning                                    |
| ------------------------------------ | --------------- | --------------- | ------------------------------------------ |
| `DESKVERSE_SCOUT_RETRIEVAL`          | off             | `on`            | Allow Scout to fetch your reference pages  |
| `DESKVERSE_SCOUT_MAX_SOURCES`        | 5               | 1–5             | References read per product per attempt    |
| `DESKVERSE_SCOUT_MAX_PAGE_KB`        | 2048            | 64–5120         | Accepted bytes per page (after decompress) |
| `DESKVERSE_SCOUT_MAX_PRODUCT_KB`     | 8192            | 256–20480       | Bytes per product, all pages               |
| `DESKVERSE_SCOUT_REQUEST_TIMEOUT_MS` | 15000           | 1000–30000      | Per request (connect timeout ≤ 5 s)        |
| `DESKVERSE_SCOUT_PRODUCT_TIMEOUT_MS` | 120000          | 5000–300000     | Per product, all pages                     |
| `DESKVERSE_SCOUT_HOST_INTERVAL_MS`   | 1000            | 0–60000         | Gap between requests to one host           |
| `DESKVERSE_SCOUT_EXTRACTION`         | `deterministic` | or `ollama`     | Section 8                                  |
| `DESKVERSE_SCOUT_OLLAMA_URL`         | —               | loopback only   | e.g. `http://127.0.0.1:11434`              |
| `DESKVERSE_SCOUT_OLLAMA_MODEL`       | —               | installed model | Never downloaded by Scout                  |
| `DESKVERSE_SCOUT_OLLAMA_TIMEOUT_MS`  | 60000           | 1000–300000     | Per model call                             |

At most 3 Scout tasks run at once across all workers (the orchestrator's
`general` limit, `DESKVERSE_ORCHESTRATOR_GENERAL_LIMIT`), and each task
reads its sources one at a time.

## 3. Sources: what Scout reads

Only the **reference URLs on the product** (DV-004B "References"), in this
order: Manufacturer, Listing, Review, Other, Demo video; at most
`DESKVERSE_SCOUT_MAX_SOURCES`. A reference that points at the affiliate
link (same host and path) is skipped and recorded as "Affiliate link (not
visited)". Links found inside pages are never followed.

How much weight a source carries (shown on every source):

| Trust                | Meaning                                                              |
| -------------------- | -------------------------------------------------------------------- |
| Manufacturer page    | You labelled it Manufacturer **and** Scout matched the product on it |
| Seller listing       | You labelled it Listing                                              |
| Review/demonstration | You labelled it Review or Demo video                                 |
| Other                | Anything else (including a "Manufacturer" page Scout couldn't match) |

Scout never decides a page is official from its title or from a model's
opinion. A seller's or a single review's statement is "source-supported",
not independently verified, and the brief says which kind of source each
supported fact rests on.

Every reference gets a recorded outcome:

| Outcome                                      | When                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| Read                                         | Retrieved, readable and matched to the product                         |
| Not allowed by robots.txt                    | robots.txt disallows it, or answers 401/403                            |
| Permission couldn't be confirmed             | robots.txt unreachable (429/5xx/redirect problems): fail closed        |
| Login required / Paywall                     | HTTP 401/402/407, a sign-in form, or a subscription wall               |
| CAPTCHA or bot check                         | A challenge page (Scout never solves it)                               |
| Access refused (HTTP 403)                    | 403 or 451                                                             |
| Rate limited / Site error                    | 429 / 5xx (retryable; Retry-After honoured)                            |
| Needs JavaScript                             | Little text, scripts or an "enable JavaScript" notice, no product data |
| Unsupported format / Too large               | Not HTML or plain text (e.g. PDF); over the byte limit                 |
| Blocked address / Site not found             | Non-public destination; DNS failure                                    |
| Unsafe redirect refused / Too many redirects | Section 4                                                              |
| Couldn't confirm it's this product           | Read, but about something else; nothing from it is used                |
| Timed out / Couldn't connect                 | Connect/read timeouts; network or TLS errors                           |
| Not attempted (limit)                        | Over the per-product source, time or byte budget                       |

A source that wasn't read and matched never contributes a single fact.

## 4. Networking and SSRF controls

Scout's retrieval module (`src/server/scout/net/`) never calls
`fetch(userUrl)`. Reviewed against the OWASP SSRF Prevention Cheat Sheet:

- **URL rules (every hop):** `http:`/`https:` only; no user name or
  password; the default port only (80/443); a DNS name, never an IP
  literal. The WHATWG parser normalises `2130706433`, `0x7f.1`, `0177.0.0.1`,
  `127.1` and `[::ffff:7f00:1]` to literals, which are refused. No
  single-label or local names (`localhost`, `*.localhost`, `*.local`,
  `*.internal`, `*.lan`, `*.home.arpa`, `*.onion`…). Fragments are dropped.
- **Address checks:** the name is resolved once and **every** returned
  address must be public. IPv4 deny-list (IANA special-purpose):
  0/8, 10/8, 100.64/10 (CGN, incl. 100.100.100.200), 127/8, 169.254/16
  (incl. 169.254.169.254 metadata), 172.16/12, 192.0.0/24, 192.0.2/24,
  192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24,
  224/4, 240/4. IPv6 allow-list: only 2000::/3, minus 2001::/23 (Teredo…),
  2001:db8::/32, 2002::/16 (6to4), 3fff::/20. Everything else (::, ::1,
  fe80::/10, fc00::/7 incl. fd00:ec2::254, ff00::/8, IPv4-mapped
  `::ffff:x`, IPv4-compatible, NAT64 64:ff9b::/96…) is refused.
- **DNS rebinding:** the socket connects to exactly the address that was
  validated (the HTTP client never resolves the name itself), and the
  connected peer address is checked again after connecting.
- **Redirects:** followed manually, at most 3 hops; every hop goes through
  the URL rules, DNS, address checks and robots.txt again; https → http
  downgrades are refused.
- **Requests:** `GET` only, with fixed headers (User-Agent, Accept,
  Accept-Encoding, Accept-Language, Connection: close). No cookies,
  Authorization, Referer, environment values or database secrets. TLS
  certificates are verified with the host name as SNI.
- **Responses:** connect timeout (≤ 5 s), request timeout, product
  deadline, AbortSignal (cancellation, lost lease, shutdown); byte limit
  enforced while streaming and on decompressed bytes (gzip/deflate/br;
  decompression bombs stop at the limit); Content-Length over the limit is
  refused before reading; content types: `text/html`,
  `application/xhtml+xml`, `text/plain`. Nothing is executed: HTML is
  parsed by parse5, JSON-LD is parsed as JSON. No local files.
- **Politeness:** User-Agent
  `DeskverseScout/1.0 (+local research assistant; reads only owner-supplied reference pages; honours robots.txt)`;
  robots.txt per origin (RFC 9309, product token `DeskverseScout`,
  cached 30 min; 404 → no restrictions, 401/403 → disallowed, 429/5xx or
  unreachable → fail closed); per-host pacing; `Retry-After` honoured.

Tests inject the resolver, the dialler and the TLS layer
(`src/server/scout/net/test-network.ts`) so fixture sites appear as public
hosts; every check above still runs unchanged. The worker refuses the
fixture network unless the database is a guarded test database. Real TLS
verification and DNS are exercised by `yarn scout:smoke`.

## 5. Extraction and evidence

The deterministic baseline (no AI model) reads:

- **JSON-LD** `Product` data (also inside `@graph`, `mainEntity`, product
  groups): name, brand, manufacturer, model, MPN, SKU, GTIN, colour,
  material, weight and dimensions, `additionalProperty`, offers
  (price/availability) and aggregate rating. Bounded: 30 blocks × 256 KB,
  8 levels, 500 nodes. The evidence passage is the JSON fragment,
  re-serialised.
- **Specification tables** (two-cell rows), **definition lists** and
  **"Label: value" lines**, with readable locations such as
  `Table row 3 under “Specifications”`.
- **Text passages** (≤ 600 characters, split at sentence ends), skipping
  scripts, styles, templates, SVG, iframes, form controls, navigation and
  hidden elements.

Labels must start with a letter, be at most 60 characters and not be page
furniture ("See also", "Website", "References"…). A page's
"Manufacturer" is kept apart from "Brand" (it may be a contract maker).

**Evidence records** keep only what a claim cites: key (E1…), source,
method, location, passage (≤ 600 characters), statement, attribute/value,
and the model when one proposed it. Pages themselves aren't stored; each
source keeps its final URL, HTTP status, content type, byte count,
retrieval time and a SHA-256 of the bytes received.

**Prompt injection:** passages containing text addressed to AI systems
("ignore previous instructions", "system prompt", "you are now…",
"developer mode"…) are flagged, never used as evidence, never sent to a
model, and the brief notes it. URLs named inside pages are never fetched.

## 6. Claim rules

Your claims come from the snapshot's **Specifications** (one per line,
`Label: value` becomes an attribute claim) and **Description** (one per
sentence). Notes and instructions aren't claims.

| Status                | Rule                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Supported             | A stored passage from a read, matched source states the same value (unit-aware: 1.7 L = 1700 ml ≈ 57.5 fl oz, 2200 W = 2.2 kW, within 2 %) or the same words |
| Conflicting           | A source states an incompatible measurement (same kind, different amount), or a different brand/model; also when sources disagree with each other            |
| Unverified            | Sources were read but none states it, or only ambiguously (a passage that also lists other, different amounts is context, not support)                       |
| Insufficient evidence | No source could be read and matched at all                                                                                                                   |

- Statement claims need one passage that states every measurement in the
  sentence and most of its words; subjective wording ("perfect for busy
  mornings") stays unverified.
- Facts the sources state that you didn't mention are listed as source
  facts (supported, or conflicting when sources disagree).
- Prices, availability and ratings are **time-sensitive**: shown with
  their retrieval date ("may have changed"), never as selling points.
- Claims touching price, discount, commission, rating, performance
  comparisons, health, certification, warranty, delivery, stock or
  superiority are flagged **sensitive** and never suggested as selling
  points, even when supported.
- "Supported" means _source-supported_, not guaranteed true. There are no
  numeric confidence scores.

## 7. The research brief

Format `scout-brief/1` (`ResearchBrief` in `src/lib/scout/types.ts`):

1. **Product identification:** identified or not, the name found, and
   identifiers (brand, model, GTIN, SKU) with evidence.
2. **Source inventory:** every reference with outcome, trust, HTTP status,
   retrieval time, checksum and transport.
3. **Supported facts** (yours and the sources').
4. **Your unverified claims.**
5. **Conflicting information**, each with both sides' evidence.
6. **Insufficient evidence.**
7. **Features supported by evidence** (non-sensitive, not time-sensitive).
8. **Factually supportable points** (at most 8), each citing its claims
   and its basis ("manufacturer page", "2 sources agree", "one seller
   listing only"…). Not marketing copy.
9. **Time-sensitive information**, with retrieval dates.
10. **Limitations** (unread sources, no manufacturer page, AI-addressed
    text found, model problems…).
11. **What you can do** (owner actions: add a manufacturer page, resolve a
    conflict, support or remove an unverified claim, replace a blocked
    reference…).
12. **Extraction metadata:** mode, model name/digest/Ollama version,
    accepted and rejected model proposals.

Status is `complete` when at least one source was read and matched and
something could be checked, otherwise `insufficient_evidence`.

## 8. Optional local AI (Ollama)

Scout works fully without a model. To add a local model's candidate facts:

```bash
DESKVERSE_SCOUT_EXTRACTION=ollama
DESKVERSE_SCOUT_OLLAMA_URL=http://127.0.0.1:11434
DESKVERSE_SCOUT_OLLAMA_MODEL=<a model you already installed>
```

- Only plain `http` on 127.0.0.1, ::1 or localhost is accepted; any other
  address disables the model (Scout never calls a hosted model).
- Scout never pulls or downloads a model. It uses `GET /api/version`,
  `GET /api/tags` (read-only check, also in `yarn scout:check`) and
  `POST /api/chat` with a JSON schema (`format`), `temperature: 0`,
  `num_predict` 1024, a 24 000-character prompt cap, a timeout and
  cancellation.
- Passages go as quoted JSON data with instructions to ignore anything
  instruction-like inside them; no tools, credentials or file paths.
- Every proposed fact must cite a passage ID that was sent, quote it
  exactly, and contain its value literally in that quote. Anything else is
  rejected and counted. Accepted facts then follow the same claim rules as
  everything else; the model never sets a claim's status.
- If Ollama is down, the model is missing or a call fails or times out,
  the brief says so and the deterministic results stand.

## 9. The research-only workflow

Scout is the production handler for `scout.research` and runs through the
DV-004C orchestrator: claims, leases, heartbeats, fencing, retries,
pause/resume, cancel, recovery and run events. It has no queue of its own.

- Workflow `scout-research-v1` (mode `production`, "Research only") has
  one stage, `scout.research` (resource class `general`, recovery
  `retry`: retrieval is read-only, so repeating it is safe). No Quill,
  Pixel or Vera tasks are created.
- `planRun` takes an **explicit** workflow and validates it: it must
  exist, match the mode, and be available here. Research needs retrieval
  on and at least one product with a usable reference.
- The full campaign `campaign-v1` (the default for production) is still
  refused with a 503: "Full campaign automation isn't available yet:
  Quill (DV-005B), Pixel (DV-005C), and Vera (DV-006A) aren't built."
  Scout existing is not permission to start a campaign.
- Verification handlers still run only on guarded test databases.
- Request idempotency, the ticket-version check and one unfinished run per
  ticket apply unchanged.

## 10. Retries, Needs Input and new snapshots

| Situation                                                                                   | Result                                                                                                      |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| At least one source read and matched                                                        | Completed, with a brief (unread sources are listed in it)                                                   |
| Nothing usable yet, a temporary problem (429, 5xx, timeout…)                                | Retry with backoff, never sooner than the site's Retry-After (≤ 15 min); final attempt gives a final answer |
| No name, no references, only the affiliate link, or every source blocked/refused/mismatched | **Needs input**, with each source's problem recorded and shown                                              |
| A worker crashes mid-research                                                               | Lease expires, retried; the crashed attempt wrote nothing                                                   |
| Cancelled                                                                                   | Stops at the next check; no brief is written                                                                |

One product's failure never blocks another product.

To fix missing input, **edit the product** (the ticket returns to Draft),
mark it Ready and start a **new research run**: it gets a new frozen
snapshot. Old runs keep their snapshots and briefs. Retry (in the Workflow
section) repeats a step with the **same** inputs: useful when a site was
temporarily unavailable, not for picking up edits.

## 11. Storage, versions, integrity and backups

Migration `0003_scout_research`:

| Table                  | Holds                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scout_reports`        | One brief per completed `scout.research` task: version, status, extraction mode, fence, snapshot checksum, report checksum, brief JSON (≤ 128 KB) |
| `scout_sources`        | Each reference's retrieval outcome and safe metadata (no page bodies)                                                                             |
| `scout_evidence`       | Cited passages (≤ 600 characters) or JSON-LD fragments                                                                                            |
| `scout_claims`         | Assessed claims                                                                                                                                   |
| `scout_claim_evidence` | Claim ↔ evidence with the relationship (supports, contradicts, context)                                                                           |
| `orchestrator_workers` | Recent worker check-ins (informational, for the UI)                                                                                               |

`task_results.kind` now also allows `scout_research`, and the result row
holds only a compact reference (report ID, version, checksum, status,
counts), not the report.

Guarantees enforced by PostgreSQL:

- every research row is immutable (UPDATE/DELETE refused);
- a report can only be inserted by the **current lease holder** of a
  running `scout.research` task (matching fence, snapshot, product,
  ticket and snapshot checksum); a stale worker is refused;
- sources/evidence/claims can only be added while that task is still
  running, i.e. in the completing transaction, never appended later;
- composite keys keep every evidence row, claim and link inside its own
  report (no cross-report or cross-product links), and every report
  inside its own run, task and snapshot;
- `scout_reports.task_id` is unique, and `(product_id, report_version)`
  too: retries can't create a second report.

**Versions:** `report_version` counts briefs per product across runs
(1, 2, 3…); every version stays readable. The brief format has its own
version (`scout-brief/1`, `schema_version = 1`).

**Integrity:** the checksum is SHA-256 of a canonical document (brief,
sources, evidence, claims and the run/task/snapshot linkage). Every read
recomputes it and shows "Checksum verified" or "Checksum mismatch".

**Backups:** research lives only in PostgreSQL, so the existing offline
database backup includes it with no change to the media backup format.
Restoring keeps every report, its sources, checksums and run linkage
(tested), and clears worker check-ins from the old machine. DV-004A,
DV-004B and DV-004C backups restore and migrate forward to 0003.

## 12. API and UI

Local-only, strict input, `Cache-Control: no-store`, safe errors, never
SQL, paths, credentials or page bodies:

| Request                                                                                                        | Result                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/tickets/:id/runs` `{ requestId, ticketVersion, mode: "production", workflow: "scout-research-v1" }` | Starts research (201), or 503/409/400 with the reason                                                                                 |
| `GET /api/tickets/:id/research`                                                                                | Availability, the latest research run's per-product state (with source problems), every brief version                                 |
| `GET /api/tickets/:id/runs/:runId/research/:snapshotId?evidenceOffset=&evidenceLimit=`                         | One brief: sources, claims, an evidence page (≤ 100), integrity; 404 unless the snapshot belongs to the run and the run to the ticket |
| `GET /api/system/scout`                                                                                        | Read-only diagnostics: handler, retrieval, extraction, Ollama status, worker check-in, missing configuration                          |

The ticket workspace's **Scout Research** section (below Workflow) shows:
whether research is on and what it does; whether a worker is running
("Research waits until you start it: yarn worker:start"); the extraction
mode and model status; products without references; **Start research**
(only when the ticket is Ready, research is on, a product has a usable
reference and no run is unfinished), with a confirmation listing the
sites Scout will contact; per-product progress with needs-input reasons
and each source's problem; every brief (claims by status, evidence
passages with locations, sources with outcomes and checksums,
limitations, owner actions); and earlier versions.

Everything from a source is rendered as escaped text (retrieved HTML is
never injected). External links open in a new tab with
`rel="noopener noreferrer nofollow"`, `referrerPolicy="no-referrer"`, and
only for http(s) addresses. Desktop, 375 px and 360 px layouts are tested.
Scout isn't shown working in the 3D office yet (DV-008B).

## 13. Commands

```bash
yarn worker:start      # the worker: runs Scout when DESKVERSE_SCOUT_RETRIEVAL=on
yarn worker:check      # read-only: database, limits, Scout on/off, runs, tasks, worker check-ins
yarn scout:check       # read-only: Scout diagnostics (incl. the optional local model)
yarn scout:verify      # crash/recovery verification on a scratch test database, fixture sites only
yarn scout:smoke --url https://… --name "Product" [--kind manufacturer] [--spec "Key: value"] [--pipeline]
                       # bounded LIVE check of one public page; --pipeline also runs a real
                       # worker on a scratch test database (never the development database)
```

## 14. Tests and evidence

- `tests/scout-net.test.ts`: SSRF and retrieval (addresses, URL rules,
  robots.txt, rebinding, redirects, limits, types, cancellation, headers).
- `tests/scout-research.test.ts`: extraction, quantities, attributes,
  identification, claim classification on fixture sites (supporting,
  conflicting, inaccessible, missing references, mismatched, injected),
  retry/needs-input decisions, mocked Ollama (accepted, fabricated,
  invalid and unsupported output; outages, timeouts, cancellation),
  configuration gates.
- `tests/db/scout.db.test.ts`: workflow gating, batch research with a
  worker, immutability and guard triggers, stale-lease fencing, concurrent
  commits, mid-commit crash rollback, database refusals, Retry-After,
  cancellation, versions and new snapshots, ownership, worker check-ins.
- `tests/db/scout-crash.db.test.ts` (= `yarn scout:verify`): 8 products,
  three worker processes, SIGTERM, SIGKILL and a kill between writing a
  report and committing it.
- `tests/db/backup-scout.db.test.ts`: backup/restore with reports; a
  DV-004C-era backup migrating to 0003.
- `e2e/tickets-research.spec.ts`: the UI end to end with a real worker.

## 15. Known limitations

- Only owner-supplied references; no web search or discovery.
- Pages that need JavaScript, a login, a CAPTCHA, or that block automated
  access (e.g. HTTP 403 from bot protection) can't be used; Scout says so.
- English-oriented heuristics (sentence splitting, synonyms, barrier
  detection); microdata/RDFa aren't read; PDFs aren't supported.
- Claim matching is deliberately conservative: some true facts stay
  "unverified" (paraphrases, values split across elements, ambiguous
  comparison tables).
- robots.txt caching and host pacing are per worker process, not shared
  between processes.
- Worker check-ins are informational (written every ≤ 5 s, "running" if
  seen in the last 15 s).
- Real local-model inference is optional and was not available on the
  development machine during DV-005A (mocked in tests).

## 16. Used by Quill (DV-005B)

Quill writes scripts only from a Scout report the owner chooses, pinned by
ID, version and checksum; it re-verifies the checksum and refuses reports
made from older product data. Only claims that are `supported`, not
sensitive, not time-sensitive, not identifiers, free of conflicts and
backed by real supporting evidence become copy. Scout's `sellingPoints`
guide the order, but their claim keys are re-checked. Quill never changes
Scout reports. See [Quill scriptwriting](quill-scriptwriting.md).
