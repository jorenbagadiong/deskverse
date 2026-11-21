# Deskverse

> ⚠️ **Provisional brand name.** "Deskverse" is a working title and may change
> because of potential trademark conflicts. No domains or trademarks have been
> purchased or registered. The name lives in `src/config/brand.ts` so it can be
> renamed easily (see [brand guidelines §2](docs/brand-guidelines.md#2-name--renaming)).

Deskverse is a futuristic **AI automation office**: a professional SaaS
dashboard combined with an interactive, game-inspired virtual workplace staffed
by playful robot employees (Scout, Quill, Pixel, Vera, Tempo, Relay and Ledger).

The project is **local-first** and needs **no paid subscriptions**: no
database, auth provider, cloud hosting, paid AI API or hosted workflow engine.

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

| Command                 | What it does                                           |
| ----------------------- | ------------------------------------------------------ |
| `yarn dev`              | Start the dev server (Turbopack)                       |
| `yarn build`            | Production build                                       |
| `yarn start`            | Serve the production build locally                     |
| `yarn lint`             | ESLint (Next.js core-web-vitals + TypeScript)          |
| `yarn typecheck`        | Generate route types, then `tsc --noEmit`              |
| `yarn format`           | Prettier write (sorts Tailwind classes too)            |
| `yarn format:check`     | Prettier check                                         |
| `yarn test`             | Vitest unit tests (office, design, video engine)       |
| `yarn test:integration` | Real FFmpeg render tests, video + audio (needs FFmpeg) |
| `yarn test:e2e`         | Playwright browser tests (builds + serves locally)     |
| `yarn check`            | lint + typecheck + format check + tests                |

## Project structure

```
src/
  app/
    layout.tsx          Root layout: font, theme provider, header, skip link
    page.tsx            Overview
    brand/page.tsx      Design-system showcase (/brand)
    office/page.tsx     Interactive 3D office (/office)
    studio/pixel/       Pixel Studio, the video tool (/studio/pixel)
    api/studio/pixel/   Localhost-only capability, upload, render, status and video endpoints
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
    theme/              Theme provider + switcher
    ui/                 shadcn/ui components
  config/               brand.ts, design-tokens.ts, employees.ts, employee-status.ts, office.ts
  hooks/                WebGL support + reduced-motion hooks
  lib/                  motion.ts (Anime.js conventions), office-simulation.ts, utils.ts
    video/              Video format, types, IDs, validation, storyboard, API contract (client-safe)
  server/               Server-only: process runner, local-only guards, FFmpeg detection,
                        command builder, renderer, queue, private job storage
assets/fonts/inter/     Inter Bold + Medium (SIL OFL 1.1) for video captions
docs/                   brand-guidelines.md, animation-guidelines.md, 3d-office-architecture.md,
                        video-architecture.md
tests/                  Vitest unit tests (+ integration/: real FFmpeg)
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
(DV-003D2 and later).

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
[video architecture §5](docs/video-architecture.md#5-audio-voiceover-and-background-music-dv-003c).

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
