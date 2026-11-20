# 3D office architecture (DV-002)

The `/office` route is Deskverse HQ: an interactive, isometric, two-story
office where seven robot employees work. Every task state is **simulated**:
no AI agent runs, nothing is sent anywhere, and there is no database,
authentication or external API.

Stack: Next.js App Router, React 19, three.js r187, React Three Fiber 9, drei 10,
and Anime.js 4 for DOM transitions. There is no physics engine, postprocessing,
state library or downloaded asset.

## 1. Building structure

Deskverse HQ is one building with two physically stacked floors, drawn as an
open-front cutaway. The front and right walls are removed, so the camera always
looks into the interior.

| Part                                 | Where                                                    | Contents                                                                                                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Floor 1: Creative Production**     | Full footprint, x ∈ [-7, 7], z ∈ [-5, 5], y = 0          | Scout, Quill, Pixel and Vera in the open **atrium** (front half), reception, meeting table with hologram, hallways. Under the mezzanine: holographic project board (kanban), creative hot desks, coffee bar, wall panels |
| **Floor 2: Operations & Automation** | Mezzanine over the back half, z ∈ [-5, -0.5], y = 3.6    | Tempo, Relay and Ledger, live **operations board** (the team's simulated statuses), calendar wall, analytics monitor wall, lounge, glass railings overlooking the atrium                                                 |
| **Staircase**                        | Along the left wall from the front to the mezzanine edge | Floating treads, central stringer, glass balustrades                                                                                                                                                                     |
| **Shell**                            | Back and left walls, split per floor                     | Atrium windows with a skyline, light strips, columns under the mezzanine edge                                                                                                                                            |

Design decisions:

- **Atrium, not a stacked box.** Floor 1's desks sit in the open front half, so
  the upper floor never covers them from the isometric camera, even in the
  whole-building view.
- **Stairs on the far wall.** The staircase runs along the left wall (away
  from the camera), so it never occludes anyone.
- **Walls split per floor.** The upper walls belong to Floor 2. When Floor 2
  lifts away in Floor 1 mode, the building reads as a clean single-story room.

Constants live in `scene/camera-framing.ts` (`BUILDING`) and
`scene/building/building.tsx` (`STAIRS`).

## 2. Component structure

```
src/app/office/page.tsx                  Server Component: heading + <OfficeExperience>
src/components/office/
  office-experience.tsx                  Client root: reducer state, layout, 3D/2D display,
                                         WebGL detection, lazy scene, overlays
  floor-switcher.tsx                     Building / Floor 1 / Floor 2 (compact on mobile)
  camera-controls.tsx                    Rotate / zoom / reset buttons
  employee-list.tsx                      Keyboard list: one radio group per floor
  employee-details.tsx                   Detail panel: status, simulated actions, state picker
  activity-feed.tsx                      Simulated notifications
  office-map.tsx                         2D floor plan of both floors (fallback + optional view)
  scene-error-boundary.tsx, simulated-tag.tsx
  scene/                                 Everything that imports three.js (one lazy chunk)
    office-scene.tsx                     <Canvas>, lights, environment, floors, stations, nameplates
    camera-rig.tsx                       Orthographic camera, OrbitControls, modes, tweens
    camera-framing.ts                    Pure framing math (fit zoom, focus target) – tested
    building/building.tsx                Floor 1 + Floor 2 composition (batched)
    building/floor-group.tsx             Lifts Floor 2 away to reveal Floor 1
    building/architecture.tsx            Railing, window, column, staircase, plant, chairs, sofa
    building/furniture.tsx               Reception, meeting table, boards, coffee bar, walls…
    character/character.tsx              Shared character rig + frame-loop animation
    character/head.tsx                   Head shapes, face screen, eyes/mouth, 7 headgear pieces
    character/body.tsx                   Legs, torso, arms, 7 chest accessories
    character/marker.tsx                 Status bubble + floor ring
    character/geometry.ts                Proportions (RIG, HEADS, BUILDS) + geometry factories
    character/pose.ts                    Poses, working motion, transients – pure, tested
    character/expression.ts              Facial expressions – pure, tested
    workstation/workstation.tsx          Shared desk
    workstation/props.tsx                7 job-specific prop sets (animated only while working)
    shared/batch.tsx                     Merges static meshes per material (draw calls)
    shared/geometry-cache.ts             One instance of each shared geometry
    shared/shapes.ts                     Procedural shapes (rounded rects, arcs, lathes, bevels)
    shared/ambient.tsx                   Idle blink/glance scheduler (bursts, visibility-aware)
    materials.tsx                        Shared + per-identity materials, disposal
    palette.ts, frame-delta.ts
src/config/office.ts                     Typed registry: floors, desks, looks, tasks
src/lib/office-simulation.ts             Pure reducer: selection, view mode, statuses, activity
```

Data flows one way. `OfficeExperience` owns all state (`selectedId`, `view`,
`statuses`, `activity`). The 3D scene and DOM panels only render it, and the
scene only reports clicks.

## 3. Employee registry

`src/config/office.ts` (`officeEmployees`) holds, per employee:

| Field                                  | Purpose                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| `id`, `name`, `role`, `colorToken`     | From the shared roster (`src/config/employees.ts`); identity tokens are `--identity-*` |
| `agentTitle`, `summary`, `personality` | Detail-panel copy                                                                      |
| `glow`                                 | Bright identity color for 3D (equals the dark `--identity-*` token; tested)            |
| `floor`                                | 1 or 2                                                                                 |
| `workstation`                          | `research · writing · video · review · schedule · publish · analytics`                 |
| `look`                                 | Composable character design (below)                                                    |
| `desk`                                 | `[x, z]` on its floor                                                                  |
| `initialStatus`, `tasks`               | Simulated starting state and task copy per state                                       |

| Employee             | Floor | Color  | Head                   | Headgear                                  | Chest               | Build    | Resting face         |
| -------------------- | ----- | ------ | ---------------------- | ----------------------------------------- | ------------------- | -------- | -------------------- |
| Scout (Research)     | 1     | Teal   | soft                   | explorer cap + headlamp, handheld scanner | satchel             | standard | round, curious       |
| Quill (Scriptwriter) | 1     | Purple | tall                   | quill feather                             | floating notebook   | slim     | half-lid, focused    |
| Pixel (Video)        | 1     | Orange | screen (wide TV)       | studio headset + top camera               | film belt           | standard | big pill eyes, grin  |
| Vera (Quality)       | 1     | Blue   | soft                   | inspector visor + antenna                 | shield badge        | standard | narrow, observant    |
| Tempo (Scheduler)    | 2     | Violet | orb (curved visor)     | alarm bells + orbiting hour ring          | chest clock         | standard | half-lid, calm smile |
| Relay (Publisher)    | 2     | Coral  | capsule (curved visor) | messenger wings + broadcast antenna       | messenger bag       | slim     | round, grin          |
| Ledger (Analytics)   | 2     | Gold   | wide                   | analyst glasses                           | chest chart display | sturdy   | pill, flat           |

To add an employee: add a roster entry, an `--identity-*` token pair, and a
registry entry with a free desk. If needed, add a new `head`, `headgear`,
`chest` or `workstation` variant. Tests check uniqueness, roster consistency,
token colors and desk spacing.

## 4. Character modeling approach

**Procedural, no model files.** Blender wasn't available, and the runtime
shouldn't depend on it, so every character is built in code from smooth
primitives:

- **High-segment rounded boxes** (`RoundedBoxGeometry`, 6 segments) for heads.
- **Lathed profiles** (`smoothLathe`): Catmull-Rom curves revolved into the
  egg-shaped torso, the explorer cap and Relay's dish.
- **Extruded, beveled shapes** (`beveledPlate`) for face screens, the bezel,
  the shield badge, the feather, the wings and the glasses.
- **Curved visors**: partial spheres and cylinders for round heads. Eyes are
  projected onto the curved surface (`faceSurface`).

There is no third-party asset, so there is no license to track. Everything is
original and covered by the repository's license.

**Shared design language:** an oversized head (~45% of height), a compact egg
body with an identity waist band, two-joint arms with mitten hands, stubby
legs with colored toy feet, a glossy dark face screen with digital eyes and
cheek blush, and a colored bezel on boxy heads. Differences come only from
`look`, never from separate models.

**Materials:** clear-coated physical "toy plastic" for shells
(`MeshPhysicalMaterial`), a high-gloss face screen, identity accents per color
(cached), and unlit, tone-mapping-free glows for eyes and lights. A procedural
studio environment map (three's `RoomEnvironment` → PMREM, generated locally)
gives soft reflections with no HDR download.

## 5. Simulated task states

The five shared states (`idle`, `working`, `waiting`, `completed`, `failed`)
come from `src/config/employee-status.ts`. `src/lib/office-simulation.ts` is a
pure, unit-tested reducer:

- `select(id)` selects someone **and activates their floor**; `select(null)` keeps the view.
- `setView(view)` switches building/floor and drops a selection that is no longer visible.
- `setStatus(id, status)` updates the status and prepends an activity entry (max 4).
- `simulatedActions[status]` are the contextual buttons. The panel also offers
  "Set state directly". Every state is reachable from idle (tested).

"Simulated" tags mark the viewport, status block and activity feed, and the
announcement says "(simulated status)".

## 6. Animation architecture

| What                                                                                                                                      | Engine                          | Where                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------- |
| Poses, working loops, celebrations, shakes, waves, blinks, glances, bubble pop, selection chevron, Floor 2 lift, camera tweens, job props | R3F `useFrame`, writing to refs | `character.tsx`, `props.tsx`, `floor-group.tsx`, `camera-rig.tsx` |
| Detail-panel entrance, status message, list selection indicator, activity entrance                                                        | Anime.js scopes                 | `employee-details.tsx`, `employee-list.tsx`, `activity-feed.tsx`  |

**Pose model (pure):** `basePose(status, role)` + `workingMotion(role, t)` (a
role-specific loop) + `transient(status, secondsSinceChange)` (one-off
reactions). Every function is deterministic in time and covered by
`tests/character.test.ts`.

| State     | Pose                         | One-off                           | Face                                   | Marker                 |
| --------- | ---------------------------- | --------------------------------- | -------------------------------------- | ---------------------- |
| Idle      | Relaxed                      | none (ambient blinks and glances) | Personality                            | none                   |
| Working   | Role pose + loop (see below) | none                              | Focused (curious faces stay wide-eyed) | "•••" bubble           |
| Waiting   | Turns to the viewer, hand up | Hand wave (1.2 s)                 | Attentive, "o" mouth                   | Hourglass bubble       |
| Completed | Relaxed, arms out            | Hop + spin + arms up (1.2 s)      | Happy ^ ^, grin                        | Check bubble           |
| Failed    | Slumped lean, head tilt      | Shake (0.7 s)                     | Sad slanted **red** eyes, frown        | "!" bubble, red screen |

**Working loops by role:**

- Scout scans between two holo panels, sweeping the scanner.
- Quill types and glances up at the floating script pages.
- Pixel works the jog wheel while timeline clips slide.
- Vera scans the light table and stamps periodically.
- Tempo drags a scheduling tile across the calendar.
- Relay tosses data packets that fly up to the transmitter dish.
- Ledger keeps a hand on their chin and points at the live bar chart.

**Not playing everything continuously:**

- The canvas uses `frameloop="demand"`. A component calls `invalidate()` only
  while it is actually moving: a working loop, an unfinished ease, a bounded
  transient or a tween.
- Idle life comes from the **ambient scheduler**. Every 2.4 s, one employee in
  round-robin order blinks (every third tick, they glance). Each event is a
  frame burst of 0.16–0.9 s.
- The scheduler pauses when the route is hidden by Next.js's `<Activity>`
  (preserved route), the browser tab is in the background, or reduced motion
  is on.
- `frameDelta()` keeps easing at real-time speed on slow GPUs and starts
  smoothly after idle periods.

**Reduced motion:** poses snap, there are no loops, transients, blinks or
camera easing, and Floor 2 hides instantly. Anime.js scopes skip their
animations through `scope.matches.reduceMotion`. The state still reads through
pose, face, marker and color.

## 7. Camera and floor navigation

`camera-rig.tsx` + `camera-framing.ts`:

- **Projection:** orthographic, at the true isometric angle (polar
  `acos(1/√3)`, azimuth 45°).
- **Modes:**
  - **Building** frames the whole shell.
  - **Floor 1** frames the ground floor, and Floor 2 **lifts away** (rises 4.5
    units, then hides) so nothing above can obstruct a Floor 1 selection.
  - **Floor 2** frames the mezzanine.
- **Fit:** `fitZoom(box, viewport)` projects the mode's bounding box onto the
  camera axes, so framing is exact on any screen. A resize keeps the user's
  relative zoom.
- **Selection:** selecting an employee activates their floor, glides the target
  70% of the way to them, and zooms 1.45× (`FOCUS_ZOOM`). They also get a white
  floor ring, a chevron and a highlighted nameplate.
- **Limits:**
  - polar 0.55–1.15 rad (always above the floors)
  - azimuth 0.1–π/2−0.1 (always looking into the cutaway)
  - zoom 0.8×–3.2× of the mode's fit
  - no panning
  - orbit radius 40 with an orthographic camera, so there's no near-plane clipping through geometry
- **Controls:** drag/pinch, plus buttons for rotate, zoom and reset. Reset is
  pixel-exact: tweens snap onto the goal, and leftover OrbitControls momentum
  is flushed. Mobile hides the rotate buttons and uses compact `All / 1F / 2F`
  floor labels.

## 8. Accessibility and fallbacks

- **The canvas is never required.** The employee list (two radio groups, one
  per floor: Tab between floors, arrows within) and the detail panel expose
  everything. The canvas is `aria-hidden`; the viewport region has a text
  description.
- **Status is never color-only:** icon + label badges in the DOM, and
  distinct poses, faces and bubble glyphs in 3D.
- **One polite live region** announces selection and status changes.
- **No WebGL**, or a runtime WebGL failure, shows the **2D floor plan of both
  floors** (all seven desk buttons, fully operable). "2D map" can also be
  chosen at any time.
- Visible focus rings, reduced motion (see §6), and mobile layouts where the
  panels stack below the viewport.

## 9. Performance decisions

See §10 for the measurements.

- **Lazy, client-only 3D:** `next/dynamic(..., { ssr: false })`. Other pages
  load no three.js (covered by E2E tests).
- **DPR capped** at 1.75.
- **On-demand rendering**, with an idle GPU when nothing moves.
- **Batching:** `<Batch>` merges static meshes by material after mount:
  building floors, desks, character torsos, heads, legs, status bubbles and
  floor rings. Moving parts are flagged `userData.dynamic`. It re-merges only
  when its `version` changes (status, expression, theme).
- **One instance of every geometry** (`geometryCache`) and material
  (`SceneMaterialsProvider`, identity cache). Geometry buffers are released
  when the office is hidden or unmounted; materials are disposed on theme
  change or unmount; merged geometries on re-batch or unmount.
- **One shadow-casting light** (1024² PCF map, radius 3); shadow casting only on
  characters and large furniture. No point lights, no textures, no
  postprocessing.
- **No per-frame React state:** animation writes to refs; nameplates are
  positioned by writing styles directly.

## 10. Performance measurements

Measured on 2026-11-20 against the production build (`yarn build && yarn start`)
in Chrome (headless, Playwright), viewport 1280×900 (canvas 704×672), dark
theme. Draw calls and triangles were counted by instrumenting
`drawElements`/`drawArrays`, including the shadow pass.

**Test machine:** Mac with an Intel Core i5-6500 and an **AMD Radeon R9 M390
(2 GB)**, Chrome on ANGLE/Metal. Software rendering used Chrome's SwiftShader
on the same machine.

| Metric                                                 | Physical GPU (Radeon R9 M390)              | Software (SwiftShader)  |
| ------------------------------------------------------ | ------------------------------------------ | ----------------------- |
| Frame rate while Scout and Relay work (default scene)  | **60.2 fps** (median 16.7 ms, p95 16.7 ms) | 1.4 fps (median 850 ms) |
| Draw calls / frame, default scene, whole building      | 446                                        | 446                     |
| Triangles / frame, default scene, whole building       | 157,213                                    | 157,213                 |
| One static frame (reduced motion, Floor 1 view)        | 251 draw calls, 96,010 triangles           | same                    |
| Idle, reduced motion                                   | **0 draw calls** in 5 s                    | 0                       |
| Idle, motion allowed (blink/glance bursts only)        | 154 frames in 12 s (≈21% duty)             | 21 frames in 12 s       |
| First 3D frame after navigation (incl. shader compile) | ≈4.8 s                                     | ≈4.5 s                  |
| JS heap after load                                     | 40 MB                                      | 39 MB                   |
| DPR on a 3× display                                    | capped at 1.75                             | capped at 1.75          |
| 3D chunk (lazy, `/office` only)                        | ≈254 KB gzip                               | same                    |

**Effect of the optimizations** (one static frame, measured on the dev server):

|                                              | Main-pass draws | Shadow-pass draws | Triangles (main + shadow) |
| -------------------------------------------- | --------------: | ----------------: | ------------------------: |
| Phase B, first build (total, main + shadow)  |    484 combined |        (included) |                  ~520,000 |
| After adaptive bevels and lighter primitives |             356 |                62 |                  ~155,000 |
| Same, with `<Batch>` disabled                |             853 |               145 |                  ~155,000 |

Batching cuts per-frame draw calls by about 58% (≈998 → ≈418). Adaptive
geometry detail cuts triangles by about 70%. Phase A (one room, three robots)
used ≈226 draw calls. Phase B draws seven characters, seven desks and a
two-story building for about twice that.

**What this means:**

- On this GPU, a 2015-era discrete GPU, the office holds a steady
  60 fps while animating.
- Under software rendering it stays correct but is too slow for continuous
  animation (≈1–2 fps). On machines without GPU acceleration, use reduced motion
  (which renders only on change) or the 2D floor plan.
- These numbers come from one physical GPU. Other GPUs (integrated Intel, Apple
  Silicon, Windows/WSL setups) haven't been measured.
- **Possible next steps** if more employees or rooms are added: instance the
  identical parts across characters (eyes, limbs), merge per-character rigid
  groups further, and shrink the shadow-caster set.

## 11. Future integration points for real agent workflows

1. **Status source:** replace user-triggered `setStatus` dispatches with events
   from a local workflow runner (e.g. SSE from a Next.js route handler). The
   scene, list, ops board, panel and feed already react to `statuses`.
2. **Actions:** `simulatedActions` maps to commands (`approve`,
   `request-changes`, `retry`…). Swap `onSetStatus` for a command call and
   drop the "Simulated" tags for real runs.
3. **Tasks and artifacts:** replace `tasks[status]` copy with the runner's
   current task, progress and outputs per employee.
4. **Approvals:** the `waiting` state is the human-in-the-loop hook. Keep
   approvals in the DOM panel, not only in 3D.
5. **More people or rooms:** add registry entries and desks. Camera framing
   reads from `BUILDING`.
