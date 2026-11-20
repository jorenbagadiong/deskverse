# 3D office architecture (DV-002 / DV-002B)

The `/office` route is Deskverse HQ: an interactive, isometric, single-floor
office where seven robot employees work, take breaks and meet. (DV-002 built
it as a two-story building; DV-002B Phase A turned it into one large floor,
see §13.) Every task state is **simulated**:
no AI agent runs, nothing is sent anywhere, and there is no database,
authentication or external API.

Stack: Next.js App Router, React 19, three.js r187, React Three Fiber 9, drei 10,
and Anime.js 4 for DOM transitions. There is no physics engine, postprocessing,
state library or downloaded asset.

## 1. Floor plan

Deskverse HQ is one large floor (18 × 13 units, y = 0 everywhere) drawn as an
open-front cutaway. The front (+z) and right (+x) sides are open; the back and
left outer walls hide themselves when the camera orbits behind them (§12), so
the camera sees into the interior from every horizontal angle.

```
   z -6.5 ┌──────────────┬────────────┬───────────────┐
          │ Meeting Room │   Pantry   │ Gaming & Rest │
          │  (8 seats)   │ (3 spots)  │ Lounge (3+3)  │
   z -2.2 ├────door──────┴───door─────┴────door───────┤  glass partitions
          │  corridor z = -1.3                        │
          │  desks row 1: Scout Quill Pixel Vera      │  Operations Room
          │  aisle z = 2.3                            │
          │  desks row 2:   Tempo Relay Ledger        │
   z  6.5 └───────────────────────────────────────────┘
        x -9                 (camera side)          x 9
```

| Room                     | Bounds (x, z)                   | Contents                                                                                                                                                                       |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Operations Room**      | [-9, 9] × [-2.2, 6.5] (largest) | All seven workstations in two rows, the corridor along the back rooms, reception, live **operations board** and analytics wall on the left wall, plants                        |
| **Meeting Room**         | [-9, -3] × [-6.5, -2.2]         | Conference table with a hologram and **eight chairs** (seats for the whole team), calendar wall, skyline window                                                                |
| **Pantry**               | [-3, 2.5] × [-6.5, -2.2]        | Counter with a coffee machine, fridge, shelves, a high table with stools; three standing spots                                                                                 |
| **Gaming & Rest Lounge** | [2.5, 9] × [-6.5, -2.2]         | Three **gaming stations** (desk, glowing screen, controller, chair) along the back wall, sofa (two seats) and a lounge chair around a coffee table, floor lamp, skyline window |

Design decisions:

- **Operations in front.** The desks fill the open front of the floor, nearest
  the default camera, so nothing stands between the camera and the team.
- **Back rooms behind glass.** Partitions are 2-unit-high glass walls with lit
  door frames (one door per room, onto the corridor). They mark the rooms
  clearly but never hide anyone, from any angle, so no camera-aware hiding is
  needed for interior walls.
- **One story.** Outer walls are 3 units high (was 7.3 for two stories), so
  they rarely cover the floor and hide entirely when the camera is behind them.

The layout lives in `src/config/office.ts` (`OFFICE_BOUNDS`, `ROOMS`,
`BACK_ROOMS_Z`, `roomAt`) and `src/lib/office-navigation.ts` (doorways,
partitions, furniture footprints, seats). Furniture components read the seat
positions from the navigation data, so seats and furniture can't drift apart.

## 2. Component structure

