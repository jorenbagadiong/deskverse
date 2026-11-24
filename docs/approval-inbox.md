# Human Approval Inbox (DV-006B)

Open **Approvals** in the main navigation on the computer running Deskverse. The list shows Pixel deliverables with the latest Vera assessment and human decision. Filter by decision, QA status, platform or ticket. The historical filter finds superseded videos and archived tickets. The review detail also checks for changes to pinned product and campaign inputs, which can make a latest video historical.

Open a candidate to inspect the exact video, Quill scenes, captions, narration, Scout sources, disclosure, media rights and affiliate destination. The affiliate link opens only when you choose it. If the browser cannot play the preview, download the MP4 and inspect it in a compatible player.

## Approval policy

`approval-policy/1` requires the newest Pixel version for the product and the newest applicable Vera assessment. The server verifies the Scout, Quill, Pixel and Vera records against their original pins, compares the frozen input checksum to current inputs and hashes the stored MP4. The latest Vera report must verify, use `vera-review/1` and `vera-rules/1`, have a passing verdict and contain no blocking findings. An archived ticket, replaced video, changed inputs, damaged file or broken lineage blocks approval.

Select **Approve** to see an unchecked human checklist. Confirm the full video inspection, imagery, presentation, factual claims, visual disclosure, commercial media rights and exact affiliate destination. A license, permission or affiliate-program declaration requires a substantive supporting description. The declaration and checklist record what the owner reviewed and confirmed. Media permissions still depend on the underlying terms.

In **Pixel Videos**, check the image-use confirmation before starting a render
you intend to approve. Pixel records it with the selected images. If a video
was rendered without that confirmation, start a new render with it checked.

## Decisions and history

Migration `0007_approval_inbox` adds `approval_decisions`. Each immutable `approval-decision/1` event records the exact ticket and product, Pixel version and SHA-256, Vera version and checksum, prior event, owner notes, policy, request ID and timestamp. For approvals, the timestamp also records when the complete checklist was confirmed. Composite references enforce ownership and exact pins. A single root and a single successor per event prevent competing histories.

- **Human Approved — Not Scheduled** records a deliberate acceptance.
- **Revision Requested** requires a reason, category and expected correction. Scene IDs are optional. Make corrections in the applicable production stage and review a new Pixel version and Vera assessment.
- **Rejected** requires a reason and preserves the media and assessment. A later explicit decision can approve the same version if all current gates pass.
- **Withdrawn** requires a reason and records a successor to the approval. The original approval remains readable.
- **Pending** is derived when the video has no decision.

A newer Vera assessment invalidates the prior approval for current use, even if both assessments passed. The review shows the old approval and allows a deliberate decision against the newer assessment. An approval on a replaced video stays in history and never transfers to its successor.

The decision API requires a request UUID and expected previous decision ID. It locks the ticket and uses the same version locks as Pixel and Vera before rechecking eligibility. A stale tab receives HTTP 409. An identical retry receives the original immutable receipt. Read the detail API for current eligibility.

## Bulk review

Complete the checklist on each candidate and add it to the batch. The confirmation lists up to ten selected products and exact Pixel versions. The server checks each item independently and returns its outcome. Successful decisions persist even when another item is stale or blocked.

## Local access and backups

The API uses Deskverse's existing loopback and origin guards. Anyone who can operate the local installation under that access model may be able to record decisions. The audit trail records an explicit local action without asserting an authenticated identity.

Format-3 backups include decisions, checklists and revisions in the PostgreSQL dump and row-count manifest. Pixel MP4s remain in the existing media inventory. Older supported backups remain readable. Restore into a separate target before using a restored approval for future work.

## Future integration and verification

Tempo and Relay must revalidate the server-side `approvalEligibility` function immediately before using a video. Human approval creates no schedule or publication. The full campaign workflow still requires automatic handoffs and frozen selections.

Run `yarn approvals:verify` with the guarded test database, FFmpeg and the Linux or WSL render gate. It uses ten real Pixel videos and persisted Vera reports, exercises explicit decisions, concurrent requests and media checks, and restores into a disposable database and media directory.

### Verification on macOS

| Check                                                        | Result                                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lint, typecheck, formatting, production build and diff check | Passed                                                                                                                                           |
| Approval policy and input tests                              | 13 passed                                                                                                                                        |
| Full unit suite                                              | 722 passed, 1 skipped. The same 3 Linux render-gate suites failed to initialize on the starting commit.                                          |
| PostgreSQL suite                                             | 111 passed, 13 failed, 10 skipped                                                                                                                |
| Integration suite                                            | 12 passed, 9 failed. Seven suites could not initialize the Linux render gate.                                                                    |
| PostgreSQL upgrade and format-3 restore                      | 1 targeted test passed. The temporary restore included the new approval table and its constraints.                                               |
| Focused Chromium UI checks                                   | 2 passed using API fixtures                                                                                                                      |
| Chromium database suite                                      | 24 passed, 5 failed, 16 did not run. The real-video approval test stopped waiting for Pixel and the following mobile review test did not run.    |
| Ordinary Chromium suite                                      | Stopped after 17 passed, 8 failed, 2 interrupted, 68 did not run. The approval navigation fixture was corrected and passed in the focused rerun. |
| Workflow verifiers                                           | Orchestrator and Quill passed. Scout failed one verdict assertion. Pixel, Vera and Approvals could not complete on this host.                    |

