# Pixel ticket video production (DV-005C)

Pixel turns a **Quill script** and the product's **own images** into a
silent, captioned 1080×1920 MP4. It uses the same FFmpeg engine as Pixel
Studio. **Video only:** Pixel publishes nothing, and the full campaign
(`campaign-v1`) stays off until automatic pinned result handoffs and frozen media/rights selections are verified. A finished video is
labelled **"Technically verified — Awaiting Vera QA"**.

## Using it

1. Add 3–6 still images (JPEG, PNG or WebP) to each product, mark the
   ticket **Ready**, then run Scout and Quill (see
   [Scout research](scout-research.md) and
   [Quill scriptwriting](quill-scriptwriting.md)).
2. In the ticket's **Pixel Videos** section, choose a script for each
   product. The section offers only scripts that verify and match the
   current product. Then choose 3–6 images. By default these are the
   script's images in product order.
3. If the product's media rights are **unspecified**, tick the
   confirmation. This records your statement; it doesn't prove you have
   permission.
4. Press **Start render**. Renders need a running worker
   (`yarn worker:start`) and FFmpeg inside Ubuntu.
5. Watch the progress: waiting for the renderer, composing scenes,
   encoding, verifying. You can **Cancel run** at any time, or **Retry** a
   failed or needs-input product.
6. Preview or **Download MP4** from the finished card. The card also shows
   the technical checks (resolution, fps, codec, duration, size, SHA-256
   and the disclosure-frame match).

What is and isn't rendered:

- **Captions:** each scene's caption and subtext, taken from the script's
  `pixel` block.
- **Disclosure:** the affiliate disclosure, on every scene.
- **Narration:** not rendered. Pixel makes no voice-over and no TTS
  (narration stays script text).
- **Visual directions:** treated as guidance. Pixel uses its fixed layout,
  with the chosen images in order.

### Images added after a script

A script is pinned to the product snapshot it was written from, including
its image list. Pixel refuses images that weren't in that snapshot, and
refuses scripts written before the product changed. The section and the
API both say what to do:

> To use new or changed images or details: mark the updated ticket Ready,
> run Scout again, write a new Quill script from the new research, then
> start Pixel with that script.

This is Quill's stale-input policy, and Pixel doesn't loosen it.

## How it works

### Workflow

`pixel-render-v1` has one stage, `pixel.render`. It creates one task per
product, uses resource class `render`, and has recovery `retry`. Starting a
run goes through `POST /api/tickets/:id/runs` with a `renders` list:

```json
{
  "productId": "…",
  "scriptId": "…",
  "assetIds": ["…", "…", "…"],
  "rightsAcknowledged": true
}
```

`rightsAcknowledged` is only needed when the media rights are
unspecified.

Planning (`src/server/pixel/plan.ts`) checks each choice against the
run's frozen snapshot, all in the same transaction that creates the run:

- the script is verified, current and the newest for its report;
- there are 3–6 images, with no duplicates;
- every image was in the script's snapshot, and its SHA-256 is unchanged;
- rights are confirmed where needed.

It then writes an immutable **render manifest** (`pixel_render_jobs`)
that pins:

- the script id, version and checksum;
- the Scout report id, version and checksum;
- the snapshot checksum;
- each image's id and SHA-256;
- the render configuration (`pixel-ticket-render/1`).

The manifest's own checksum is part of the task parameters. Database
triggers refuse any change to the pinned columns, and refuse deletes.

### Handler

`src/server/pixel/handler.ts` runs these steps for each task:

1. **Re-verify the inputs** (`adapter.ts`):
   - the manifest checksum;
   - script integrity and lineage (ticket, product, report, snapshot);
   - Quill's own validator;
   - Pixel's text limits;
   - the disclosure;
   - every image: opened safely, SHA-256, content sniffed and decoded by
     FFmpeg.

   A changed or missing image gives **needs input**. Anything else that no
   longer verifies is **permanent**.

2. **Build a trusted Pixel project:** `createJob` and `addImageAsset`
   under `<data>/ticket-renders`, then a project built from the script.
   **Fidelity** is checked before anything renders: scene count, kinds,
   captions, subtexts, durations (±1 ms), the disclosure and no audio.
3. **Wait for the render gate** (below), then render with Pixel Studio's
   `renderVideo`. Progress is written to the database about once a second,
   fenced by the task's lease.
4. **Verify the output**, still inside the gate:
   - FFprobe checks: H.264, yuv420p, 1080×1920, 30 fps, frame count and no
     audio;
   - the disclosure is found in real decoded frames of every scene (a
     glyph mask compared at IoU ≥ 0.6);
   - SHA-256.

   The MP4 is made read-only (0400).

5. **Commit** the deliverable (`pixel_deliverables`) in the same
   transaction that completes the task. The deliverable gets the next
   version for the product, under an advisory lock. Triggers refuse a
   deliverable unless its task is running in `pixel.render` with the
   current fence and matching manifest. Deliverables are immutable.

Execution is at-least-once and a committed video is effectively-once. If a
worker crashes after FFmpeg finished, the next attempt **reuses** the
completed Pixel job: it re-checks fidelity and runs every output check
again, instead of rendering again. A stale worker (an expired lease)
can't commit.