```
src/app/office/page.tsx                  Server Component: heading + <OfficeExperience>
src/components/office/
  office-experience.tsx                  Client root: reducer state, live position store, full-width
                                         layout, fullscreen, 3D/2D display, WebGL detection, lazy
                                         scene, overlays, movement dispatches, ambient wander timer
  room-switcher.tsx                      Entire office / Operations / Pantry / Lounge / Meeting
                                         (icons only on small screens)
  camera-controls.tsx                    Rotate / zoom / reset buttons
  employee-list.tsx                      Keyboard list: one radio group for the team
  employee-details.tsx                   Detail panel: location + movement controls, status,
                                         simulated actions, state picker
  activity-feed.tsx                      Simulated notifications
  office-map.tsx                         2D plan of the four rooms (fallback + optional view)
  scene-error-boundary.tsx, simulated-tag.tsx
  scene/                                 Everything that imports three.js (one lazy chunk)
    office-scene.tsx                     <Canvas>, lights, environment, building, stations, nameplates
    camera-rig.tsx                       Orthographic camera, OrbitControls, modes, tweens, 360°
                                         rotation, follows a selected walker
    camera-framing.ts                    Pure framing math (fit zoom, focus target, shortest angle,
                                         wall facing) – tested
    movement/movement-system.tsx         Advances walks along their routes, writes live positions
    movement/walker.tsx                  Places a character from its live position
    building/camera-hider.tsx            Hides the back/left walls when the camera is behind them
    building/building.tsx                The single floor: rooms, partitions, walls (batched)
    building/architecture.tsx            Glass railing/partition, window, plant, chair, sofa
    building/furniture.tsx               Reception, conference table, gaming stations, door signs,
                                         boards, pantry, lounge, wall panels…
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
src/config/office.ts                     Typed registry: rooms, desks, looks, tasks
src/lib/office-simulation.ts             Pure reducer: selection, view mode, statuses, movement,
                                         activity, ambient wandering
src/lib/office-navigation.ts             Waypoint graph, obstacles, Dijkstra routes, sampling – tested
src/lib/office-movement.ts               Movement states, activities, labels, options – tested
src/lib/office-live.ts                   Live per-frame position store (mutable Map in a ref)
src/hooks/use-fullscreen.ts              Fullscreen API wrapper (state follows the browser)
```

Data flows one way. `OfficeExperience` owns all state (`selectedId`, `view`,
`statuses`, `movement`, `activity`). The 3D scene and DOM panels only render
it. The scene reports clicks and one discrete movement event (a walker
arrived) and writes per-frame positions into
the live store, never into React state.

## 3. Employee registry

`src/config/office.ts` (`officeEmployees`) holds, per employee:

| Field                                  | Purpose                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| `id`, `name`, `role`, `colorToken`     | From the shared roster (`src/config/employees.ts`); identity tokens are `--identity-*` |
| `agentTitle`, `summary`, `personality` | Detail-panel copy                                                                      |
| `glow`                                 | Bright identity color for 3D (equals the dark `--identity-*` token; tested)            |
| `workstation`                          | `research · writing · video · review · schedule · publish · analytics`                 |
| `look`                                 | Composable character design (below)                                                    |
| `desk`                                 | `[x, z]` in the Operations Room                                                        |
| `initialStatus`, `tasks`               | Simulated starting state and task copy per state                                       |

| Employee             | Desk  | Color  | Head                   | Headgear                                  | Chest               | Build    | Resting face         |
| -------------------- | ----- | ------ | ---------------------- | ----------------------------------------- | ------------------- | -------- | -------------------- |
| Scout (Research)     | 1 · 1 | Teal   | soft                   | explorer cap + headlamp, handheld scanner | satchel             | standard | round, curious       |
| Quill (Scriptwriter) | 1 · 2 | Purple | tall                   | quill feather                             | floating notebook   | slim     | half-lid, focused    |
| Pixel (Video)        | 1 · 3 | Orange | screen (wide TV)       | studio headset + top camera               | film belt           | standard | big pill eyes, grin  |
| Vera (Quality)       | 1 · 4 | Blue   | soft                   | inspector visor + antenna                 | shield badge        | standard | narrow, observant    |
| Tempo (Scheduler)    | 2 · 1 | Violet | orb (curved visor)     | alarm bells + orbiting hour ring          | chest clock         | standard | half-lid, calm smile |
| Relay (Publisher)    | 2 · 2 | Coral  | capsule (curved visor) | messenger wings + broadcast antenna       | messenger bag       | slim     | round, grin          |
| Ledger (Analytics)   | 2 · 3 | Gold   | wide                   | analyst glasses                           | chest chart display | sturdy   | pill, flat           |

"Desk" is row · position (row 1 at z = 0.6 west → east, row 2 at z = 4.0).
Every desk faces the camera side (+z) and its owner stands behind it.

To add an employee: add a roster entry, an `--identity-*` token pair, and a
registry entry with a free desk in the Operations Room. If needed, add a new `head`, `headgear`,
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

- `select(id, room?)` selects someone. If a room view is active and they are
  elsewhere, the view returns to the entire office; `select(null)` keeps the view.
- `setView(view)` switches between the entire office and a room, and drops a
  selection that isn't in the room being framed.
- `setStatus(id, status)` updates the status and prepends an activity entry (max 4).
- `simulatedActions[status]` are the contextual buttons. The panel also offers
  "Set state directly". Every state is reachable from idle (tested).

"Simulated" tags mark the viewport, status block and activity feed, and the
announcement says "(simulated status)".

## 6. Animation architecture

