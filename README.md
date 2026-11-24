# Deskverse

> ⚠️ **Provisional brand name.** "Deskverse" is a working title and may change
> because of potential trademark conflicts. No domains or trademarks have been
> purchased or registered. The name lives in `src/config/brand.ts` so it can be
> renamed easily (see [brand guidelines §2](docs/brand-guidelines.md#2-name--renaming)).

Deskverse is a futuristic **AI automation office**: a professional SaaS
dashboard combined with an interactive, game-inspired virtual workplace staffed
by playful robot employees (Scout, Quill, Pixel, Vera, Tempo, Relay and Ledger).

The project is **local-first** and needs **no paid subscriptions**: no
hosted database, auth provider, cloud hosting, paid AI API or hosted workflow
engine. Everything runs on your own computer.

Deskverse is becoming a ticket-driven affiliate marketing platform: you
create an **Affiliate Ticket** with products, links and media, and the AI
team researches, writes, renders, reviews, schedules and tracks the content
(see the [roadmap](docs/ROADMAP.md)). Affiliate Tickets are stored in a
**local PostgreSQL** database (set up in DV-004A, used from DV-004B) and
their media in Deskverse's private data folder. Pixel Studio and the office
don't need PostgreSQL: they work with it stopped or not installed.

Vera now performs **automated quality review (DV-006A)** on an explicitly
selected completed Pixel version. The ticket workspace shows real video checks,
source evidence, rights gaps, actionable findings and historical reviews. QA
pass still awaits human approval. `campaign-v1` can run all four agents for
selected products when a compatible worker is online.
See [Vera quality assurance](docs/vera-quality-assurance.md).

## Tech stack

| Area       | Choice                                                        |
| ---------- | ------------------------------------------------------------- |
| Framework  | Next.js 16 (App Router, Turbopack, Server Components default) |
| UI         | React 19, TypeScript (strict)                                 |
| Styling    | Tailwind CSS v4 with semantic CSS-variable tokens             |
| Components | shadcn/ui (Radix primitives)                                  |
| Motion     | Anime.js v4 (DOM), React Three Fiber loop (3D)                |
| 3D         | three.js, @react-three/fiber, @react-three/drei               |
| Video      | Native FFmpeg + FFprobe on your machine (optional, DV-003)    |
| Database   | Local PostgreSQL 16 + Drizzle ORM (for Affiliate Tickets)     |
| Theming    | next-themes (dark default, light, system)                     |
| Icons      | lucide-react                                                  |
| Font       | Inter (self-hosted via `@fontsource-variable/inter`)          |
| Quality    | ESLint, Prettier (`semi: false`), Vitest                      |
| Package    | Yarn 4 (`nodeLinker: node-modules`)                           |

## Local installation

Requirements: **Node.js 20.9+** (22 LTS recommended) and **Corepack** (ships with Node).

```bash
git clone https://github.com/jorenbagadiong/deskverse.git
cd deskverse
corepack enable        # activates the Yarn version pinned in package.json
yarn install
yarn dev               # http://localhost:3000  ·  /office (3D) · /studio/pixel (video) · /brand
```

Everything runs offline after `yarn install`, including the font and the 3D
scene (procedural geometry, no downloaded models or textures).

The 3D office needs a browser with WebGL (any current Chrome, Edge, Firefox or
Safari). Without it, `/office` shows a 2D floor plan with the same controls.
In WSL, run the browser on Windows as usual; the scene renders on your
Windows GPU.

**Pixel Studio** (`/studio/pixel`) renders videos with FFmpeg installed on
your computer. It's optional: everything else works without it, and the
studio explains how to install it. In WSL: `sudo apt install -y ffmpeg` (see
[video architecture §2](docs/video-architecture.md#2-installing-ffmpeg-windows-11--wsl2-ubuntu)).
Because Pixel Studio accepts uploads and runs FFmpeg, start the server bound
to this computer only: `yarn dev -H 127.0.0.1`.

### Windows (WSL 2)

Working inside WSL is recommended over native Windows for file-watching speed.

1. Install WSL and Ubuntu from PowerShell (as admin): `wsl --install`, then reboot.
2. In the Ubuntu shell, install Node via [nvm](https://github.com/nvm-sh/nvm):
   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
   source ~/.bashrc
   nvm install 22
   corepack enable
   ```
3. **Clone into the Linux filesystem** (e.g. `~/projects/deskverse`), _not_
   `/mnt/c/...`. Projects on the Windows drive are much slower and hot reload may
   miss changes.
4. `yarn install && yarn dev`, then open http://localhost:3000 in your Windows
   browser (WSL forwards localhost automatically).
5. With VS Code, install the **WSL** extension and run `code .` from the Ubuntu
   shell.
6. For Pixel Studio, install FFmpeg **inside Ubuntu** (not on Windows), then
   verify it:
   ```bash
   sudo apt update && sudo apt install -y ffmpeg
   ffmpeg -hide_banner -version | head -1
   ffprobe -hide_banner -version | head -1
   ```
   Open http://localhost:3000/studio/pixel; the _Local FFmpeg_ card should say
   **Ready** (select **Check again** if the page was already open).

If hot reload doesn't pick up changes (usually because the repo is under `/mnt/c`),
move the repo into the Linux home directory.

## Development commands

| Command                    | What it does                                                      |
| -------------------------- | ----------------------------------------------------------------- |
| `yarn dev`                 | Start the dev server (Turbopack)                                  |
| `yarn build`               | Production build                                                  |
| `yarn start`               | Serve the production build locally                                |
| `yarn lint`                | ESLint (Next.js core-web-vitals + TypeScript)                     |
| `yarn typecheck`           | Generate route types, then `tsc --noEmit`                         |
| `yarn format`              | Prettier write (sorts Tailwind classes too)                       |
| `yarn format:check`        | Prettier check                                                    |
| `yarn test`                | Vitest unit tests (office, design, video engine)                  |
| `yarn test:integration`    | Real FFmpeg render tests, video + audio (needs FFmpeg)            |
| `yarn test:db`             | Real PostgreSQL tests on the test database only                   |
| `yarn test:e2e`            | Playwright browser tests (builds + serves locally)                |
| `yarn test:e2e:db`         | Affiliate Ticket browser tests on a scratch database              |
| `yarn check`               | lint + typecheck + format check + tests                           |
| `yarn db:migrate`          | Apply versioned migrations to `DATABASE_URL`                      |
| `yarn db:check`            | Read-only database status                                         |
| `yarn db:generate`         | Create a new migration from `src/server/db/schema.ts`             |
| `yarn db:backup`           | Offline backup: database + Pixel jobs + ticket media and videos   |
| `yarn db:backup:verify`    | Re-check a backup's checksums                                     |
| `yarn db:restore`          | Restore into an empty database and a new data folder              |
| `yarn tickets:reconcile`   | Check ticket media against the database (`--apply`)               |
| `yarn worker:start`        | Run the orchestrator worker (a separate process)                  |
| `yarn worker:check`        | Read-only worker, database and handler status                     |
| `yarn orchestrator:verify` | 10-product crash verification on a scratch database               |
| `yarn scout:check`         | Read-only Scout diagnostics (research, model, worker)             |
| `yarn scout:verify`        | Scout crash verification (scratch DB, fixture sites)              |
| `yarn scout:smoke`         | Bounded live check of one public reference page                   |
| `yarn quill:verify`        | Quill crash verification (scratch DB, fixture reports)            |
| `yarn pixel:verify`        | Pixel multi-process render verification (scratch DB, real FFmpeg) |
| `yarn pixel:reconcile`     | Check ticket videos against the database (`--repair`)             |

## Project structure

```
src/
  app/
    layout.tsx          Root layout: font, theme provider, header, skip link
    page.tsx            Overview
    brand/page.tsx      Design-system showcase (/brand)
    office/page.tsx     Interactive 3D office (/office)
    studio/pixel/       Pixel Studio, the video tool (/studio/pixel)
    tickets/            Affiliate Tickets: list, new, workspace (/tickets)
    api/studio/pixel/   Localhost-only capability, upload, render, status and video endpoints
    api/system/         Localhost-only database health endpoint
    api/tickets/        Localhost-only Affiliate Ticket, product and media endpoints
    globals.css         Design tokens (light/dark) + Tailwind theme mapping
    icon.svg            Favicon
  components/
    brand/              Logo, animated logo, showcase demos
    employees/          Status badge, employee card/avatar
    layout/             Header, section
    motion/             <Reveal> entrance wrapper
    office/             Office UI (floor switcher, list, detail panel, activity, camera controls, 2D map)
      scene/            three.js / R3F scene (lazy chunk)
        building/       Two-floor building, staircase, furniture, Floor 2 lift
        character/      Shared robot rig, heads, bodies, faces, poses (pure + tested)
        workstation/    Shared desk + seven job-specific prop sets
        shared/         Batching, geometry cache, procedural shapes, ambient scheduler
    studio/pixel/       Pixel Studio form, image picker, storyboard, FFmpeg status, render panel
    system/             "Local PostgreSQL" status card
    tickets/            Ticket list, forms, product editor, workspace
    theme/              Theme provider + switcher
    ui/                 shadcn/ui components
  config/               brand.ts, design-tokens.ts, employees.ts, employee-status.ts, office.ts
  hooks/                WebGL support + reduced-motion hooks
  lib/                  motion.ts (Anime.js conventions), office-simulation.ts, utils.ts
    video/              Video format, types, IDs, validation, storyboard, API contract (client-safe)
    system/             Database health report contract (client-safe)
  server/               Server-only: process runner, local-only guards, FFmpeg detection,
                        command builder, renderer, queue, private job storage
    db/                 PostgreSQL config, pool, Drizzle schema, migrations, health, test guards
    backup/             Offline backup, verify and restore (format 3: + ticket media and videos)
    tickets/            Ticket repository (transactions + events), media storage and checks
    orchestrator/       Runs, frozen inputs, task graph, claims/leases, worker, handlers (DV-004C)
    scout/              Scout research (DV-005A): safe retrieval (net/), extraction, claim
                        analysis, optional local model, handler, report storage
    quill/              Quill scriptwriting (DV-005B): claim selection, templates, validation,
                        optional local model, handler, script storage
    pixel/              Pixel ticket videos (DV-005C): render manifests, Quill-to-Pixel adapter,
                        disclosure-frame check, handler, deliverables, reconcile
drizzle/                Versioned SQL migrations (committed)
scripts/                yarn db:*, tickets:*, worker:*, orchestrator:*, scout:*, quill:*, pixel:* commands, setup-local.sh,
                        e2e/ database test server, scout/ fixture sites (tests only)
assets/fonts/inter/     Inter Bold + Medium (SIL OFL 1.1) for video captions
docs/                   ROADMAP.md, brand-guidelines.md, animation-guidelines.md,
                        3d-office-architecture.md, video-architecture.md, database-architecture.md,
                        affiliate-tickets.md, orchestrator.md, scout-research.md,
                        quill-scriptwriting.md
tests/                  Vitest unit tests (+ integration/: real FFmpeg, db/: real PostgreSQL)
e2e/                    Playwright browser tests
```

## DV-001 scope: Brand & design system ✅

- Next.js + TypeScript + Tailwind v4 + shadcn/ui foundation, managed with Yarn
- Semantic tokens for color, typography, spacing, surfaces, borders, status
  and elevation, in dark and light themes with WCAG AA contrast enforced by tests
- Original provisional SVG logo, wordmark and favicon
- Anime.js v4 patterns: logo entrance, card reveals, button feedback, status
  transitions, notifications and task progress, all scoped, reverted on
  unmount and reduced-motion aware
- `/brand` showcase page
- Documentation: [brand guidelines](docs/brand-guidelines.md), [animation guidelines](docs/animation-guidelines.md)

**Out of scope:** the 3D office (now DV-002), a database, authentication,
deployment and real AI integrations.

## DV-002 / DV-002B scope: Deskverse HQ, a 3D office 🚧

Open http://localhost:3000/office.

- **One large floor** (DV-002B Phase A) in an open-front isometric cutaway,
  with four rooms:
  - **Operations Room** (the largest): all seven workstations in two rows, a
    live operations board, an analytics wall and reception.
  - **Pantry:** coffee counter, fridge and a high table.
  - **Gaming & Rest Lounge:** three gaming stations, a sofa and a lounge chair.
  - **Meeting Room:** a conference table with seats for the whole team.

  The back rooms sit behind glass partitions with lit doorways onto the
  corridor, so they're clearly separate but never hide anyone. (DV-002 was a
  two-story building with a mezzanine and stairs; Phase A replaced it.)

- **All seven employees** as collectible-toy robots built on one shared rig.
  Each has a distinct head, headgear, chest accessory, build and personality face:
  Scout, Quill, Pixel, Vera, Tempo, Relay and Ledger.
- **Five simulated states** (idle, working, waiting for approval, completed,
  failed) for everyone. Each state has its own pose and facial expression, and
  working employees play a role-specific animation. Everything is labelled
  _Simulated_.
- **A living office:** employees walk between rooms along a waypoint graph
  (Dijkstra routes, collision-checked corridors and doorways). Return to
  workstation / Visit the pantry / Rest in the lounge / Go to a gaming station /
  Go to the meeting room / Stop, plus optional ambient breaks (off by default).
  Movement is independent of task status; working employees stay at their desk.
- **Camera and rooms:** Entire office / Operations / Pantry / Gaming Lounge /
  Meeting Room views. The camera follows a selected employee while they walk.
  Full 360° rotation (outer walls in the way hide themselves), controlled zoom
  and an exact Reset view.
- **Full-width viewport and fullscreen:** the simulation spans the page with
  the team, details and activity cards below it; a Fullscreen button (Escape to
  leave) keeps the scene and selection intact.
- **Accessible by design:** a keyboard employee list, a detail panel with live
  announcements, and a 2D plan of the four rooms when WebGL is unavailable (or
  by choice). It also supports reduced motion, light and dark themes, and
  mobile layouts.
- **Performance:** on-demand rendering (no frames when nothing moves),
  material batching, shared geometry and materials, a DPR cap, and a lazy 3D
  chunk that other pages never load.

**Next DV-002B phases (not started):** autonomous leisure routines,
interactive gaming, and simulated meetings with conversations.

Everything is procedural code: no downloaded models, textures or HDRs.
Details: [3D office architecture](docs/3d-office-architecture.md).

**Out of scope:** real AI agents, video generation, publishing/scheduling
integrations, affiliate APIs, authentication, database, multiplayer, paid
assets and deployment.

### Browser tests (Playwright)

```bash
yarn test:e2e
```

This builds the app, serves it on port 3210 and runs `e2e/` in your installed
Google Chrome (no browser download) at desktop, 375px and 360px widths, plus a
WebGL-disabled profile. It covers selecting all seven employees, keyboard
navigation, room views, simulated states, walking to the pantry, on to the
meeting room and back, stopping mid-walk, the "busy at work" rule, instant
room-to-room moves under reduced motion, a full 360° turn back to the identical view, fullscreen
(enter, leave, rejected request), the full-width layout, the 2D fallback,
themes, reduced motion and DV-001 regressions. Pixel Studio tests cover
navigation, form validation, image checks, the storyboard, accessible
controls, FFmpeg missing/ready feedback, render progress and failure messages
(mocked) and mobile layouts. `e2e/pixel-render.spec.ts` uses the real server
and FFmpeg: it uploads real images, renders, previews and downloads the MP4
(then checks it with FFprobe), and confirms invalid requests are refused.
`e2e/pixel-audio.spec.ts` covers the Audio card (mocked) and a real
voiceover + music render, download and AAC check. Real-FFmpeg tests are
skipped, with that reason, on machines without FFmpeg (or without AAC). E2E renders are
written to a throwaway folder in the system temp directory.

- Reuse a running server: `E2E_BASE_URL=http://localhost:3000 yarn test:e2e`
- Use Playwright's Chromium instead of Chrome: `yarn playwright install chromium`,
  then `E2E_CHANNEL=chromium yarn test:e2e`
- In WSL without a desktop Chrome, use the Chromium option. WebGL tests need
  GPU or software rendering, which headless Chromium provides.

**Known limitation (GPU-less WSL):** with headless Chromium in WSL, the 24
tests that render the 3D office fail, on `main` too. Chromium falls back to
software WebGL and logs a deprecation warning, which the suite treats as a
failure by design. Everything else passes. Run the office tests where Chrome
has a GPU (for example native Windows). Details and the exact list:
[E2E environment notes](docs/e2e-environment.md).

## DV-005C scope: Pixel, ticket video production ✅

Pixel renders a silent, captioned vertical video from a Quill script and
the product's own images. **Video only:** nothing is published, and the
full campaign stays unavailable until automatic pinned result handoffs and frozen media/rights selections are verified.

- **Pick the script and images:** in a Ready ticket's **Pixel Videos**
  section, choose a script and 3–6 images per product (confirm media
  rights if they're unspecified), then press **Start render** (worker:
  `yarn worker:start`, FFmpeg inside Ubuntu).
- **Exactly what Quill wrote:** captions, subtexts, durations and the
  affiliate disclosure come from the script's Pixel storyboard, checked
  scene by scene before rendering. Narration isn't voiced (no TTS); visual
  directions are guidance.
- **Stale input is refused:** images added or changed after a script need
  new research and a new script (mark Ready, run Scout, run Quill, then
  Pixel). The section says so.
- **One render at a time per computer:** a crash-safe render gate shared
  with Pixel Studio, which also works without PostgreSQL. Pixel Studio's
  own jobs, uploads and videos are untouched (ticket videos live in
  `<data>/ticket-renders`).
- **Verified before it's kept:** FFprobe (H.264, 1080×1920, 30 fps, no
  audio), the disclosure found in real frames of every scene, and a
  SHA-256. Each video is a versioned, immutable deliverable, committed
  with its task (migration `0005_pixel_deliverables`), labelled
  **Technically verified — Awaiting Vera QA**.
- **Crash-safe:** a verified output survives a worker crash and is reused;
  stale workers can't commit; `yarn pixel:reconcile` finds abandoned
  renders. Backups (format 3) include the videos.

Details: [Pixel ticket production](docs/pixel-ticket-production.md).

## DV-005B scope: Quill, evidence-grounded scriptwriting ✅

Quill writes short vertical affiliate video scripts from Scout research you
choose. **Scriptwriting only:** nothing is rendered or published, and the
full campaign stays unavailable.

- **Pick the research:** in a Ready ticket's **Quill Scripts** section,
  choose a Scout report per product and press **Start scriptwriting**
  (worker: `yarn worker:start`). Reports made before the product changed,
  or whose checksum fails, are refused: run Scout again.
- **Only safe facts become copy:** claims Scout found **supported** by a
  read, matched source; never prices, discounts, ratings, stock, delivery,
  warranty, health, certifications, comparisons, "best", conflicting or
  time-sensitive facts. Fewer than 2 safe facts asks you for input.
- **The script:** hook, 1–5 benefit scenes, call to action, captions,
  narration, visual directions and durations (Pixel's 15–30 s storyboard),
  plus the affiliate disclosure on every scene. Every factual scene lists
  its Scout claim and evidence.
- **Template mode** (no AI model) by default; optional **local AI wording**
  (Ollama, loopback, your model), every proposal validated and rejected
  if it adds facts, numbers, citations, experiences or guarantees.
- **Durable and exact:** immutable, versioned, checksummed scripts pinned
  to one exact Scout report and product snapshot, written in the same
  transaction that completes the task (migration `0004_quill_scripts`);
  the database itself refuses ineligible claims and stale workers.
- **Pixel checks without rendering:** Pixel text limits and image
  readiness (3–6 images) are shown separately from script validity.

Details: [Quill scriptwriting](docs/quill-scriptwriting.md).

## DV-005A scope: Scout, evidence-backed product research ✅

The first real AI employee. Scout reads the reference pages you add to
each product and checks your product facts against them. **Research only:**
it writes no scripts or videos, and the full campaign stays unavailable.

- **Turn it on** with `DESKVERSE_SCOUT_RETRIEVAL=on` in `.env.local`
  (off by default), restart the app and run `yarn worker:start`. Then use
  **Start research** in a Ready ticket's **Scout Research** section.
- **Only your references, safely:**
  - manufacturer pages first, at most 5 per product;
  - never the affiliate link, never links found inside pages;
  - honours robots.txt, never signs in or bypasses CAPTCHAs, paywalls or
    blocks, never runs page JavaScript;
  - SSRF-hardened: public addresses only (IPv4/IPv6, mapped forms), DNS
    pinned against rebinding, re-validated redirects (≤ 3), default ports,
    no credentials or cookies, bounded size, time and content types.
- **Evidence for every claim:** your Specifications and Description are
  marked _supported_, _conflicting_, _unverified_ or _insufficient
  evidence_, each citing short passages (with locations) from sources that
  were actually read and matched to the product. Prices, ratings and stock
  are time-sensitive; health, warranty, "best" and similar claims are
  flagged; none become selling points. Nothing is invented.
- **Honest about problems:** blocked, forbidden, login, paywall, CAPTCHA,
  JavaScript-only, rate-limited and mismatched pages are recorded; a
  product with nothing usable asks you for input; others carry on.
- **Durable and exact:** one immutable, versioned brief per product per
  run, written in the same transaction that completes the task, guarded by
  the orchestrator's lease and fence (migration `0003_scout_research`).
  Crashes, stale workers and retries can't produce a second brief. Edits
  need a new run (a new snapshot); old briefs stay readable and their
  checksums are re-verified on every read. Included in backups.
- **Optional local AI** through Ollama on loopback only, with a model you
  installed; its proposals must quote real passages or are rejected.
- **Commands:** `yarn scout:check`, `yarn scout:verify`, `yarn scout:smoke`.

Details: [Scout research](docs/scout-research.md).

## DV-004C scope: Durable campaign orchestrator ✅

The background engine that will run Affiliate Tickets through Scout →
Quill → Pixel → Vera, built and proven **without** any real AI work yet.

- **A separate worker process** (`yarn worker:start`) does the work. The
  web app only plans runs, records pause/resume/cancel/retry requests and
  shows persisted status.
- **Everything durable lives in PostgreSQL** (migration
  `0002_campaign_orchestrator`): runs, immutable per-product input
  snapshots, the task graph, attempts, leases, results and events.
- **Safe under concurrency and crashes:**
  - atomic claims;
  - leases with fencing tokens, so a late worker can't overwrite a newer
    result;
  - one committed result per task;
  - bounded retries with backoff;
  - dependency blocking that stops only the failing product;
  - recovery after a crash or `SIGKILL`;
  - one render-class task at a time across all workers.
- **Inputs are frozen** when a run starts. Edits don't change a running
  run, and a product or file an unfinished run uses can't be removed (409,
  explained in the page).
- **Workflow** section on each ticket: it says plainly that **full
  campaign automation isn't available yet** (Quill, Pixel and Vera arrive
  in DV-005B/005C/006A; Scout research runs on its own since DV-005A), and
  shows run status and valid controls.
- **Proved with deterministic verification runs:**
  - they run only on isolated test databases and are labelled test-only;
  - the 10-product crash verification (`yarn orchestrator:verify`) checks
    recovery, ordering, limits and no duplicate results across real worker
    processes.
- **Pixel Studio is unchanged** and still works without PostgreSQL. No
  ticket rendering path exists yet; DV-005C needs a render gate shared with
  Pixel Studio first.

Details: [orchestrator](docs/orchestrator.md).

## DV-004B scope: Affiliate Ticket management ✅

The first real, saved Affiliate Tickets. **Tickets** in the header opens
them.

- **Create a ticket** (`/tickets/new`):
  - a title, description, instructions, target platform (TikTok, Instagram
    Reels, YouTube Shorts, Other), priority and publishing preferences;
  - each ticket gets a number like **AFT-0001**.
- **Add products** in the ticket workspace (`/tickets/[ticketId]`):
  - name, affiliate link, description, specifications/facts, notes, source
    and media rights, plus reference links (listing, manufacturer, review,
    demo video, other);
  - one product or many (10+ is fine; up to 100), reordered with the arrows.
  - Links are stored only, never opened.
- **Upload media:**
  - JPEG, PNG or WebP images, checked like Pixel Studio's;
  - MP4 clips as reference material (Pixel can't render clips yet);
  - files are verified with FFmpeg and stored privately in
    `~/.local/share/deskverse/tickets/`.
- **Lifecycle:**
  - Draft → **Ready** (needs a product with a name and a valid affiliate
    link) → back to Draft on any change;
  - **Archive** (read-only, reversible) and **Restore**;
  - Ready only means _eligible for future processing_: nothing runs yet.
- **Activity history** of every saved change. It holds field names and
  counts, never your links or text.
- **Find tickets** on `/tickets`: search by title or number, filter by
  status, page through results.
- **Safe failures:**
  - if PostgreSQL is down, Deskverse says so and keeps what you typed;
  - edits from a stale tab are refused rather than overwriting.
- **Backups** (`yarn db:backup`) now include ticket media (format 2), each
  file checked against its recorded checksum. DV-004A backups still restore.
- **Pixel Studio is unchanged;** its jobs are not in the database.

Details: [Affiliate Tickets](docs/affiliate-tickets.md).

## DV-004A scope: Local PostgreSQL foundation ✅

The groundwork for **Affiliate Tickets**: a secure local database. No ticket
pages or workers yet; those start in DV-004B.

- **Install once:** `bash scripts/db/setup-local.sh` installs Ubuntu's
  PostgreSQL 16 and makes it listen on 127.0.0.1 only. It creates a
  dedicated app role and database and a separate test role and database,
  and writes random passwords to `.env.local` (mode 600). Your sudo
  password is typed into your own terminal and never stored. Then run
  `yarn db:migrate` and `yarn db:check`.
- **Configuration:** `DATABASE_URL` and `DATABASE_TEST_URL` in `.env.local`
  (template: `.env.example`, placeholders only). URLs must point at this
  computer; passwords never appear in logs, messages or the browser.
- **Migrations:** versioned SQL in `drizzle/` (Drizzle ORM + drizzle-kit),
  applied transactionally by `yarn db:migrate` and safe to repeat.
- **Status:** the overview page shows **Local PostgreSQL**: Ready, Not
  configured, Database not running or Connection failed, from
  `GET /api/system/database/health` (read-only, local-only, no secrets).
- **Backups:** `yarn db:backup` (with Deskverse stopped) saves the database,
  Pixel Studio's job files and uploads, finished videos and a checksummed
  manifest. `yarn db:restore` only restores into an empty database and a
  new folder.
- **Tests:** `yarn test:db` runs against throwaway `deskverse_test_*`
  databases only, never your development data.
- **Pixel Studio is unchanged:** its render jobs stay as files in
  `~/.local/share/deskverse/video/jobs`, nothing was migrated, and it keeps
  working with PostgreSQL stopped.

Details: [database architecture](docs/database-architecture.md).

## DV-003D3 scope: Voiceover timing & music loops ✅

Pixel Studio's **Audio** card now has practical timing controls for real
affiliate videos. Your files are never changed: everything happens while
rendering, on this computer.

- **Trim the voiceover:** choose **Trim start** and **Trim end** (in
  seconds; leave the end empty for the end of the recording). A 25 s take
  trimmed from 3.0 to 18.0 s gives 15.0 s of narration. Recordings may now
  be up to 5 minutes (30 MB), as long as the selection fits the video.
- **Start the narration later:** **Narration starts at** adds real silence
  before it, e.g. from 2.0 to 14.0 s of a 19 s video. Timing is
  sample-accurate (whole milliseconds = exact 48 kHz samples), and
  narration that wouldn't end by the end of the video is refused, never cut
  off.
- **See it:** the card shows the selected length, when the narration
  finishes and a timeline of the video; after you render, it also shows the
  timing the server approved (from FFprobe's real duration). Render History
  lists it too.
- **Loudness stays right:** the loudness measurement uses exactly the
  trimmed selection the mix uses.
- **Smoother music loops:** short tracks repeat with a short equal-power
  crossfade (20 % of the track, at most 1 s) instead of a hard cut, with no
  timing drift; the fade-out, ducking and peak limiting are unchanged. A
  crossfade removes clicks and level jumps, but it can't make unrelated
  beats line up.
- **MP3s with cover art:** one ordinary JPEG/PNG cover picture is fine; it's
  ignored and never reaches the video.
- **Older projects** keep working: without timing settings the whole
  narration plays from 0:00, as before.

Details and measurements:
[video architecture §5](docs/video-architecture.md#5-audio-voiceover-and-background-music-dv-003c-dv-003d3).

## DV-003D2 scope: Cinematic effects & EXIF orientation ✅

Pixel Studio's new **Visual effects** card adds gentle movement to the
rendered MP4, and phone photos now always come out the right way up.

- **Product motion:** **Gentle zoom** (default for new projects) slowly
  grows the product photo by about 5 % during each scene, smoothly and
  never cropped or stretched. The backdrop, captions and affiliate
  disclosure stay perfectly still. **None** keeps photos still.
- **Scene transitions:** **Crossfade** (default) dissolves each scene into
  the next over 0.3 s, centered on the scene change, without changing the
  video's length or frame count. **Cuts** change scenes instantly.
- **Fully static:** choose None + Cuts. Videos saved before this update
  have no effects setting and keep rendering static with cuts, including on
  retry. Retries always reuse the saved effects.
- **EXIF orientation:** sideways or mirrored phone JPEGs (all eight EXIF
  orientations) are turned upright exactly once, in a private normalized
  copy; your original upload is never changed, and the studio preview and
  the video agree. Large photos are also scaled to at most 2160 px there,
  which keeps renders fast.
- **Safe by design:** the browser sends only the two choice names; zoom
  amount, timing and FFmpeg filters are fixed on the server. If your FFmpeg
  lacks the `perspective` or `xfade` filter, the choice is disabled with an
  explanation and static videos still render.
- The storyboard preview stays a labeled still plan that names the chosen
  effects; the motion is only in the MP4. Your reduce-motion setting calms
  the page, not the video file.

Each scene is now encoded on its own and the pieces are joined without
re-encoding, so memory no longer grows with the number of scenes. Measured
on the development machine (four real photos, 19 s): gentle zoom + crossfade
renders in 16.3 s with an FFmpeg peak of 496 MiB, against 8.5 s / 458 MiB for
the static render before this update (six scenes: 19.8 s / 496 MiB). Details:
[video architecture §7](docs/video-architecture.md#7-visual-effects-and-exif-orientation-dv-003d2).

**Not in this phase:** pans, per-scene effects, other transition styles and
a moving preview (DV-003D3 and later).

## DV-003D1 scope: Reliable job management ✅

Pixel Studio is now built for repeated daily use. Every render is a job saved
on this computer, and the **Render history** card lists them, even after you
reload the page or restart the server.

- **Cancel** a queued render (it never starts) or a running one: the FFmpeg
  process is really stopped (SIGTERM, then SIGKILL after 2 s), nothing
  partial is kept, and the job shows as cancelled. Use **Cancel render** in
  the Render card, or Cancel in the history.
- **Retry** failed or interrupted renders with the files already uploaded:
  no re-upload. There are no automatic retries.
- **Preview and download** any completed video later, from the history.
- **Delete** a job (after confirming) to remove its images, audio, project,
  scratch files and video. Running jobs must be cancelled first.
- **Storage summary:** space used by uploads, videos and scratch files, and
  counts of completed, failed (including interrupted), cancelled and draft
  jobs. **Clean up temporary files** removes scratch files and drafts
  untouched for an hour; videos and failed jobs are kept.
- **Restart recovery:** after a restart, jobs that were rendering become
  "Interrupted" (failed, retryable), their partial files are removed, and on
  Linux/WSL any FFmpeg process left behind by the old server is stopped.
  Nothing is deleted automatically except abandoned drafts older than a day.

Measured on the development machine: real cancellation settles in under half
a second (FFmpeg stops cleanly), and rendering memory is unchanged (FFmpeg
peak about 470 MiB). Details:
[video architecture §6](docs/video-architecture.md#6-job-management-dv-003d1).

**Not in this phase:** transitions, motion, templates and audio editing
(transitions and motion arrived in DV-003D2).

## DV-003C scope: Voiceover & background music ✅

Pixel Studio's **Audio** card adds optional sound from your own files: **No
audio** (default, unchanged), **Voiceover**, **Background music** or
**Voiceover + music**.

- **Files:** MP3, WAV or M4A, up to 30 MB, mono or stereo. Identified by
  their bytes, checked with FFprobe (one audio stream; no video, cover art or
  extra streams) and fully decoded before they're accepted, then stored
  privately with your images. A voiceover can be at most as long as the
  video (+0.25 s); music up to 10 minutes.
- **Timing:** narration starts with the first scene and is followed by
  silence; narration longer than the video is refused rather than cut off.
  Music starts at 0:00, loops if it's shorter, and fades out over the last
  1.5 s. Audio is cut to the exact video length, so it can never change it.
- **Levels:** two-pass loudness normalization to −16 LUFS for speech (and
  for music alone). Under narration, music sits at a chosen level (low,
  medium, high), is ducked further while you speak, and a limiter prevents
  clipping.
- **Output:** one AAC-LC, 48 kHz, stereo track (192 kb/s target) muxed with
  the already-encoded H.264 video, which is copied, not re-encoded. FFprobe
  verifies both streams and their lengths, and the audio is fully decoded,
  before you can preview or download the video.
- **If FFmpeg can't do audio** (no working AAC encoder or missing filters),
  the audio options are disabled with the reason; silent videos still work.

**Licensing:** use only audio you own or are licensed to use commercially.
Deskverse doesn't fetch or check music; the studio shows this notice
whenever audio is chosen.

Measured on the development machine: adding audio costs 1.0–2.5 s per video
(silent 8.8 s, voiceover 9.8 s, music 10.4 s, both 11.3 s) with no change in
peak memory, and the mixes land at −16.1 to −16.3 LUFS. Details:
[video architecture §5](docs/video-architecture.md#5-audio-voiceover-and-background-music-dv-003c-dv-003d3).

**Not in this phase:** cancellation, retries and history (added in DV-003D1,
above), transitions and audio editing (trimming, offsets, crossfaded loops).

## DV-003B scope: First real product video ✅

Open http://localhost:3000/studio/pixel (with FFmpeg installed).

1. Add 3–6 product images and the product name, headline, 1–5 benefits,
   call to action and affiliate disclosure.
2. Check the storyboard preview, then select **Render MP4**.
3. Watch real progress: uploads, scenes composed, then FFmpeg's encoded
   seconds.
4. Preview the finished video in the page, then select **Download MP4**.

What happens on your computer:

- **Uploads** go only to the local server: size-limited while streaming,
  identified by their bytes, re-checked with FFprobe and a test decode, and
  stored privately under generated names in `~/.local/share/deskverse`.
- **The server rebuilds the storyboard** from the validated text and the
  job's own images. Client timings, captions, settings or FFmpeg options are
  rejected.
- **FFmpeg renders** each scene (blurred backdrop, the whole product image,
  balanced captions within mobile safe areas, the disclosure on every scene,
  in the bundled Inter font), then encodes H.264 `yuv420p` at 30 fps with
  the H.264 encoder that passed a real test encode (libx264 when available).
- **Every video is verified with FFprobe** (MP4, H.264, 1080×1920, 30 fps,
  `yuv420p`, 15–30 s, no audio) before it can be previewed or downloaded.
- **One render at a time**, with a bounded queue. Jobs interrupted by a
  server restart are marked failed, never completed.

On the development machine (16-core WSL2, CPU only), four 4K photos rendered
into a 19-second, 1.45 MB video in about 9 seconds, with FFmpeg peaking at
about 470 MiB. Run `yarn test:integration` for a real end-to-end render test.

**Not in this phase:** audio (added in DV-003C, above), cancellation,
retries, deleting jobs, transitions and motion (DV-003D), publishing and
affiliate APIs. Details,
security model, licensing and limitations:
[video architecture](docs/video-architecture.md).

## DV-003A scope: Pixel video engine foundation ✅

Open http://localhost:3000/studio/pixel.

Pixel Studio plans **9:16 affiliate product videos** (TikTok, Reels, Shorts)
from your own product images and captions. When rendering arrives, native
**FFmpeg assembles the media you supply**: it doesn't generate AI footage.

- **FFmpeg detection:** a server-only check of FFmpeg and FFprobe versions,
  required filters, available H.264 encoders (libx264 is never assumed) and
  AAC. A localhost-only endpoint returns it without paths or environment
  details. The studio explains clearly when FFmpeg is missing or unsupported
  and how to install it.
- **Fixed format:** 1080×1920, 9:16, 30 fps, H.264 MP4, 15–30 seconds, no
  audio until DV-003C. Clients can't change settings or pass FFmpeg arguments.
- **Strict types and validation** for products, images, scenes, captions,
  settings and render jobs, rejecting unknown fields, invisible characters,
  unsafe file types and oversized images.
- **Studio UI:** product name, images, headline, 1–5 benefit captions, call
  to action and affiliate disclosure, with a live storyboard preview, format
  summary and FFmpeg status.
- **Private storage foundation** in your user data folder (outside the repo
  and `public/`): isolated job folders, generated IDs, byte-level image
  checks, path-traversal and symlink protection, and cleanup.

Rendering, uploads and downloads followed in DV-003B (above).

## Future milestones

The plan from here is the Affiliate Ticket workflow in
[docs/ROADMAP.md](docs/ROADMAP.md). Next is **DV-005C: Pixel** (rendering Quill scripts through Pixel
Studio's pipeline and a shared render gate).
Earlier ideas:

- **Remaining AI team.** Quill, Vera, Relay and Ledger join the office using
  the same registry, robot and workstation components.
- **Dashboard shell.** Navigation, task board and activity feed built from the
  DV-001 components.
- **Local automation workflows.** Task pipelines runnable on your machine,
  starting with free/local tools.
- **Customer demonstration mode** _(idea only, not built)_: a scripted,
  offline walkthrough of the AI team using static data. See
  [brand guidelines §9](docs/brand-guidelines.md#9-ideas-parked-for-later-customer-demonstration-mode).

Deployment stays optional: the app is a standard Next.js project with
static-rendered pages, so it can later go to any Node host or a static/edge
platform without code changes. Nothing in DV-001 or DV-002 depends on a specific
provider.

### Vera QA operations (DV-006A)

Run `yarn db:migrate` for `0006_vera_reviews`, then `yarn worker:start`.
Select a completed video in **Vera Quality Review** and choose **Start Review**.
FFmpeg/FFprobe run locally; reviews never modify videos. `yarn vera:verify`
exercises 1/3/10 products, process crashes and isolated format-3 backup/restore.
No approval inbox, publishing, scheduling or external AI is added.

### Approval Inbox (DV-006B)

Open `/approvals` from the local Deskverse navigation to review exact video
versions, Vera findings and human decisions. Complete the checklist before
approving each video, including videos selected for a bulk decision. A recorded
approval is labelled **Human Approved — Not Scheduled**.

Run `yarn approvals:verify` against a guarded scratch database on Linux or WSL.
See the [Approval Inbox guide](docs/approval-inbox.md) for policy, history and backups.

### Automatic campaign handoffs (DV-006C)

The Workflow section supports an ordered, owner-confirmed Scout → Quill →
Pixel → Vera campaign with exact persisted handoffs. Use a Ready ticket and a
compatible Linux or WSL worker. See
[Automatic campaign handoffs](docs/automatic-campaign-handoffs.md) for the
launch contract, worker requirements and verification commands.
