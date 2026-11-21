# Affiliate Tickets (DV-004B)

An **Affiliate Ticket** is the owner's request: a named campaign holding one
or more products, each with its affiliate link, descriptions and facts,
reference links and media. Tickets live in local PostgreSQL. Their media
files live in Deskverse's private data folder on this computer.

DV-004B is **ticket management only**:

- Nothing is researched, written, rendered, reviewed, scheduled or
  published.
- Reference links are stored, never opened.
- A **Ready** ticket is only _eligible_ for future processing (DV-004C
  onwards).

## Contents

1. [Pages](#1-pages)
2. [Lifecycle](#2-lifecycle)
3. [Data model](#3-data-model)
4. [API](#4-api)
5. [Media](#5-media)
6. [Validation rules](#6-validation-rules)
7. [Activity history](#7-activity-history)
8. [Security](#8-security)
9. [Tests](#9-tests)
10. [Limitations](#10-limitations)

## 1. Pages

| Page                  | What it does                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tickets`            | Every ticket (number, title, status, priority, platform, product count, dates), newest change first. Search by title or number (`AFT-0007`, `7`), filter by status, 20 per page. |
| `/tickets/new`        | Title, description, instructions, platform, priority, publishing preferences. **Save Draft** creates the ticket and opens its workspace.                                         |
| `/tickets/[ticketId]` | The workspace: details, products, references, media, readiness, Mark Ready / Return to Draft / Archive / Restore, and the activity history.                                      |

Behaviour:

- **Unsaved changes are kept.** Every form keeps what you typed when a save
  fails (validation, conflict, server or database unreachable) and says why.
  Leaving the page with unsaved edits asks first.
- **Validation is checked in the browser first** with the server's own
  rules, for instant feedback; the server re-checks everything.
- **Large tickets:** products are collapsible cards with up/down ordering,
  so 10+ products stay manageable.
- **Small screens and keyboard:** works at 360 and 375 px, and by keyboard
  alone. Confirmation dialogs are accessible (Escape cancels), and focus is
  visible.
- **Uploads** show progress and a specific reason when a file is refused.

The header's **Tickets** link is always shown. Below 400 px, Overview and
Brand are hidden so the menu and the theme switcher fit (the logo is also a
home link).

## 2. Lifecycle

```
          mark ready (needs a valid title and ≥1 product with a name + valid affiliate link)
  Draft ─────────────────────────────▶ Ready
    ▲  ◀── return to Draft / any edit ──┘
    │
    └── restore ── Archived ◀── archive ── Draft or Ready
```

- **Drafts may be incomplete.** Every product field may be empty.
- **Media isn't required for Ready.** Each product shows its media
  completeness separately. Pixel's own requirement (3+ images) will be
  enforced by DV-005C.
- **Any content change returns a Ready ticket to Draft**, recorded as its
  own event. Content means ticket fields, products, references, media or
  order.
- **Archived tickets are read-only.** They are hidden from the default
  (Active) list, can still be opened, and can be restored to Draft. There
  is **no permanent ticket deletion** in DV-004B.
- **No other states.** There is no Processing, Approved, Published or
  Completed yet.

## 3. Data model

Migration `drizzle/0001_affiliate_tickets.sql` (schema in
`src/server/db/schema.ts`):

| Table               | Holds                                                                                                                                                                                           | Key rules                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `affiliate_tickets` | id (UUID), **number** (identity, shown as `AFT-0001`), title, description, instructions, priority, platform, publishing_preferences (jsonb), status, version, ready_at, archived_at, timestamps | number unique; status/priority/platform checked; ready_at set iff Ready; archived_at set iff Archived; title 3–120 characters   |
| `ticket_products`   | position, name, affiliate_url, description, specifications, notes, source, media_rights, media_rights_note                                                                                      | FK → ticket (`RESTRICT`); unique (id, ticket_id) for composite FKs; length checks                                               |
| `ticket_references` | kind, url, label, position                                                                                                                                                                      | FK (product_id, ticket_id) → product (`CASCADE`), so a reference can't name another ticket; unique (product, url); `^https?://` |
| `ticket_assets`     | kind, mime_type, extension, byte_size, sha256, width, height, duration_ms, original_name, position                                                                                              | same composite FK (`CASCADE`); kind/type/extension pairs checked; SHA-256 format checked                                        |
| `ticket_events`     | type, product_id, asset_id, details (jsonb), created_at                                                                                                                                         | FK → ticket (`RESTRICT`); no FK to products/assets, so history outlives them                                                    |

Design notes:

- **Ticket numbers** come from a PostgreSQL identity sequence: unique and
  atomic under concurrency (tested with 25 parallel creates). A rolled-back
  insert leaves a gap; numbering is deliberately not gapless.
- **IDs** are `gen_random_uuid()`. Foreign keys and file names use IDs,
  never titles or numbers.
- **Owner input only.** These tables hold exactly what the owner supplied
  (also recorded as table comments in the database). Future workers will
  write to separate deliverable tables and never update these rows.
- **Concurrency.** Every write locks the ticket row
  (`SELECT … FOR UPDATE`), so changes to one ticket are serialised.
  Positions and media limits stay consistent, and the activity event
  commits in the same transaction. `version` increases with every change.
  Ticket edits and status changes must send the current version (409 if
  another tab changed it).
- **Duplicate submissions.** Creating a ticket or adding a product carries a
  client request ID (`create_request_id`, unique). Repeating it returns the
  original instead of creating another.
- `app_metadata` is untouched.

## 4. API

All routes:

- are local-only (`guardLocalSystemApi`: loopback Host/Origin/Fetch-Metadata,
  and disabled on hosting platforms) and run on the Node.js runtime;
- return `Cache-Control: no-store` and validate strictly (unknown fields
  are refused);
- limit JSON bodies to 128 KiB;
- touch the database only when called, never during `next build`.

| Method & path                                                 | Body / query                                                                                      | Success                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `GET /api/tickets`                                            | `?status=active\|all\|draft\|ready\|archived&q=&page=&pageSize=` (≤ 50)                           | `{ tickets, total, page, pageSize }` |
| `POST /api/tickets`                                           | `{ requestId, title, description?, instructions?, priority?, platform?, publishingPreferences? }` | 201 `{ ticket }` (200 if repeated)   |
| `GET /api/tickets/:id`                                        |                                                                                                   | `{ ticket, events }`                 |
| `PATCH /api/tickets/:id`                                      | `{ version, fields: {...} }` or `{ version, status }`                                             | `{ ticket }`                         |
| `POST /api/tickets/:id/products`                              | `{ requestId, ...product fields }`                                                                | 201 `{ ticket, productId }`          |
| `PATCH /api/tickets/:id/products/:pid`                        | `{ ...product fields, references?: [...], position? }` (references replace the list)              | `{ ticket }`                         |
| `DELETE /api/tickets/:id/products/:pid`                       | none                                                                                              | `{ ticket }`                         |
| `POST /api/tickets/:id/products/:pid/assets`                  | raw file; `Content-Type`, `X-File-Name` (display only)                                            | 201 `{ asset }`                      |
| `GET /api/tickets/:id/products/:pid/assets/:aid[?download=1]` | `Range` supported                                                                                 | the file (200/206)                   |
| `DELETE /api/tickets/:id/products/:pid/assets/:aid`           | none                                                                                              | `{ removed }`                        |

Errors are `{ error, message, issues? }`, where `issues` are field problems
keyed by path, such as `references.1.url`:

| Status | When                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------- |
| 400    | invalid input, refused media                                                                   |
| 403    | not a local request                                                                            |
| 404    | unknown ticket, product or asset (including any ID that doesn't belong to that ticket/product) |
| 409    | stale version, archived ticket, not ready, invalid transition, limit reached                   |
| 410    | a registered file is missing or changed on disk                                                |
| 413    | too large                                                                                      |
| 415    | not JSON / unsupported type                                                                    |
| 503    | PostgreSQL not configured or unreachable (nothing saved), FFmpeg missing for upload checks     |

Raw SQL errors, driver messages, credentials and paths never reach a
response.

## 5. Media

```
<data dir>/tickets/<ticket id>/assets/<asset id>.<jpg|png|webp|mp4>
<data dir>/tickets/<ticket id>/staging/<asset id>.part      (uploads in progress)
```

`<data dir>` is Deskverse's existing data folder (`~/.local/share/deskverse`
on Linux/WSL, or `DESKVERSE_DATA_DIR`). Pixel Studio's `video/jobs/` beside
it is untouched.

| Kind   | Types                                  | Checks                                                                                                                                                        | Default limits                                       |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Images | JPEG, PNG, WebP                        | byte signature must match the declared type; header dimensions; FFprobe codec/size; FFmpeg decodes one frame cleanly (Pixel's checks)                         | 10 MB, 320–8192 px per side, ≤ 40 MP; 20 per product |
| Clips  | MP4 (ISO brands, not QuickTime `.mov`) | `ftyp` brand; FFprobe: MP4 container, a video stream (H.264, HEVC, AV1, VP9 or MPEG-4), size, duration; FFmpeg reads every packet and decodes the first frame | 200 MB, ≤ 300 s, 144–4096 px; 5 per product          |
| Ticket | all media                              | total bytes per ticket                                                                                                                                        | 2 GB                                                 |

- **Overrides** (whole numbers):
  - `DESKVERSE_TICKET_MAX_VIDEO_MB` (1–2048)
  - `DESKVERSE_TICKET_MAX_VIDEO_SECONDS` (1–3600)
  - `DESKVERSE_TICKET_MAX_STORAGE_MB` (1–102400)
- **Limits are enforced while streaming.** A declared `Content-Length` over
  the limit is refused before reading. Without one, reading stops at the
  limit and the partial file is deleted.
- **Clips are reference material only.** Pixel can't render from uploaded
  clips yet.
- **Without FFmpeg/FFprobe, every upload is refused (503)** with install
  steps. Nothing unverified is stored.
- **Files** are 0600, folders 0700, and symlinks are refused anywhere on the
  path. Only UUIDs become path segments. Upload names are kept for display,
  stripped of folders and control characters.
- **Previews and downloads** check that the asset belongs to that product of
  that ticket. The file must be a regular file of the recorded size. They
  are sent with `nosniff`, `default-src 'none'; sandbox`, same-origin CORP
  and `no-store`.

### Database/file consistency

PostgreSQL can't commit a file write, so uploads use stage-and-commit:

1. Stream to `staging/<id>.part`, hashing on the way.
2. Verify the bytes.
3. Rename into `assets/`.
4. Insert the record, with limits re-checked under the ticket lock.
5. If step 4 fails, delete the file.

**A record never points at a missing file.** A crash between steps 3 and 4
leaves an _unreferenced_ file. Deletion runs in reverse: the record first,
then the file, so a crash leaves an orphan, never a dangling record.

`yarn tickets:reconcile` reports both kinds of leftover and checks every
registered file's size and SHA-256. `--apply` deletes unfinished uploads and
**moves** orphans to `<data dir>/tickets-orphaned/<time>/`; it never deletes
them. Missing or damaged registered files are only reported: remove them in
the workspace and upload again.

## 6. Validation rules

- **Text** is normalised (NFC; single-line fields collapse whitespace;
  long text keeps paragraphs). Control and bidirectional-override
  characters are refused. Lengths are counted in characters:

  | Field                                          | Limit                         |
  | ---------------------------------------------- | ----------------------------- |
  | Title                                          | 3–120, with a letter or digit |
  | Description, instructions, product text fields | 5000                          |
  | Product name                                   | 120                           |
  | Source, rights note                            | 500                           |
  | Publishing schedule / notes                    | 200 / 1000                    |
  | Reference label                                | 200                           |

- **URLs** (affiliate and reference):
  - absolute `http(s)` only, with a dotted host name;
  - no user name or password, no spaces or control characters, ≤ 2048
    characters;
  - stored in normalised form;
  - `javascript:`, `data:`, `file:` and `ftp:` are refused.

  They are **never fetched, followed or downloaded**.

- **Affiliate links** may be empty in a Draft. A ticket needs at least one
  valid one to become Ready.
- **Structural limits:** at most 100 products per ticket (not a hard-coded 10) and 20 reference links per product (unique per product).

## 7. Activity history

Events are written in the same transaction as the change:

- ticket: created, edited, marked Ready, returned to Draft (by the owner, or
  because content changed), archived, restored;
- product: added, updated, moved, removed;
- media: uploaded, removed.

Each event holds the ticket, the product or asset ID where relevant, and
small details: changed **field names**, statuses, positions, counts, media
kind and size. It never holds URLs, file names, paths or typed text.
Unchanged saves record nothing. The workspace lists events newest first.
There is no simulated activity.

## 8. Security

- **Local only.** All endpoints are local-only, PostgreSQL listens on
  127.0.0.1, and media is in the private data folder (never `public/`).
- **Ownership is enforced at every level.** Each nested route matches the
  whole chain (ticket → product → asset) in SQL, and composite foreign keys
  make cross-ticket rows impossible in the database itself. Tested.
- **Every query is parameterised.** Searches escape `LIKE` wildcards.
- **No secrets in the browser.** The browser bundle contains no database
  code or credentials. Errors come from fixed message sets.
- The localhost guard is not authentication. DV-004B adds no accounts.

## 9. Tests

| Suite         | Command                               | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit          | `yarn test` (`tests/tickets.test.ts`) | validation, URLs, numbering, transitions, readiness, list queries, events, media sniffing/probe parsing, limits, paths, manifest v2, routes without a database                                                                                                                                                                                                                                                                                                                                                                    |
| PostgreSQL    | `yarn test:db`                        | `tickets.db.test.ts`: persistence, concurrent numbers, DB constraints, rollback, conflicts, lifecycle, archiving, cross-ticket isolation, racing uploads, pagination/search, reconnection, outage. `ticket-media.db.test.ts`: real FFmpeg uploads, signatures, truncation/corruption, streaming limit, failure cleanup, symlinks, cross-ticket media, removal, reconciliation. `backup-tickets.db.test.ts`: format 2 backup/restore with attachments, damage and symlink refusal, format 1 compatibility using DV-004A's own code |
| E2E, ordinary | `yarn test:e2e`                       | `ticket-states.spec.ts` (mocked list states); no database writes                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| E2E, database | `yarn test:e2e:db`                    | `tickets*.spec.ts`: the whole workflow with 10 products, uploads, Ready/Draft/Archive/Restore, app restart, PostgreSQL outage, removal, 360/375 px, keyboard only                                                                                                                                                                                                                                                                                                                                                                 |

The database E2E suite runs `scripts/e2e/database-server.ts`. It starts a
fresh `next start` on a guarded scratch database
(`deskverse_test_e2e_<pid>_<random>`, migrated from empty) with a temporary
media folder. The app reaches PostgreSQL through a local TCP proxy, so a
test can cut the database while the app runs. The server is never reused,
`E2E_BASE_URL` is refused, and everything is removed on exit; leftovers from
a killed run are removed at the next start.

## 10. Limitations

- **No permanent ticket deletion.** Archive instead.
- **No live updates between tabs.** A stale tab gets a 409 and a Reload
  button.
- **Uploads go one file at a time** per product card. There is no
  drag-and-drop and no resumable upload.
- **In-browser MP4 playback depends on the browser's H.264 support.**
  Playwright's bundled Chromium has none, so the E2E test checks the
  server's byte-range streaming there and marks playback "not tested".
- **Reconciliation is manual** (`yarn tickets:reconcile`); it doesn't run
  on a schedule.
- **Next: DV-004C, the Durable Campaign Orchestrator.**