| What                                                                                                                                 | Engine                          | Where                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------- |
| Poses, working loops, celebrations, shakes, waves, blinks, glances, bubble pop, selection chevron, walking, camera tweens, job props | R3F `useFrame`, writing to refs | `character.tsx`, `props.tsx`, `movement-system.tsx`, `camera-rig.tsx` |
| Detail-panel entrance, status message, list selection indicator, activity entrance                                                   | Anime.js scopes                 | `employee-details.tsx`, `employee-list.tsx`, `activity-feed.tsx`      |

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
camera easing, and moves are instant. Anime.js scopes skip their
animations through `scope.matches.reduceMotion`. The state still reads through
pose, face, marker and color.

## 7. Camera and room views

`camera-rig.tsx` + `camera-framing.ts`:

- **Projection:** orthographic, at the true isometric angle (polar
  `acos(1/√3)`, azimuth 45°).
- **Views:**
  - **Entire office** (default) frames the whole floor and its walls.
  - **Operations**, **Pantry**, **Gaming Lounge** and **Meeting Room** frame
    one room (its bounds up to head height).
- **Fit:** `fitZoom(box, viewport)` projects the view's bounding box onto the
  camera axes, so framing is exact on any screen. A resize (including
  fullscreen) keeps the user's relative zoom.
- **Selection:** selecting an employee glides the target 70% of the way to
  their live position and zooms 1.45× (`FOCUS_ZOOM`). While they walk, the
  camera follows them from room to room. They also get a white floor ring, a
  chevron and a highlighted nameplate.
- **Limits:**
  - polar 0.55–1.15 rad (always above the floor)
  - azimuth: unrestricted, a full 360° (outer walls facing the camera hide, §12)
  - zoom 0.8×–3.2× of the view's fit
  - no panning
  - orbit radius 40 with an orthographic camera, so there's no near-plane clipping through geometry
- **Controls:** drag/pinch, plus buttons for rotate (18° per press, 20 presses
  for a full turn; tweens take the shortest way across the 0°/360° seam), zoom
  and reset. Reset is pixel-exact: tweens snap onto the goal, and leftover
  OrbitControls momentum is flushed. Mobile hides the rotate buttons; the room
  buttons show icons only below the `lg` breakpoint (full names stay as
  accessible names and tooltips).

## 8. Accessibility and fallbacks

- **The canvas is never required.** The employee list (one radio group for
  the team, arrow keys between colleagues) and the detail panel expose
  everything. The canvas is `aria-hidden`; the viewport region has a text
  description.
- **Status is never color-only:** icon + label badges in the DOM, and
  distinct poses, faces and bubble glyphs in 3D.
- **One polite live region** announces selection and status changes.
- **No WebGL**, or a runtime WebGL failure, shows the **2D plan of the
  floor**: the Meeting Room, Pantry and Gaming & Rest Lounge (with who is in
  each) above the Operations Room and its seven desk buttons, fully operable. "2D map" can also be
  chosen at any time.
- Movement controls are ordinary buttons in the detail panel; unavailable
  ones are disabled with a reason ("Busy with a task…", "All spots are
  taken"). The live region also announces the employee's location.
- Visible focus rings, reduced motion (see §6, §12), and a layout where the
  cards always sit below the full-width viewport (stacked on mobile).

## 9. Performance decisions

See §10 for the measurements.

- **Lazy, client-only 3D:** `next/dynamic(..., { ssr: false })`. Other pages
  load no three.js (covered by E2E tests).
- **DPR capped** at 1.75.
- **On-demand rendering**, with an idle GPU when nothing moves.
- **Batching:** `<Batch>` merges static meshes by material after mount:
  the floor and rooms, desks, character torsos, heads, legs, status bubbles and
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

These are the **DV-002 two-floor** measurements (the baseline); the DV-002B
single-floor numbers are in §13.

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
6. **Movement:** `goTo` / `stop` are plain reducer actions, so a runner can
   send employees to the pantry or back to their desk the same way the UI
   does. A real "working" event already brings an employee back to their desk.

## 12. Living office: walking, breaks, 360° camera, fullscreen

### Navigation

`src/lib/office-navigation.ts` is a hand-placed **waypoint graph** on one
floor:

- **Operations Room:** a desk node and an aisle node per employee. Row 1
  desks open onto the corridor (z = -1.3) along the back rooms; row 2 desks
  open onto an aisle (z = 2.3). Passages between the row 1 desks and at both
  ends join the two.
- **Meeting Room:** a path around the conference table, entered through its
  door, with an approach point and a seat node for each of the eight chairs.
- **Pantry:** a hub inside the door and three standing spots (two at the
  counter, one at the high table).
- **Gaming & Rest Lounge:** a hub inside the door, an aisle in front of the
  three gaming chairs, and approach points for the three lounge seats.

Destination kinds are `desk`, `pantry`, `lounge`, `gaming` and `meeting`
(`spotsFor`, `DESTINATION_ROOM`). Seat nodes carry the seat's facing.
`shortestPath` is Dijkstra over the edges (Euclidean weights). Routes are
polylines with their cumulative lengths, so `positionAt(route, distance)`
samples position and heading in O(log n).

Collision avoidance is static and unit-tested:

- Every edge clears every obstacle by the walker radius (0.25). Obstacles are
  the **glass partitions** (so no route passes through a wall), desks,
  reception, the conference table and chairs, pantry counter, fridge, table
  and stools, gaming desks and chairs, sofa, lounge chair, coffee and side
  tables, lamp and plants. The only exception is the last step onto a seat,
  which may enter that one seat (`Obstacle.seats`).
- No node stands inside furniture, and every node lies inside the walkable
  bounds.
- Every route into a back room crosses the partition line exactly once,
  inside that room's doorway.
- Every desk and spot is reachable from every other.

Walkers don't avoid each other; spots are **reserved** instead (one employee
per spot or seat, "All spots are taken" when full), so two people never stand
in the same place.

