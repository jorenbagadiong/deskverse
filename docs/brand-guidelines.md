# Deskverse brand guidelines

> **Provisional brand.** "Deskverse" is a working name and may change because of
> potential trademark conflicts. No domains or trademarks have been registered.
> Treat the name and logo as placeholders until legal clearance.

The live reference for everything below is the `/brand` page (`yarn dev`, then
open http://localhost:3000/brand).

## 1. Personality

Deskverse is a futuristic AI automation office staffed by playful robot
employees. Visual tone: **professional but playful**.

- The dashboard is calm, dense and trustworthy, like a serious SaaS tool.
- Personality comes from the robot team, small motion details and warm accent
  highlights, never from clutter.
- Dark is the default theme ("night shift in a glowing office"); light is a
  full equal, not an afterthought.

## 2. Name & renaming

The brand name lives in one place: `src/config/brand.ts`.

```ts
export const brand = {
  name: "Deskverse",
  tagline: "Your AI automation office",
  description: "...",
  provisional: true,
  repositoryUrl: "...",
}
```

To rename:

1. Change `brand.name` (and the tagline/description if needed). The header,
   page titles, metadata, wordmark and copy all read from it.
2. Update the static favicon `src/app/icon.svg` if the mark changes (it cannot
   import TypeScript).
3. Set `provisional: false` once the name is cleared; the warning banner on
   `/brand` disappears automatically.
4. Update `package.json` `name` and this documentation.

## 3. Logo

**Concept:** a robot visor peeking through an office portal that sits on a desk:
the meeting point of "workspace" and "another world".

| Part   | Shape                       | Token                  |
| ------ | --------------------------- | ---------------------- |
| Frame  | Rounded square (rx 9 of 32) | `--primary`            |
| Portal | Arch doorway                | `--primary-foreground` |
| Desk   | Wide rounded bar            | `--primary-foreground` |
| Visor  | Rounded pill                | `--accent`             |

- Source: `src/components/brand/logo.tsx` (`LogoMark`, `Wordmark`, `Logo`).
- Animated version: `src/components/brand/animated-logo.tsx`.
- Favicon: `src/app/icon.svg` (dark palette, fixed hex values).
- Original artwork drawn for this project; it is not derived from any icon set.

**Usage rules**

- Minimum size: 16px for the mark. Below 24px, use the mark without the wordmark.
- Clear space: at least 25% of the mark's width on every side.
- The lockup is mark + wordmark set in Inter Semibold with tight tracking.
- Don't recolor parts outside the token mapping, add outlines, rotate, stretch
  or place the mark on busy imagery.
- The mark uses theme tokens, so it adapts automatically. Wrap a subtree in
  `.light` or `.dark` to force one palette locally.

## 4. Color

Components use **semantic tokens only** (e.g. `bg-primary`, `text-muted-foreground`,
`bg-surface-raised`), never raw hex values. Values are defined in
`src/app/globals.css` on `:root, .light` and `.dark`, and exposed to Tailwind v4
through `@theme inline`.

### Brand palette

| Token                | Dark      | Light     | Use                                |
| -------------------- | --------- | --------- | ---------------------------------- |
| `--background`       | `#080F1C` | `#F5F8FC` | App canvas                         |
| `--surface`          | `#111D2E` | `#FFFFFF` | Cards, panels                      |
| `--surface-raised`   | `#18273C` | `#FFFFFF` | Popovers, raised tiles             |
| `--surface-sunken`   | `#0B1424` | `#EAF0F7` | Wells, nested regions              |
| `--primary`          | `#2DD4BF` | `#087D76` | Main actions, focus, working state |
| `--secondary`        | `#A78BFA` | `#6A45D1` | Supporting actions, AI identity    |
| `--accent`           | `#FFB86B` | `#9A4A0A` | Highlights, approvals              |
| `--foreground`       | `#EAF3FF` | `#17202E` | Body text                          |
| `--muted-foreground` | `#9EB2C9` | `#4A5B70` | Secondary text                     |
| `--destructive`      | `#F87171` | `#C0262D` | Errors, destructive actions        |
| `--border`           | `#24364F` | `#D3DDE9` | Decorative dividers                |
| `--input`            | `#5A7394` | `#74859B` | Form control borders (≥ 3:1)       |
| `--ring`             | `#2DD4BF` | `#087D76` | Keyboard focus                     |

Each fill color has an `*-foreground` partner for text placed on it.

### Accessibility

`tests/design-tokens.test.ts` parses `globals.css` and enforces, in both themes:

- WCAG AA **4.5:1** for every text/background pair in use (body, muted, button
  labels, status text).
- **3:1** non-text contrast for the focus ring and input borders.
- That the `/brand` showcase metadata (`src/config/design-tokens.ts`) matches the CSS.

Other rules:

- Never communicate state with color alone. Status always shows icon + label.
- Every focusable element gets a 2px `--ring` outline with a 2px offset
  (global `:focus-visible` rule).

## 5. Typography

- **Inter** (variable), self-hosted from `@fontsource-variable/inter` through
  `next/font/local`. No network request at build or run time.
- Mono: system UI monospace stack, for IDs, timestamps and code.

| Utility         | Size / line-height | Weight | Use                 |
| --------------- | ------------------ | ------ | ------------------- |
| `text-display`  | 52px / 1.05        | 700    | Hero headlines      |
| `text-headline` | 32px / 1.15        | 650    | Page/section titles |
| `text-title`    | 20px / 1.3         | 600    | Card and sub-titles |
| `text-base`     | 16px / 1.5         | 400    | Body                |
| `text-sm`       | 14px               | 400    | UI labels, captions |
| `text-eyebrow`  | 12px, +0.12em      | 600    | Uppercase overlines |

Large sizes use negative tracking; body copy uses default tracking.

## 6. Spacing, radius & elevation

- Base unit: Tailwind's 4px spacing scale.
- Semantic spacing: `gutter` (16px), `gutter-lg` (32px), `stack` (24px),
  `section` (64px), `section-lg` (96px). Example: `px-gutter sm:px-gutter-lg py-section`.
- Content width: `max-w-content` (72rem).
- Radius: `--radius` 12px; cards use `rounded-xl`, pills use `rounded-full`.
- Elevation (theme-aware shadows):

| Utility          | Use                                      |
| ---------------- | ---------------------------------------- |
| `shadow-flat`    | Resting cards                            |
| `shadow-raised`  | Interactive tiles, notifications         |
| `shadow-overlay` | Hover lift, popovers, modals             |
| `shadow-glow`    | The single most important/active element |

Sunken surfaces (`bg-surface-sunken`) have no shadow.

## 7. Employee status language

| State                | Token                | Icon          | Motion (when allowed)                    |
| -------------------- | -------------------- | ------------- | ---------------------------------------- |
| Idle                 | `--status-idle`      | Moon          | None; calm and neutral                   |
| Working              | `--status-working`   | Loader circle | Pop-in, then a few halo pulses that stop |
| Waiting for approval | `--status-waiting`   | Hourglass     | Pop-in; warm accent draws attention      |
| Completed            | `--status-completed` | Circle check  | Pop-in + small upward "hop"              |
| Failed               | `--status-failed`    | Circle alert  | Pop-in + short horizontal shake          |

Labels and descriptions live in `src/config/employee-status.ts`.
`<StatusBadge>` renders the pill.

## 8. 3D employees and Deskverse HQ

Implemented in DV-002 at `/office`: all seven employees in a two-story office.
How it is built: [3d-office-architecture.md](3d-office-architecture.md).

### World: Deskverse HQ

- A **premium miniature office** in an open-front isometric cutaway. Floor 1
  (Creative Production) has an open atrium. Floor 2 (Operations & Automation)
  is a mezzanine with glass railings, joined by a floating staircase.
- **Professional first, never neon-heavy.** Glow is reserved for screens,
  identity strips, edge lights and status. Warm details (wood, coffee bar,
  amber downlights, plants) balance the teal and violet.
- **Themes:** the room switches between a navy night office and a cool
  blue-grey day office. Identity and status glows keep their bright values in
  both themes.
- **The characters stay the visual focus:** surfaces are calm and furniture is
  rounded and quiet.

### Characters: collectible-toy robots

- **Proportions (one shared rig):** an oversized head (~45% of height), a
  compact egg-shaped body, two-joint arms with mitten hands, and stubby legs
  with colored toy feet.
- **Face:** a glossy dark screen (with an identity-colored bezel on boxy heads)
  showing digital eyes, a mouth and soft cheek blush. Expressions change with
  status, so the face is the main emotional channel and must stay visible from
  the office camera.
- **Materials:** clear-coated white plastic shells, painted identity accents,
  and unlit glowing eyes. No textures.
- **Distinct silhouettes:** each employee differs in head shape, headgear,
  chest accessory and build, not only color (enforced by tests).
- **Identity colors** are `--identity-*` tokens: a bright value for 3D and dark
  UI, and a darker, text-safe value for light UI (WCAG AA, tested).

| Employee | Role           | Color token               | Head                  | Headgear                                  | Chest               | Personality                          |
| -------- | -------------- | ------------------------- | --------------------- | ----------------------------------------- | ------------------- | ------------------------------------ |
| Scout    | Research       | `--identity-scout` teal   | Soft rounded          | Explorer cap + headlamp, handheld scanner | Satchel             | Curious explorer (round eyes)        |
| Quill    | Scriptwriting  | `--identity-quill` purple | Tall rounded          | Quill feather                             | Floating notebook   | Focused storyteller (half-lid eyes)  |
| Pixel    | Video          | `--identity-pixel` orange | Wide screen           | Studio headset + camera                   | Film belt           | Expressive creative (big eyes, grin) |
| Vera     | Quality Review | `--identity-vera` blue    | Soft rounded          | Inspector visor + antenna                 | Shield badge        | Observant inspector (narrow eyes)    |
| Tempo    | Scheduling     | `--identity-tempo` violet | Orb, curved visor     | Alarm bells + orbiting hour ring          | Chest clock         | Calm organizer                       |
| Relay    | Publishing     | `--identity-relay` coral  | Capsule, curved visor | Messenger wings + broadcast antenna       | Messenger bag       | Energetic messenger                  |
| Ledger   | Analytics      | `--identity-ledger` gold  | Wide rounded          | Analyst glasses                           | Chest chart display | Analytical thinker (sturdy build)    |

### State visuals in 3D

| State     | Pose and motion                                                            | Face                        | Marker                 |
| --------- | -------------------------------------------------------------------------- | --------------------------- | ---------------------- |
| Idle      | Relaxed; occasional blink and glance                                       | Personality face            | none                   |
| Working   | Role-specific loop (scan, type, edit, inspect, schedule, publish, analyze) | Focused                     | "•••" bubble           |
| Waiting   | Turns to the viewer, raises a hand, short wave                             | Attentive "o"               | Hourglass bubble       |
| Completed | One hop and spin with arms up, then relaxed                                | Happy ^ ^ and grin          | Check bubble           |
| Failed    | Slumped, head tilted, short shake                                          | Sad slanted red eyes, frown | "!" bubble, red screen |

Every 3D state also appears as a 2D `StatusBadge` in the UI, and all 3D motion
respects `prefers-reduced-motion`.

### Asset licensing

All 3D content is procedural code in this repository: no downloaded models,
textures, fonts or HDR files. There is nothing third-party to attribute.
If GLB models are added later, store them in the repository with their source
and license recorded next to them (e.g. `public/models/LICENSES.md`), and only
use assets with clear redistribution rights.

## 9. Ideas parked for later: customer demonstration mode

**Idea only, not built.** A "demo mode" could let a prospective customer watch
the AI team run a scripted, offline scenario (e.g. research → script → review
→ publish) using static sample data, with guided captions, a reset button and
no real integrations or accounts. It would reuse the status language,
notification and progress patterns established here. Revisit after the 3D
office (DV-002) exists.
