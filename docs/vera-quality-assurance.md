# Vera automated quality assurance (DV-006A)

Vera reviews one explicitly selected, completed Pixel ticket video using persisted
Scout evidence, the exact Quill script, the frozen render manifest and actual
MP4 bytes. `vera.review` is a production handler in the existing PostgreSQL
orchestrator. `vera-review-v1` performs QA only; it never repeats upstream stages.
No external AI, arbitrary source browsing, approval or publishing is involved.

## Contracts and outcomes

- Report: `vera-review/1`.
- Rules: `vera-rules/1`.
- Platform preparation: `vera-platform-checklist/1` (`src/lib/vera/policy.ts`).

| QA verdict          | Meaning and next action                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pass`              | Mandatory executed automated checks passed. Warnings and human approval remain.                                                                     |
| `needs_revision`    | Observable, correctable output defect; create a corrected Pixel version, or fix source text/assets and regenerate upstream versions.                |
| `needs_owner_input` | A reliable assessment requires missing rights information or human judgment. Acknowledging unspecified rights does not clear this verdict.          |
| `failed`            | Bytes or lineage are unusable, e.g. missing MP4, checksum mismatch, corrupt file or invalid source chain. Restore originals or create new versions. |

The task completes when its immutable report is recorded, including negative QA
verdicts. Task failure means execution failed, not that the video failed QA.
Unexpected errors, unavailable tools and timeouts follow the orchestrator's
bounded retry/backoff rules. Cancellation and lost leases commit nothing.

Findings contain a rule ID/version, category, severity, explicit outcome,
expected condition, observed evidence, deliverable/scene, artifact IDs, timestamp
and remediation. Outcomes distinguish machine verification, machine flags,
warnings, human review requirements and checks not evaluated. An unexecuted
check is never marked passed. Early fatal failures stop dependent checks; the
report's findings describe what actually ran. No confidence score is invented.

## Exact pin and historical inputs

Planning requires a selected `{ productId, deliverableId }` per product. It
validates completed Pixel ownership, script/report checksums and versions,
original snapshot checksum, render manifest and actual MP4 checksum/size.
Task parameters freeze the whole pin before any worker starts:

- ticket/product and Pixel deliverable ID, version, SHA-256 and byte count;
- render job/manifest/checksum, renderer configuration and selected image checksums;
- Quill ID/version/checksum/run and Scout ID/version/checksum/retrieval location;
- original product snapshot/checksum, rights declaration/note and acknowledgement;
- ruleset version.

The worker revalidates the same pin and never looks up a newer output. A changed
current ticket does not invalidate a historical review's original lineage.
`current` is computed against the current product snapshot on each read. History
and QA labels are keyed by deliverable ID; an old review cannot become a newer
video's QA result. A ticket must be Ready to start a new QA run.

## Machine checks and limits

| Category / rules     | Actual evidence and limitations                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provenance           | Recompute Scout, Quill, original snapshot and manifest checksums; verify exact ticket/product/version links. Rebuild the trusted Pixel project from Quill text and compare it with the saved project.                                                                                            |
| Claims               | Reuse `selectFacts` and `validateScript` from Quill; require exact claim statements, eligible statuses and valid evidence references. Reject detectable sensitive, conflicting, unverified, invented numeric, endorsement and pressure claims within the known caption pipeline.                 |
| Captions             | Compare scene kinds/order, captions, subtext, disclosure and durations with Quill via Pixel's `assertFidelity`. Independently match decoded caption/subtext masks at three points in every scene.                                                                                                |
| Disclosure           | Validate script requirement/default text, Pixel's recorded per-scene IoU, and independently decoded disclosure masks. Validate known template bounds, text fit and font sizes.                                                                                                                   |
| Media rights         | Frozen product image membership and checksum/order; real render-copy image checksums. Flag unspecified declarations even when acknowledged, missing details for permission/license/program declarations, and explicitly contradictory notes.                                                     |
| Video                | Approved private-storage resolution; actual SHA-256 and byte size; FFprobe MP4 brand/container, H.264, yuv420p, 1080×1920, 30 fps, duration and reported frame count; unexpected streams rejected.                                                                                               |
| Decode / continuity  | FFmpeg decodes the entire video with `-xerror`; FFprobe reads all decoded presentation timestamps. Count must equal the storyboard and each timestamp must equal frame index / 30 within 2 ms. Presentation ordering is checked; encoded packet order with H.264 B-frames need not be monotonic. |
| Black sections       | Full-video FFmpeg `blackdetect`: ≥98% of pixels below 2% luminance for at least 100 ms. Exclude only the expected first 250 ms / final 400 ms fades. This does not detect every visually blank image.                                                                                            |
| Audio                | Confirm no audio stream. No narration, voice quality or audio synchronization is claimed.                                                                                                                                                                                                        |
| Platform preparation | Versioned per-platform reminders to check current commercial-content settings, labels and real-device overlays later. No social account is accessed or settings marked enabled.                                                                                                                  |

### Conservative timing and visual metrics

Duration tolerance is Pixel's existing 100 ms; reported and decoded frame counts
must match exactly. Scene samples occur 500 ms inside the start and end, plus
the midpoint. These proxies avoid Pixel's 250 ms fade-in, 400 ms fade-out and
possible 400 ms crossfades. Exact visual scene boundaries and continuous text
visibility between samples are **not** claimed. A brief caption defect at the
first sample is detected even when the midpoint and end sample match.

References use Pixel's own bundled fonts/layout and literal UTF-8 text files
(`drawtext`, expansion disabled). White glyph masks and the CTA's dark glyph
masks are compared to actual decoded RGB crops. IoU must be ≥0.60 at every
sample. Findings preserve timestamps, IoU and raw reference/sample SHA-256s.
No OCR is used. Known text fitting is checked without silently truncating it.

The disclosure is 32 px white over a 62% black box. This template and pixel
matching do not prove human readability, legal sufficiency or freedom from
platform overlays. The whole-video fades also fade the disclosure; this is
recorded as a warning requiring inspection. Generic human-review boundaries
remain warnings on an automated pass, rather than pretending those judgments
were machine verified. Photographs may contain unread claims; product-name
semantics, image relevance, misleading presentation, aesthetic quality and
arbitrary prose meaning remain outside deterministic QA. Final human approval
must inspect these limitations.

## Persistence and recovery

Migration `0006_vera_reviews` adds `vera_reviews` and `vera_findings`, plus
`task_results.kind = 'vera_review'`. Reviews store a versioned document and
checksum; ordered findings store structured evidence. A compact task result
references the review, exact video, verdict, version and checksum.

PostgreSQL triggers reject changes/deletions, cross-ticket/product pins, stale
fences, expired leases and finding inserts after completion. A deferred trigger
requires the complete finding set, matching task result and task completion in
the same transaction. A unique task ID permits one report per logical task.
Review versions increment under an advisory lock per deliverable. Only the
current fenced worker may persist through `deliverable.persist`.

QA reads immutable deliverables and uses separate temporary scratch directories;
it never updates Scout, Quill or Pixel outputs. SIGTERM aborts and releases the
task within the worker grace policy; SIGKILL leaves a lease for normal recovery.
Read-only checks may repeat. A crash before commit leaves no partial report; a
crash immediately after commit leaves one completed report. Lost workers cannot
commit after recovery or cancellation.

There are **zero automatic content revisions**. Findings recommend finite owner
or worker actions and new versions; the existing task's `maxAttempts` bounds
transient execution retries. Vera never enters a Scout/Quill/Pixel revision loop.

## API and ticket UI

- `GET /api/tickets/:ticketId/reviews?offset=0&limit=20`: deliverables,
  availability, task attempts/progress and review history. Offset 0–10000,
  limit 1–50; defaults 0/20. Task history is capped at 100.
- `GET /api/tickets/:ticketId/reviews/:reviewId`: immutable report, evidence,
  checksum verification and current/historical marker.
- `POST /api/tickets/:ticketId/runs`: existing strict local-only JSON API,
  `workflow: "vera-review-v1"`, `reviews: [{ productId, deliverableId }]`.

All endpoints use existing local-origin guards, UUID/ownership validation,
no-store responses and safe errors. Inputs cannot supply filesystem paths.
Evidence is rendered as React text, never HTML. Source script and Scout report
links resolve existing ticket-owned endpoints; video links use Pixel's secure
Range endpoint. There is no Approve or Publish action. QA pass is labelled
**Automated QA Passed** and **Awaiting Human Approval**; Pixel's independent
**Technically Verified** label is retained. Keyboard, light/dark themes,
360/375 px layouts, loading and offline-worker states are supported.

## Campaign handoff audit and explicit gate

`campaign-v1` remains **disabled**, even when all four production handlers are
registered. `workflowAvailable` checks the independent `CAMPAIGN_READY = false`;
`productionAvailable` uses that gate. `availableWorkflows` lists standalone
workflows only, and `selectWorkflow` refuses campaigns even if a caller passes
`productionAvailable: true`. Pixel and Vera planning require explicit hooks.

| Boundary audited                   | Existing behavior                                                                                                                        | Outstanding automatic handoff                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `planRun`                          | Freezes current products; standalone Quill needs selected report IDs; Pixel needs immutable manifests; Vera needs selected deliverables. | Freeze eligible campaign products, exact approved images and rights acknowledgements at creation.                                        |
| Scout persistence / `task_results` | Commits report plus compact result atomically under a fence.                                                                             | Resolve committed report through the upstream task; verify run/product ownership and pin its checksum for Quill.                         |
| Quill handler/context              | Reads `params.reportId` / checksum / version from standalone planning. Context carries no upstream results.                              | Resolve upstream Scout result idempotently; never select the latest report.                                                              |
| Pixel handler/context              | Reads `pixel_render_jobs` planned before execution; checks manifest and frozen inputs.                                                   | Resolve committed Quill result and construct its manifest using the campaign's frozen approved media/rights.                             |
| Vera handler/context               | Reads its frozen `veraPin`; no automatic task-result lookup.                                                                             | Resolve the exact committed Pixel deliverable from its upstream task and persist a verifiable pin.                                       |
| Dependency promotion               | A completed task makes descendants eligible; product DAGs isolate failures.                                                              | Promotion does not resolve or pin result payloads. Add and test transactional, idempotent per-product resolution before downstream work. |
| Worker/recovery                    | Existing leases, heartbeat, fencing, cancellation and attempts apply.                                                                    | Prove every new handoff against partial results, crashes, owner edits and multiprocess 1/3/10-product runs.                              |

Handler registration is therefore insufficient. Automated Phase 3 acceptance
remains unmet. No synthetic handler can bypass this gate in a production run.

## Backup, retention and operations

Format-3 backups still dump all database tables, now including immutable Vera
records, and retain the same Pixel video files without duplication. Backup and
restore additionally recompute review/finding checksums. Formats 1/2/3 remain
readable; no format bump is needed for database-only evidence. Sample RGB data
and rendered reference files are disposable scratch data, deleted after each
attempt. The durable evidence is the report's metrics, timestamps, hashes and
links to the retained original MP4/project/source records. Killed processes can
leave temporary `/tmp/deskverse-vera-*` scratch folders; these are never served
or included in backups. No retention/deletion API is introduced.

```bash
yarn db:migrate
yarn worker:start
yarn vera:verify                 # scratch DB/data, real MP4s, batches 1/3/10
```

The verifier renders genuine Pixel outputs from genuine persisted Scout/Quill
fixture-site records. It injects independent corrupt-video and rights gaps,
then tests SIGTERM/SIGKILL during QA, before/after-commit crashes, restart and
exactly one committed review. It backs up format 3 and restores the full chain
into another disposable database/data root. It never connects to owner data.

## Verification evidence

The execution ledger below records the completed regression verification.
Actual browser H.264 playback is a separate capability test; HTTP Range success
and FFmpeg decoding are not browser playback proof. The 24 existing WSL office
GPU failures remain separately classified in `e2e-environment.md`.

DV-006B may consume exact-version Vera reports, but human approval decisions,
revision management and publishing remain unimplemented and outside DV-006A.

### DV-006A execution ledger — 2026-11-22

Baseline: clean `main` at `bbc3fcc621c0b8c365c304afa71b6a058afca7b6`,
with migration 0005 applied. Installed Next.js route-handler and server/client
component guides were read before implementation. All destructive verification
used guarded scratch databases and temporary media roots.

| Check                                                | Passed | Failed | Skipped |
| ---------------------------------------------------- | -----: | -----: | ------: |
| Unit suite (`yarn test`)                             |    812 |      0 |       0 |
| Database suite (`yarn test:db`)                      |    133 |      0 |       0 |
| FFmpeg integration suite (`yarn test:integration`)   |     71 |      0 |       7 |
| Vera real-video negative controls (included above)   |     12 |      0 |       0 |
| Orchestrator verifier assertions                     |     14 |      0 |       0 |
| Scout verifier assertions                            |     17 |      0 |       0 |
| Quill verifier assertions                            |     15 |      0 |       0 |
| Pixel full verifier assertions                       |     16 |      0 |       0 |
| Vera 1/3/10-product verifier assertions              |     64 |      0 |       0 |
| Final Vera source/restore/pin/crash audit assertions |     32 |      0 |       0 |

The seven integration skips are the existing opt-in visual-effects benchmark
(`DESKVERSE_BENCH=1`), not Vera checks. Vera's 18 unit tests and 10 database tests
are included in the suite totals. Lint, type checking, formatting, production
build and whitespace checks passed; browser-suite totals are recorded separately
below after completion.

| Real QA batch | Automated pass | Needs revision | Needs owner input | Failed QA | Completed review tasks |
| ------------- | -------------: | -------------: | ----------------: | --------: | ---------------------: |
| 1 product     |              1 |              0 |                 0 |         0 |                      1 |
| 3 products    |              1 |              0 |                 1 |         1 |                      3 |
| 10 products   |              8 |              0 |                 1 |         1 |                     10 |

Rights gaps and post-pin MP4 corruption were injected independently. Correctable
visual defects were exercised by real-video negative controls: missing/clipped
disclosure, missing captions, a caption missing only near a scene's start, severe
black sections, wrong dimensions/codec/duration and unexpected audio. Corrupt
MP4 parsing, unavailable tools and altered bytes fail closed. A valid fixture
passed all executed technical/mask checks. These controls decode actual MP4s;
project metadata alone never supplies the outcome.

SIGTERM, SIGKILL, before-commit and immediately-after-commit crashes all
restarted to exactly one report per logical task. Lost-lease fencing,
cancellation, duplicate completion, atomic rollback, immutable pins/reviews/
findings, ownership and historical versions also passed database tests.

The full verifier backed up/restored **18 reviews, 628 findings and 14 video
lineages** in format 3. The final focused audit restored **5 reviews, 195
findings and one video lineage**, independently revalidated the original Scout,
Quill and manifest checksums, and compared upstream source records before/after
QA. Existing format-1/2/3 migration and restore regressions passed.

Migration `0006_vera_reviews` was applied locally; `yarn db:check` reports Ready.
All **24 pre-existing public tables** retain their exact original row hashes.
All **23 private files**, including **two existing MP4s** and seven Studio job
records, retain their checksums across migration/final verification. The owner
installation contained no Scout reports, Quill scripts or ticket-video
deliverables at baseline; real complete chains were created only in scratch
environments. Pixel's read-only reconciliation found no problems.

Initial regression failures were resolved explicitly: migration-forward expected
lists now include 0006; a render-queue test waits for the handler callback rather
than a 10 ms timer; crash verification chooses a normal task instead of an
intentionally faulted one; historical-review verification identifies the product
rather than assuming concurrent completion order. Workflow UI/tests now explain
the unverified handoffs instead of saying Vera is unbuilt. No product assertion
was weakened to accept a defect.

**NOT TESTED (two capabilities):** actual browser H.264 playback (no installed
compatible browser) and automatic full-campaign execution (deliberately disabled;
missing handoffs listed above). HTTP delivery and FFmpeg decoding are verified
separately. Human semantic/visual judgment, copyright permission and legal or
platform compliance certification are outside this deterministic ruleset.

The final database browser suite passed **43/43**, including all seven Vera
flows (real video, keyboard start, source/disclosure evidence, historical
versions, ownership/strict JSON, offline worker and 360/375 px theme checks).
There were no browser skips or failures in this isolated suite.

The ordinary Chromium suite finished with **69 passed, 24 failed, 0 skipped**.
Every failure belongs to the pre-existing office/living-office/mobile-office
specs and includes the same software-WebGL warning; there are **zero new
unclassified failures**. No office assertion, warning filter or browser safety
flag was changed. See [E2E environment](e2e-environment.md).

Final review also separated each video's latest QA pointer from the paginated
history list. The affected database suite passed **10/10** and the final rebuilt
Vera browser flows passed **7/7** again; these are rechecks of tests already
included in the totals, not additional unique test counts. A transient JSX
editing error was caught by lint/type checking and corrected before these final
runs. Final lint, type checking and formatting passed.

The independently usable DV-006A QA milestone is complete. DV-006B can consume
these immutable exact-version reports; it still needs to implement human
approval, rights/visual judgment and revision management. Full automatic
campaign readiness remains false.