Interrupted walks resume from where the walker actually is: the DOM reads the
live store at click time and passes `{ point, node, edge }` with the action,
and `planRoute` continues via whichever end of the current corridor is
shorter. Unreachable targets return `null` and the action is refused.

### Movement state (independent of task status)

`Movement` per employee is `at <node>`, `walking <route>` or
`stopped <point>`; the body activity (`at-desk`, `walking`, `coffee-break`,
`resting`, `gaming`, `meeting`, `standing`) is derived from it. Task status and movement are
separate:

- Walking never changes the status, and status changes never move anyone,
  with one rule: **starting work while away sends the employee back to their
  desk** (the status changes at once; the workstation animates once they're
  seated).
- **Working employees can't leave their desk** for the pantry, lounge, gaming
  stations or meeting room (they can always return to the desk).
- Each walk has a `routeId`; arrivals from an older route are ignored, so
  re-routing mid-walk is race-free.
- Movement and status changes are logged as separate activity entries (the
  feed shows a footprints badge for movement).
- **Ambient breaks** (off by default, unchanged from DV-002): every 7 s one
  idle colleague in round-robin order goes to a free pantry or lounge spot
  (alternating) and returns after three ticks. Working employees are never
  picked.

### Rendering walkers

- `MovementSystem` (inside the canvas) advances each walk at 1.25 units/s,
  eases the heading toward the direction of travel, adds
  distance to a stride counter, and writes everything to the live store. It
  calls `invalidate()` only while someone is walking or turning; once everyone
  has arrived, rendering stops again.
- `Walker` positions each character from the live store. Characters live at
  world level, not inside their desk's group, so they can walk anywhere.
- The **walk cycle** is a function of distance, not time (`gait(stride)`),
  so steps match the ground speed and feet don't slide. Legs pivot at the
  hips; arms swing in opposition; the body bobs slightly.
- **Coffee break:** the robot holds a cup, takes a sip on its glance events,
  and faces the counter. **Lounge sofa, gaming chair, meeting chair:** it sits
  (hips raised onto the seat, legs forward, hands on the lap), facing the
  room, the screen or the table. Phase A uses one seated pose for all three;
  gaming and meeting animations come in later phases. Status still shows
  through the face and bubble.
- Nameplates, the selection ring and the camera all read the live store, so
  they follow the walker; the details panel, list and 2D map show the
  location ("Walking to the meeting room", "Gaming & Rest Lounge · sofa").

### 360° camera and wall hiding

