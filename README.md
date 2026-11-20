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
yarn dev               # http://localhost:3000  ·  /office (3D) · /brand (design system)
```

Everything runs offline after `yarn install`, including the font and the 3D
scene (procedural geometry, no downloaded models or textures).

The 3D office needs a browser with WebGL (any current Chrome, Edge, Firefox or
Safari). Without it, `/office` shows a 2D floor plan with the same controls.
In WSL, run the browser on Windows as usual; the scene renders on your
Windows GPU.

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

If hot reload doesn't pick up changes (usually because the repo is under `/mnt/c`),
move the repo into the Linux home directory.

## Development commands

| Command             | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `yarn dev`          | Start the dev server (Turbopack)                    |
| `yarn build`        | Production build                                    |
| `yarn start`        | Serve the production build locally                  |
| `yarn lint`         | ESLint (Next.js core-web-vitals + TypeScript)       |
| `yarn typecheck`    | Generate route types, then `tsc --noEmit`           |
| `yarn format`       | Prettier write (sorts Tailwind classes too)         |
| `yarn format:check` | Prettier check                                      |
| `yarn test`         | Vitest unit tests (tokens, registry, poses, camera) |
| `yarn test:e2e`     | Playwright browser tests (builds + serves locally)  |
| `yarn check`        | lint + typecheck + format check + tests             |

## Project structure

```
src/
  app/
    layout.tsx          Root layout: font, theme provider, header, skip link
    page.tsx            Overview
    brand/page.tsx      Design-system showcase (/brand)
    office/page.tsx     Interactive 3D office (/office)
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
    theme/              Theme provider + switcher
    ui/                 shadcn/ui components
  config/               brand.ts, design-tokens.ts, employees.ts, employee-status.ts, office.ts
  hooks/                WebGL support + reduced-motion hooks
  lib/                  motion.ts (Anime.js conventions), office-simulation.ts, utils.ts
docs/                   brand-guidelines.md, animation-guidelines.md, 3d-office-architecture.md
tests/                  Vitest unit tests
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

## DV-002 scope: Deskverse HQ, a 3D office 🚧

Open http://localhost:3000/office.

- **Two-floor building** in an open-front isometric cutaway.
  - **Floor 1, Creative Production:** atrium workstations, reception, a meeting
    table with a hologram, a holographic project board, hot desks and a pantry.
  - **Floor 2, Operations & Automation:** a mezzanine with glass railings, a
    live operations board, a calendar wall, an analytics wall and a lounge.
  - A floating staircase joins the two floors.
- **All seven employees** as collectible-toy robots built on one shared rig.
  Each has a distinct head, headgear, chest accessory, build and personality face:
  Scout, Quill, Pixel, Vera, Tempo, Relay and Ledger.
- **Five simulated states** (idle, working, waiting for approval, completed,
  failed) for everyone. Each state has its own pose and facial expression, and
  working employees play a role-specific animation. Everything is labelled
  _Simulated_.
- **A living office:** employees walk between workstations along a waypoint
  graph (Dijkstra routes, collision-checked corridors, stairs between floors),
  take coffee breaks in the Floor 1 pantry and rest on the Floor 2 lounge sofa.
  Return to workstation / Visit the pantry / Rest in the lounge / Stop, plus
  optional ambient breaks (off by default). Movement is independent of task
  status; working employees stay at their desk.
- **Camera and floors:** Building / Floor 1 / Floor 2 modes. Selecting someone
  activates the floor they're on and the camera follows them while they walk.
  Floor 2 lifts away to reveal Floor 1. Full 360° rotation (walls in the way
  hide themselves), controlled zoom and an exact Reset view.
- **Full-width viewport and fullscreen:** the simulation spans the page with
  the team, details and activity cards below it; a Fullscreen button (Escape to
  leave) keeps the scene and selection intact.
- **Accessible by design:** a keyboard employee list per floor, a detail panel
  with live announcements, and a 2D floor plan of both floors when WebGL is
  unavailable (or by choice). It also supports reduced motion, light and dark
  themes, and mobile layouts.
- **Performance:** on-demand rendering (no frames when nothing moves),
  material batching, shared geometry and materials, a DPR cap, and a lazy 3D
  chunk that other pages never load.

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
navigation, floor switching, simulated states, walking to the pantry and
back, stopping mid-walk, the "busy at work" rule, instant cross-floor moves
under reduced motion, a full 360° turn back to the identical view, fullscreen
(enter, leave, rejected request), the full-width layout, the 2D fallback,
themes, reduced motion and DV-001 regressions.

- Reuse a running server: `E2E_BASE_URL=http://localhost:3000 yarn test:e2e`
- Use Playwright's Chromium instead of Chrome: `yarn playwright install chromium`,
  then `E2E_CHANNEL=chromium yarn test:e2e`
- In WSL without a desktop Chrome, use the Chromium option. WebGL tests need
  GPU or software rendering, which headless Chromium provides.

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
