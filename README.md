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
| Motion     | Anime.js v4                                                   |
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
yarn dev               # http://localhost:3000  ·  showcase at /brand
```

Everything runs offline after `yarn install`, including the font.

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

| Command             | What it does                                    |
| ------------------- | ----------------------------------------------- |
| `yarn dev`          | Start the dev server (Turbopack)                |
| `yarn build`        | Production build                                |
| `yarn start`        | Serve the production build locally              |
| `yarn lint`         | ESLint (Next.js core-web-vitals + TypeScript)   |
| `yarn typecheck`    | Generate route types, then `tsc --noEmit`       |
| `yarn format`       | Prettier write (sorts Tailwind classes too)     |
| `yarn format:check` | Prettier check                                  |
| `yarn test`         | Vitest: token contrast + config integrity tests |
| `yarn check`        | lint + typecheck + format check + tests         |

## Project structure

```
src/
  app/
    layout.tsx          Root layout: font, theme provider, header, skip link
    page.tsx            Overview
    brand/page.tsx      Design-system showcase (/brand)
    globals.css         Design tokens (light/dark) + Tailwind theme mapping
    icon.svg            Favicon
  components/
    brand/              Logo, animated logo, showcase demos
    employees/          Status badge, employee card/avatar
    layout/             Header, section
    motion/             <Reveal> entrance wrapper
    theme/              Theme provider + switcher
    ui/                 shadcn/ui components
  config/               brand.ts, design-tokens.ts, employees.ts, employee-status.ts
  lib/                  motion.ts (Anime.js conventions), utils.ts
docs/                   brand-guidelines.md, animation-guidelines.md
tests/                  Vitest tests
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

**Out of scope:** the 3D office, Three.js/R3F, a database, authentication,
deployment and real AI integrations.

## Future milestones

- **DV-002: 3D virtual office.** Low-poly robot employees in a miniature
  futuristic office (Three.js / React Three Fiber), following the visual
  direction in the brand guidelines.
- **Dashboard shell.** Navigation, task board and activity feed built from the
  DV-001 components.
- **Local automation workflows.** Task pipelines runnable on your machine,
  starting with free/local tools.
- **Customer demonstration mode** _(idea only, not built)_: a scripted,
  offline walkthrough of the AI team using static data. See
  [brand guidelines §9](docs/brand-guidelines.md#9-ideas-parked-for-later-customer-demonstration-mode).

Deployment stays optional: the app is a standard Next.js project with
static-rendered pages, so it can later go to any Node host or a static/edge
platform without code changes. Nothing in DV-001 depends on a specific provider.