Azimuth limits are gone. `CameraHider` wraps the back and left outer walls (and
everything mounted on them: windows, light strips, boards, shelves) and hides
a wall when the direction from the orbit target to the camera points out
through it (`wallFacesCamera > 0.12`, shown again below 0.02, so slow orbits
don't flicker). The check runs only on frames that render anyway.

### Layout and fullscreen

- The viewport spans the page width (up to 120 rem) at
  `clamp(22rem, 78dvh, 56rem)`. Team, details and activity cards sit below it
  in a responsive grid (one column on mobile, two on tablets, three on wide
  screens).
- **Fullscreen** (`useFullscreen`): the button requests fullscreen on the
  viewport section only. Its state follows `fullscreenchange`, so Escape or
  the browser UI restore the layout as well. A rejected request shows a
  dismissible notice. The camera keeps its relative zoom across the resize, and
  the scene is not remounted, so selection, walks and camera state survive.
  In fullscreen, a chip shows the selected employee's location.

### Measured (DV-002 baseline, two floors, 2026-11-20)

Production build, Chrome, same Radeon R9 M390 machine as §10, viewport
1440×900, Floor 1 view with Quill walking to the pantry while Scout and Relay
work: **59.6 fps**, 281 draw calls and ≈99k triangles per frame. When nobody
walks, rendering stops as before (the reduced-motion idle test still sees
0 draw calls).

### Reduced motion

Every move is instant (the reducer jumps to the destination), headings snap,
and there is no walk cycle, camera follow easing or tweened rotation. The 2D
map also uses instant moves, and switching to it finishes any walk in
progress.

## 13. DV-002B Phase A: from two floors to one

What changed to remove the two-floor assumptions:

| Area         | DV-002 (two floors)                                         | DV-002B Phase A (one floor)                                        |
| ------------ | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Registry     | `floor: 1 \| 2` per employee, `FLOORS`, `viewForFloor`      | No floors; `ROOMS`, `OFFICE_BOUNDS`, `roomAt(x, z)`                |
| Building     | Floor 1 + mezzanine Floor 2, staircase, columns             | One slab, four rooms, glass partitions with doors                  |
| Navigation   | Two floor graphs joined by stair nodes, slope speed         | One graph; no stairs, slopes or level changes; one walking speed   |
| Movement     | Pantry and lounge only                                      | Plus gaming stations and meeting seats                             |
| Live store   | `floor`, `onStairs` per walker                              | Position only (the room comes from `roomAt`)                       |
| Reducer      | `followFloor`, select activated the employee's floor        | `followFloor` removed; select/setView are room-aware               |
| Scene        | `FloorGroup` lifted Floor 2 away; walkers followed the lift | Removed (`floor-group.tsx` deleted)                                |
| Camera views | Building / Floor 1 / Floor 2                                | Entire office / Operations / Pantry / Gaming Lounge / Meeting Room |
| Lighting     | Shadow camera ±11                                           | ±14 with a 2048² map for the larger footprint                      |
| UI           | Floor switcher, list grouped by floor, 2D plan per floor    | Room switcher, one team list, 2D plan of the four rooms            |

**Console:** React Three Fiber 9 (latest stable) still creates a
`THREE.Clock`, which three r183+ deprecated, so every page load logged a
warning no Deskverse code could fix. `scene/three-console.ts` installs a
handler through three's own `setConsoleFunction` that drops only that exact
warning; every other three.js warning, error and log is forwarded unchanged
(unit-tested in `tests/three-console.test.ts`). Remove it once R3F stops using
Clock.

Preserved unchanged: the character rig and all seven identities, walking
cycle and turning, working poses and job props, coffee-break and seated poses,
selection feedback and live nameplates, task states and activity reporting,
interruption / Stop / Return to workstation / reservations / reduced motion,
360° rotation, zoom, reset, following, fullscreen, the full-width viewport
and on-demand rendering.

### Performance (measured 2026-11-20)

Production builds of `main` (DV-002) and this branch, measured back to back
under the same conditions: Chrome, the same Radeon R9 M390 machine, viewport
1440×900, Quill walking to the pantry while Scout and Relay work.

| Build and view                        | Frame rate | Draw calls / frame | Triangles / frame |
| ------------------------------------- | ---------: | -----------------: | ----------------: |
| DV-002, Floor 1 view (Floor 2 hidden) |   35.8 fps |                281 |            98,710 |
| DV-002, whole building                |   36.0 fps |                482 |           160,049 |
| **DV-002B Phase A, entire office**    |   35.7 fps |            **458** |       **152,793** |

- Phase A draws about 5% fewer calls and triangles than DV-002's
  whole-building view, at the same frame rate.
- Idle with reduced motion: still **0 draw calls** in 5 s (on-demand
  rendering preserved). JS heap after load: 54 MB.
- The absolute frame rate was lower than the 59.6 fps recorded for DV-002 in
  §12, for both builds, so the machine was busier during this session (another
  dev server and browser tab were running). The side-by-side comparison is the
  reliable result; the absolute fps is not.

**Deferred to later DV-002B phases:** autonomous leisure routines (beyond the
existing optional ambient breaks), interactive gaming and gaming animations,
simulated meetings and meeting conversations, and dedicated poses for gaming
and meetings.