Failures and what happens next:

| Failure                                                         | Result                      |
| --------------------------------------------------------------- | --------------------------- |
| FFmpeg timeout or render failure                                | transient (retried)         |
| verification failure, disclosure not found, or FFmpeg not ready | permanent                   |
| changed or missing image                                        | needs input                 |
| one product failing                                             | other products still render |

### Render gate: one FFmpeg render per computer

`src/server/video/render-gate.ts` is shared by Pixel Studio (the Next.js
server) and every worker process. It works like this:

- **Exclusive lock.** `<data>/locks/render.lock` is opened by Node and
  locked with `flock(2)` (through the `flock` tool). The FFmpeg children
  inherit the locked descriptor.
- **A crash keeps the lock.** If the Node process is SIGKILLed, the lock
  stays held while its orphaned FFmpeg keeps running, so a second render
  can never overlap it.
- **Reaping abandoned renders.** A waiter checks the holders through
  `/proc/<pid>/fdinfo`. When the owner is dead, it stops the abandoned
  FFmpeg/FFprobe. It never stops a live owner or an unrelated FFmpeg.
- **No database needed.** Pixel Studio keeps working without PostgreSQL.
- **Cancellation.** Cancelling while waiting stops the wait (Studio shows
  waiting position 1).
- **Owner record.** `render-owner.json` holds an informational owner
  record (kind, job, pid).
- **Audit trail.** `DESKVERSE_RENDER_GATE_AUDIT=<file>` appends acquire
  and release events (used by the verification scenario). "released" is
  written before the lock closes and "acquired" only after it's taken, so
  the file's own order proves the holds never overlapped. Each event also
  carries a `CLOCK_MONOTONIC` time; wall-clock times can step backwards on
  WSL2 when it syncs the clock.

`renderVideo` refuses to run without a genuine lease.

### Storage

Ticket videos live **separately from Pixel Studio's jobs**, in
`<data>/ticket-renders/video/jobs/<job>/`:

- `job.json`
- `project.json`
- `assets/`
- `output/video.mp4`

Pixel Studio's job list, uploads and finished videos never see them and
are never changed. Studio's startup recovery skips ticket renders.

### Delivery API

| Endpoint                                          | Returns                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/tickets/:id/videos`                     | overview: products, scripts, images, latest run, deliverables, FFmpeg status |
| `GET /api/tickets/:id/videos/:deliverableId`      | one deliverable's metadata (no file paths)                                   |
| `GET /api/tickets/:id/videos/:deliverableId/file` | the MP4                                                                      |

The MP4 endpoint:

- supports single `Range` requests (206/416);
- accepts `?download=1` (attachment) and no other parameters;
- sends `Content-Type: video/mp4`, `X-Content-Type-Options: nosniff` and
  `Cache-Control: private, no-store`;
- serves only the file recorded for that ticket's deliverable, after
  checking its size;
- returns 410 if the file is missing.

## Operations

| Command                         | What it does                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `yarn pixel:reconcile`          | Read-only: checks every delivered MP4 against its record, lists active, reusable and abandoned renders |
| `yarn pixel:reconcile --repair` | Removes **only** abandoned ticket-render folders                                                       |
| `yarn pixel:verify`             | Full multi-process verification on a scratch database (below)                                          |
| `yarn worker:check`             | Shows whether the `pixel.render` handler is registered                                                 |

Backups (`yarn db:backup`, **format 3**) include each deliverable's Pixel
job folder, with every MP4 checked against its database record. Restore
re-checks them. Formats 1 and 2 are still readable.

### `yarn pixel:verify`

Runs batches of 1, 3 and 10 products (`--batches 1,3,10`, `--keep`) on a
scratch database and a temporary data folder. It uses real worker
processes, real Scout (fixture sites) and real Quill, and renders real
FFmpeg videos while Pixel Studio renders at the same time. During the run
it:

- SIGTERMs and SIGKILLs rendering workers;
- crashes workers during the render, after the output, and before the
  commit;
- damages one image.

A 50 ms process sampler and the gate audit log must show **at most one
FFmpeg at any moment**. The run passes only if:

- the gate holds never overlap, both in the audit file's order and on the
  monotonic clock;
- every product ends with exactly one verified deliverable, except the
  broken product, which needs input;
- reconcile, then repair, leaves no problems.

## Limits

- Silent videos only. There is no TTS and no music.
- MP4 clips attached to a product aren't used. Pixel renders still images
  only.
- Browser playback depends on the browser's H.264 support. The bundled
  Playwright Chromium has no H.264 decoder, so in-browser playback is
  checked with `canPlayType` only. File delivery, ranges and headers are
  fully tested.
- One render at a time per computer, by design.

## Vera review boundary (DV-006A)

Completed Pixel deliverables can now be reviewed through `vera-review-v1`, without rerendering. Pixel technical verification remains separate from Vera QA and human approval. Vera independently decodes the MP4, samples disclosure/captions near the start, middle and end of every scene, and pins the original render manifest. Pixel deliverable records and files remain immutable. Historical videos keep their original lineage.

See [Vera quality assurance](vera-quality-assurance.md) for the rules, limitations, recovery and campaign readiness audit.
