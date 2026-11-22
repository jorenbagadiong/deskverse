# Quill scriptwriting (DV-005B)

Quill writes short vertical affiliate video scripts from a **Scout research
report you choose**. Every product fact in a script comes from a claim
Scout found supported by a source, and every factual scene lists the claim
and evidence behind it. Quill never fetches websites, never visits affiliate
links, never changes Scout's research or your product data, and never
invents specifications, selling points, prices or experiences.

Quill prepares content. It doesn't render (Pixel, DV-005C), review (Vera,
DV-006A), approve, schedule or publish anything.

## Contents

1. [Writing modes](#1-writing-modes)
2. [Workflow and availability](#2-workflow-and-availability)
3. [Choosing research, and when it's refused](#3-choosing-research-and-when-its-refused)
4. [Which claims become copy](#4-which-claims-become-copy)
5. [The script contract](#5-the-script-contract)
6. [Copy rules](#6-copy-rules)
7. [Validation](#7-validation)
8. [Pixel compatibility](#8-pixel-compatibility)
9. [Storage, versions and integrity](#9-storage-versions-integrity)
10. [API and UI](#10-api-and-ui)
11. [Commands and configuration](#11-commands-and-configuration)
12. [Backups](#12-backups)
13. [Tests](#13-tests)
14. [Limitations and DV-005C](#14-limitations-and-dv-005c)

## 1. Writing modes

| Mode                            | What it is                                                                                                                                    | Needs                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **Template** (default)          | Template-based composition: a small fixed set of sentence patterns filled with the product name and eligible Scout facts. Not AI.             | nothing                       |
| **Template + local AI wording** | The template script, with hook, call-to-action and benefit wording proposed by a local Ollama model and kept only where it passes validation. | Ollama, a model you installed |

The script's metadata and the UI say which mode was used (and the model's
name, digest, Ollama version and temperature when one was). Template mode
works with no model installed.

## 2. Workflow and availability

- Quill is the production handler for `quill.script` and runs in the
  normal worker (`yarn worker:start`) through the DV-004C orchestrator:
  claims, leases, heartbeats, fencing, retries, pause/resume, cancel,
  attempt history and run events. It has no queue of its own.
- Workflow **`quill-script-v1`** ("Scriptwriting only") has one stage,
  `quill.script` (resource class `cpu`, recovery `retry`: writing is pure
  database-in, database-out, so a crashed attempt is safe to repeat).
  One task per **selected** product; products progress independently.
- Quill reads only the database, so it is always registered and always
  available. It doesn't need Scout's retrieval switch.
- The full campaign (`campaign-v1`) is **still refused** with a 503,
  which since DV-005C names only Vera (DV-006A). Scout research (`scout-research-v1`)
  is unchanged.

## 3. Choosing research, and when it's refused

You pick one completed Scout report per product (Quill Scripts section, or
`scripts: [{ productId, reportId }]` in the run request). Planning happens
in one transaction and refuses, with the reason:

| Problem                                                                         | Answer                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| The report isn't one of this product's reports on this ticket                   | 404                                                           |
| The report's checksum no longer verifies                                        | 400 "fails its checksum check… Run Scout again"               |
| **The product changed since Scout researched it**                               | 409 `stale-research` "Run Scout again on the current product" |
| No product chosen, two reports for one product                                  | 400                                                           |
| The ticket isn't Ready, changed since the page loaded, or has an unfinished run | 409 (as for every run)                                        |

"Changed" is decided conservatively: the frozen input a new run would get
(ticket title, platform, instructions, publishing preferences, and the
product's fields, references and media) must be **byte-for-byte identical**
(same checksum) to the input Scout researched. So an unrelated ticket edit
(e.g. renaming the ticket or uploading an image) also asks for new
research. That is deliberate: Quill never mixes versions.

Each task pins the report's **ID, version and checksum** in its parameters.
Quill never picks "the newest report" when it runs; a manual Retry uses the
same pinned report; changed owner data needs a new Scout report and a new
Quill run.

At run time Quill re-reads the pinned report, recomputes its checksum and
checks it still belongs to the ticket and product and was made from exactly
the task's frozen snapshot. Any mismatch is a permanent failure: no script.

## 4. Which claims become copy

A Scout claim is **eligible** for promotional copy only if all hold:

- status **`supported`** (Scout's exact classification);
- not an identifier (brand, model, GTIN, SKU);
- no **sensitive topic**: price, discount, commission, rating/reviews,
  performance comparisons, health, certification, warranty, delivery,
  stock, superiority ("best", "number one"); these need a future
  verification/approval step;
- not **time-sensitive**;
- no **conflicting** claim about the same attribute in the report;
- at least one **supports** link to evidence that exists in the report,
  from a source that was read and matched to the product, whose passage
  isn't text addressed to AI systems;
- plain text (no links, HTML, control or invisible characters), not a
  negative value ("No"), and short enough for an 80-character caption
  **without being shortened** (Quill never truncates a fact).

Scout's suggested selling points come first (their claim keys re-checked
against the report), then the other eligible facts in report order; at
most 5 become benefit scenes. A script needs **at least 2** eligible facts;
with fewer, or with an `insufficient_evidence` report, the task asks for
input, naming the product, the conflicts and what was unusable, and telling
you to add sources and run Scout again. Quill never fills gaps from general
knowledge. Every claim that wasn't used is listed in the script with the
reason.

## 5. The script contract

Format `quill-script/1` (`QuillScriptDocument` in `src/lib/quill/types.ts`):

| Field                                      | Meaning                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| script id, version                         | `quill_scripts.id`, `script_version` (per product: 1, 2, 3…)                         |
| ticket, product                            | ticket ID, product ID and name                                                       |
| report                                     | the pinned Scout report's ID, version and checksum                                   |
| snapshotChecksum                           | the frozen product input it was written from                                         |
| generation                                 | mode, templates version, model metadata (if used), accepted/rejected proposals, note |
| language, platform, status                 | `en`, the ticket's platform, `valid`                                                 |
| totalDurationMs, estimatedNarrationSeconds | from Pixel's storyboard fitting; ~2.5 words per second                               |
| scenes                                     | see below                                                                            |
| disclosure                                 | `{ text, placement: "every-scene", required: true, source: "pixel-default" }`        |
| pixel                                      | Pixel product text + text compatibility + render readiness (§8)                      |
| findings                                   | validation warnings (errors never reach a saved script)                              |
| excludedClaims                             | each unused claim with the reason                                                    |

A **scene**: stable id (`scene-1`…, as in Pixel), kind (`hook`, `benefit`,
`call-to-action`: Pixel's vocabulary), duration, narration, on-screen
caption, optional caption subtext, visual direction, the claims it states
(claim key, statement, and each evidence key with its source key, source
URL and retrieval time), and notes (e.g. "media rights are unspecified").

Shape: one hook, 1–5 benefit scenes, one call to action (at most 7 of
Pixel's 8 scenes), 15–30 seconds in total, 2–8 seconds per scene, vertical
short-form.

## 6. Copy rules

- **Hook:** introduces the product or asks a plain question ("Meet the …",
  "A closer look at the …", "What does the … offer?"). States no facts; no
  urgency, scarcity, prices, popularity, reviews or superiority.
- **Benefits:** caption `Attribute: value` (or the feature name for a
  "Yes" value), or the supported statement itself; narration "The capacity
  is 1.7 L.", "It has auto shut-off.", or the statement. Each is linked to
  its claim and evidence.
- **Call to action:** "Check the product details" / "Check the product
  details through the link." No discounts, free delivery or availability.
- **Disclosure:** Pixel's default "#ad · I may earn a commission if you buy
  through my link.", stored as structured data and required on every scene
  of a future render. It is never dropped when a script is rewritten.
  Platform-specific legal checks are left to Vera and Relay.
- **No invented experiences** ("I tested this…") and no guarantees.

## 7. Validation

Every script is validated before it can be saved (`validateScript`);
errors block completion, warnings are kept as findings. This is a
conservative design, not proof of meaning: factual parts are built from
approved, evidence-linked statements, and the checks catch anything that
strays:

- structure: hook first, 1–5 benefits, call to action last, ids, 2–8 s per
  scene, 15–30 s total, caption limits (headline 70, benefit 80, call to
  action 40), narration ≤ 400 characters;
- every linked claim is eligible, its statement matches the report, and
  every evidence key is one of that claim's supporting evidence;
- every benefit has a claim, and its caption states the claim as recorded;
- every number or measurement in a scene comes from a linked claim, and
  scenes without claims contain no numbers (the owner's product name is
  ignored for these checks);
- no links, HTML, AI-addressed text, control/invisible characters,
  sensitive topics, guarantees, pressure tactics or invented experiences;
- the disclosure is present, on every scene, and identical in Pixel's text;
- warnings: narration that may be too long for its scene, Pixel text
  limits, render readiness.

The database adds its own guard: a scene can only link a Scout claim that
is supported, not sensitive, not time-sensitive, not an identifier, has no
conflict on its attribute, with evidence keys that are real "supports"
links of that claim in the same report (§9).

**Local model output** is untrusted. The model gets only the product name,
the platform and the eligible facts' captions (never passages, secrets or
paths), with instructions to add nothing. Its proposals are accepted only
if: hook and call to action use generic words plus the product name, no
numbers and nothing unsafe; each benefit sentence cites a real eligible
claim, states its value literally, adds no other quantity and no words
beyond the claim's own and generic connectors. Rejected parts keep their
template text; Quill tries the model twice; if the assembled script still
fails validation, the whole template script is used. Fabricated facts,
quantities, citations, experiences and guarantees are rejected, never
saved.

## 8. Pixel compatibility

Quill reuses Pixel's own code: `buildStoryboard` (scene durations),
`validateProduct` (text limits), `DEFAULT_DISCLOSURE` and `MEDIA_LIMITS`.

| Script                 | Pixel `ProductInfo` field | Limit   |
| ---------------------- | ------------------------- | ------- |
| product name           | `name`                    | 60      |
| hook caption           | `headline`                | 70      |
| benefit captions (1–5) | `benefits[]`              | 80 each |
| call-to-action caption | `callToAction`            | 40      |
| disclosure             | `disclosure`              | 140     |

Three separate checks, shown separately:

1. **Valid script**: passed validation (always true for a saved script).
2. **Compatible with Pixel's text limits**: `validateProduct` accepts the
   text. A product name over 60 characters makes this false; the script is
   still valid and nothing is cut.
3. **Ready to render**: the product has at least 3 images (Pixel uses
   3–6). Otherwise: "Pixel needs 3–6 product images; this product has N."

Quill never creates Pixel jobs, uploads assets or starts FFmpeg, and its
scene JSON is not a trusted Pixel render project. Since DV-005C, Pixel
maps a chosen script into its own project: it re-runs Quill's validator
and its own server-side validation, then checks fidelity scene by scene
before rendering inside the render gate. See
[Pixel ticket production](pixel-ticket-production.md).

## 9. Storage, versions, integrity

Migration `0004_quill_scripts`:

| Table                | Holds                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quill_scripts`      | one script per completed `quill.script` task: run/task/snapshot/product, pinned report ID, version and checksum, snapshot checksum, script version, mode, language, platform, Pixel flags, fence, checksum, metadata (≤ 128 KB) |
| `quill_scenes`       | ordered scenes: key, kind, duration, narration, caption, subtext, visual, notes                                                                                                                                                 |
| `quill_scene_claims` | which Scout claim (and evidence keys) each scene states                                                                                                                                                                         |

`task_results.kind` also allows `quill_script`; the result holds only a
compact reference (script ID, version, checksum, report, mode, flags).

Enforced by PostgreSQL:

- every Quill row is immutable;
- a script is accepted only from the **current lease holder** of a running
  `quill.script` task (matching fence, snapshot, product, ticket), and only
  for the pinned report of the same ticket and product whose checksum,
  version and snapshot checksum match;
- scenes and claim links only while that task is running (the completing
  transaction);
- composite keys keep claim links inside their script and their script's
  report (`(report_id, claim_key)` references the exact Scout claim); no
  cross-report, cross-product or cross-ticket links;
- only promotable claims with their own supporting evidence (§7);
- one script per task, and `(product_id, script_version)` unique.

Scripts and their task completion commit together; a crash before commit
leaves nothing, and a crash after commit can't cause a second script. A new
draft is always a new version. The checksum (SHA-256 of the canonical
document plus run/task/snapshot linkage) is recomputed on every read.

## 10. API and UI

Local-only, strict input, `no-store`, safe errors:

| Request                                                                                                                                          | Result                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/tickets/:id/runs` `{ requestId, ticketVersion, mode: "production", workflow: "quill-script-v1", scripts: [{ productId, reportId }] }` | starts scriptwriting (201), or 400/404/409/503 with the reason                                                                         |
| `GET /api/tickets/:id/scripts`                                                                                                                   | availability, per product the reports Quill could use (verified? current? usable facts?), the latest run's tasks, every script version |
| `GET /api/tickets/:id/runs/:runId/scripts?limit=`                                                                                                | the run's scripts (≤ 100)                                                                                                              |
| `GET /api/tickets/:id/runs/:runId/scripts/:scriptId`                                                                                             | one script with integrity check; 404 unless it belongs to the run and the run to the ticket                                            |

The ticket's **Quill Scripts** section (below Scout Research) shows:
availability and writing mode; whether a worker is running; per product a
choice of research (version, date, usable facts, whether it matches the
current product; unusable reports are disabled with the reason); **Start
scriptwriting**; per-product progress and needs-input messages; each
script (scenes with captions, narration, visual directions, durations, the
evidence behind every factual scene with source links, disclosure,
validation notes, Pixel checks, unused claims, integrity); and earlier
versions. Text is rendered escaped; external links use `noopener
noreferrer nofollow`. Keyboard, light/dark, 360/375 px tested. Scripts are
immutable versions (no manual editing in DV-005B).

## 11. Commands and configuration

```bash
yarn worker:start     # runs Quill (and Scout when retrieval is on)
yarn quill:verify     # crash/recovery verification on a scratch test database
```

Optional local AI wording (`.env.local`):

```bash
DESKVERSE_QUILL_GENERATION=ollama
DESKVERSE_QUILL_OLLAMA_URL=http://127.0.0.1:11434   # loopback only
DESKVERSE_QUILL_OLLAMA_MODEL=<a model you installed>  # never downloaded
DESKVERSE_QUILL_OLLAMA_TIMEOUT_MS=60000               # 1000–300000
```

Temperature 0.3, at most 800 output tokens, JSON-schema output.
`DESKVERSE_QUILL_TEST` (slow generation, a crash point) is test-only and
refused unless the database is a guarded test database.

## 12. Backups

Scripts live only in PostgreSQL, so the existing offline backup includes
them (no format change). A restore keeps every script's version, checksum,
scenes, claim links and the link to its Scout report (tested). DV-004A,
DV-004B, DV-004C and DV-005A backups restore and migrate forward to 0004.

## 13. Tests

- `tests/quill.test.ts`: selection (supported only, sensitive,
  time-sensitive, conflicting, missing/fabricated evidence, AI-addressed
  passages, markup), template scripts, render readiness vs validity, long
  names, validation of tampered scripts, unsafe phrases, mocked model
  proposals (accepted, fabricated citations, invented quantities, urgency),
  prompt contents, configuration gates.
- `tests/db/quill.db.test.ts`: planning and pinning, ownership, stale and
  corrupt reports, idempotency, the full campaign refused, a multi-product
  run with needs-input, immutability, the database refusing an ineligible
  claim from the lease holder, stale-lease fencing, concurrent commits,
  rollback, versions, retry keeps the pin, cancellation, a lease lost
  during model inference, backup/restore.
- `tests/db/quill-crash.db.test.ts` (= `yarn quill:verify`).
- `e2e/tickets-quill.spec.ts`: the UI with a real worker.

## 14. Limitations and DV-005C

- Template copy is plain by design; richer wording needs a local model, and
  real local inference was **not tested** (no model installed).
- Matching research to the current product is all-or-nothing (any ticket
  or product change asks for new research).
- Statement claims are used verbatim; long ones are skipped rather than
  shortened.
- English only. No manual editing, voice-over or preview.
- **DV-005C (done)** turns a valid, Pixel-compatible script plus 3–6 of
  the product's images into a verified video. The disclosure is confirmed
  in real frames of every scene. Pixel keeps this stale-input policy:
  images added after a script need new Scout research and a new Quill
  script. See [Pixel ticket production](pixel-ticket-production.md).

## Vera lineage revalidation (DV-006A)

Vera reuses Quill’s `selectFacts` and `validateScript`, verifies the exact persisted script/report checksums, checks scene claim statements and evidence mappings, and compares the trusted Pixel project with the validated Quill captions and durations. It does not claim semantic understanding of arbitrary prose or text inside photographs. A corrected fact or script needs a new upstream version; QA never edits a script.

See [Vera quality assurance](vera-quality-assurance.md) for the rules, limitations, recovery and campaign readiness audit.
