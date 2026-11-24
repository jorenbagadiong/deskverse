# Automatic campaign handoffs (DV-006C)

The automatic campaign runs Scout, Quill, Pixel and Vera once for each selected
product. Open a Ready Affiliate Ticket and use **Start Automatic Campaign** in
its Workflow section when the installation reports a capable worker. Choose
each product and three to six still images in the desired display order. Confirm
media use for each product after choosing the images. The confirmation records
the owner's statement. The underlying license or permission determines usage
rights.

## Launch contract

Post to `/api/tickets/:ticketId/runs` with `requestId`, `ticketVersion`,
`mode: "production"`, `workflow: "campaign-v1"`, and a `campaign` array
containing `{ productId, assetIds, rightsAcknowledged: true }` per selected
product. Send one to 100 distinct products with three to six distinct image IDs
each. The API rejects other workflow selections in the same request. The
ordered selections and ticket version are part of the request checksum.
Identical replay returns the original run. A reused request ID with changed
inputs returns a conflict.

Every selected product needs a research reference separate from its affiliate
URL. Preflight verifies image ownership, type and actual bytes in private
storage. The planner then locks the ticket, rechecks Ready status, the ticket
version and the selected records against the frozen input. An invalid selection
leaves no run or tasks. The image order and acknowledgment are stored with a
separate checksum in the immutable product snapshot. Existing product snapshot
hashes keep their meaning for Scout, Quill, Vera and approval eligibility.

## Transaction boundaries

All three handoffs use the existing per-product dependency and result tables.
Under the run lock and task fence, the upstream artifact, task result, new
dependent input pin and dependency promotion commit together.

1. **Scout → Quill.** Read the report ID, version and checksum from the committed
   Scout task result. Verify its task, run, ticket, product and snapshot. Quill
   still applies its existing insufficient-evidence policy.
2. **Quill → Pixel.** Read the exact script from the Quill task result and verify
   the checksum and the Scout pin. Build the existing Pixel render manifest from
   that script and the frozen ordered images and acknowledgment. Pixel reopens
   and hashes those exact files before rendering. The render and full media
   verification run outside the planning and handoff transactions.
3. **Pixel → Vera.** Read the verified deliverable ID, version and hash from the
   Pixel task result. Verify exact lineage and pin the existing Vera review
   contract. Vera checks the actual persisted MP4 bytes and records a verdict.

A failed input pin leaves the upstream result available to inspect and marks
that dependent as needing input. Its later steps stay blocked. For corrected
selections or content, start a new campaign or use the standalone workflows.
A manual retry of a failed execution with valid pins keeps the original inputs.
Other products continue. Pause, resume and cancel use the existing workflow
controls. A crash before commit rolls back the transaction. A crash after
commit leaves one durable result and a complete dependent pin.

Passing Vera QA makes a video available for an explicit human decision when
the Approval Inbox eligibility policy passes. Negative QA still records its
findings. There is no automatic decision, revision render, scheduling or
publishing.

## Installation and verification

Use a local Linux or WSL worker with Scout retrieval configured, the production
Quill, Pixel and Vera handlers, FFmpeg/FFprobe and util-linux `flock`.
The worker checks these capabilities and advertises campaign support in its
heartbeat. Only a compatible worker can claim a campaign task. The same
installation-wide render gate continues to protect Pixel and Studio.

Migration `0008_automatic_campaign_handoffs` adds a campaign request hash
and immutable selection metadata to existing run and snapshot tables. It also
guards the one-time dependent pin and refuses claims from incompatible workers.
Existing format-3 backups include these columns through the PostgreSQL dump.
Restore into a separate empty target.

Run `yarn campaign:verify` with the guarded scratch database. It uses fixture
HTTP sources, real agent handlers and temporary media. Run the dedicated real
browser flow with `E2E_CAMPAIGN=1 E2E_CHANNEL=chromium yarn test:e2e:db`.
The opt-in is scoped to the disposable test database and worker. Use
`yarn test:db --no-file-parallelism` for the full PostgreSQL suite because
parallel FFmpeg workloads can hit Vera's existing deadline on the test VM.

## Verification evidence

The release candidate passed on a disposable Ubuntu 24.04 guest with
PostgreSQL 16, FFmpeg and FFprobe 6.1.1, and the Linux render gate.
The one- and three-product campaigns each produced a passing Vera review
per product. The ten-product campaign produced six passing candidates,
two rights blockers, one Quill insufficient-evidence outcome and one
injected Scout failure. An explicit retry advanced only the failed product.
A render-lock audit recorded 14 serialized Pixel renders.

The process-crash verifier passed all nine boundaries. It checked durable
pins, rollback, stale fences, duplicate prevention and reuse of verified
Pixel output. The preflight tests refused invalid selections without
creating a run. All three handoffs refused mismatched upstream result pins.
The populated format-3 restore preserved the frozen selections, committed
results, exact MP4 and explicit approval. Legacy backups from 0002 and
0003 restored and upgraded through 0008.

The final regression run passed 825 unit tests, 139 serial PostgreSQL tests,
71 integration tests with seven opt-in benchmarks skipped, and 11 focused
migration and backup cases. Lint, typecheck, formatting, production build,
diff checks and all workflow verifiers passed. The real campaign browser
case passed at 360 px and 375 px. All 45 database Chromium tests passed.
Ordinary Chromium completed with 71 passes and the same 24 individually
matched software-WebGL failures as the baseline.

`CAMPAIGN_READY` is enabled. Launch still requires a compatible worker
heartbeat, a Ready ticket and explicit owner selections.