The macOS run stopped at Pixel rendering because the production render gate
requires Linux or WSL and `flock`.

### Linux verification recovery

`yarn approvals:verify` passed on an isolated Ubuntu 24.04 guest with Node
22.20.0, Yarn 4.18.0, PostgreSQL 16, FFmpeg 6.1.1 and util-linux `flock`.
It rendered ten genuine MP4s, persisted ten Vera assessments and verified
that no decision existed before the explicit requests. Six independent
approvals and the revision, rejection and withdrawal records survived
database-backed race, replay, version and ownership checks. Missing or altered
media, broken lineage, a newer failing assessment, a newer video, product
edits and archive status each invalidated eligibility. A populated format-3
restore preserved the audit records, lineage and six eligible approvals.

The Linux unit suite passed 825 tests. The integration suite passed 71 tests
and skipped seven opt-in effects benchmarks. The initial database-browser
suite passed 43 tests, with one Approval Inbox failure and one dependent case
that did not run. The failure exposed that the Pixel screen only offered the
image-use acknowledgment for unspecified rights. The screen now offers it
for declared rights too, while rendering with declared rights remains
available without checking the box. The approval checklist and its pinned
rights checks still apply.

Both updated Approval Inbox tests passed in Chrome through the normal Pixel
screen. The real H.264 preview advanced playback and reported video frames.
The full Chromium database rerun passed all 45 tests with the same fix.
Both ordinary Chromium runs completed. Clean `main` had 69 passes and the
feature had 71. The same 24 office tests failed in both runs, and every
failure report included Chromium's software-WebGL warning.

The Orchestrator, Scout, Quill, Pixel, Vera and Approvals verifiers passed.
Vera's initial Linux run reached crash recovery and stopped because its worker
requires a scratch path under `/tmp`. The rerun used the default `/tmp` and
passed the crash and restore checks with the guard unchanged.

The Linux PostgreSQL run passed 131 tests and failed three. Two failures came
from the guest setup. The legacy backup test needed committed Git history,
and the database isolation test needed an empty database with `CONNECT`
revoked for the test role. All 21 tests in those files passed after those
disposable fixtures were added.

The full PostgreSQL rerun with those fixtures passed 128 tests and failed six
while the standalone Vera verifier was running. A Vera case reached its
180-second timeout, leaving a run active and causing four subsequent cases to
fail. All ten cases in the Vera database file passed when rerun alone with
the original timeouts and assertions.

The corrupted-MP4 upload assertion failed on the original `main` baseline. Its
packet-copy check and first-frame decode accepted the generated fixture. Decoding through the
rest of the video reported H.264 errors on stderr even when FFmpeg exited zero.
The separate MP4 validator fix at `9d885b13716aa09efe45685866d53289ec913de2`
decodes the full video and refuses decoder errors. The unchanged corruption
test and the later-frame corruption and cleanup test passed.

### Final Ubuntu integration

Run the complete PostgreSQL suite with `yarn test:db --no-file-parallelism`.
All 139 tests passed across 17 files in this configuration. The earlier
parallel Vera timeout remains an unresolved test-stability limitation. A
previous database Chromium run also saw a worker exit during the simulated
PostgreSQL outage. All 45 database Chromium tests passed in the final run.

The final run passed 825 unit tests, 71 integration tests with seven opt-in
benchmarks skipped, and 17 focused migration and backup/restore tests.
Both Approval Inbox tests passed in Chrome with the normal Pixel rights
confirmation. The playback check presented decoded H.264 frames.
Lint, typecheck, formatting and the production build passed.

The Orchestrator, Scout, Quill, Pixel, Vera and Approvals verifiers passed.
The approval run used ten real Pixel MP4s and ten persisted Vera assessments.
It recorded six independent approvals and restored the complete decision
history and all six eligible approvals from a populated format-3 backup.

Ordinary Chromium completed with 71 passes. The same 24 office tests as
the clean baseline reported the software-WebGL warning. See the
[E2E environment notes](e2e-environment.md) for the affected tests.

## Automatic campaigns

Automatic campaigns feed the same candidates and eligibility rules. Their Vera reviews never create human decisions.
See [Automatic campaign handoffs](automatic-campaign-handoffs.md).
