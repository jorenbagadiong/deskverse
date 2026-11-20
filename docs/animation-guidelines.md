# Deskverse animation guidelines

Deskverse uses **Anime.js v4** for selected interface motion. Motion should be
**subtle and purposeful**: it explains a change of state or adds a moment of
personality. It never blocks information.

Live demos: `/brand#motion`, `/brand#status`, `/brand#cards`, `/brand#logo`.

## 1. Principles

1. **Explain, don't decorate.** Animate entrances, state changes and feedback.
   Don't animate static content for its own sake.
2. **Fast.** Feedback is 90–500ms, entrances up to about 600ms plus a short
   stagger. Nothing should feel like waiting.
3. **Transform + opacity only.** Never animate `width`, `height`, `top`,
   `margin` or other layout properties. Progress bars use `scaleX`, not width.
4. **No layout shift.** Reserve space up front (e.g. the notification list has a
   fixed minimum height) so animated content never pushes the page.
5. **Bounded loops.** No infinite decorative loops. A loop must be tied to a
   live state and capped (the "working" halo pulses 5 times, then stops).
6. **Accessibility first.** Text, ARIA values and live regions update
   immediately. Animation is only the visual layer on top.
7. **Respect reduced motion** (see §4).

## 2. Where Anime.js is used

| Pattern                 | File                                                    | Technique                                                              |
| ----------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| Brand logo entrance     | `src/components/brand/animated-logo.tsx`                | `createTimeline`: frame spring → portal rise → desk → visor → wordmark |
| Card reveals            | `src/components/motion/reveal.tsx`                      | `animate` + `stagger` on `[data-reveal]` children                      |
| Dashboard KPI reveal    | `src/components/brand/demos/dashboard-cards-demo.tsx`   | Staggered fade/rise/scale, replayable via a scope method               |
| Button feedback         | `src/components/brand/demos/button-feedback-demo.tsx`   | Squash-and-settle `scale` keyframes; icon pop                          |
| Employee status change  | `src/components/brand/demos/status-transition-demo.tsx` | Badge/dot pop; per-state accent (halo, shake, hop)                     |
| Notification appearance | `src/components/brand/demos/notification-demo.tsx`      | Slide/fade new item in before paint (`useLayoutEffect`)                |
| Task progress           | `src/components/brand/demos/task-progress-demo.tsx`     | `scaleX` bars + tweened counter                                        |

Shared constants (durations, easings, media queries) live in `src/lib/motion.ts`.
There is deliberately **no animation framework**, just these constants and
one helper (`takeOverReveal`).

## 3. The React pattern (official Anime.js v4 approach)

Animations run only in Client Components, only in effects (never during server
rendering), inside a scope that is reverted on unmount:

```tsx
"use client"

import { useEffect, useRef } from "react"
import { animate, createScope, type Scope } from "animejs"
import { duration, ease, motionQueries } from "@/lib/motion"

export function Example() {
  const root = useRef<HTMLDivElement>(null)
  const scope = useRef<Scope | null>(null)

  useEffect(() => {
    scope.current = createScope({ root, mediaQueries: motionQueries }).add(
      (self) => {
        if (!self) return

        // Methods let event handlers trigger animations inside the scope.
        self.add("pulse", () => {
          if (self.matches.reduceMotion) return
          animate(".target", {
            scale: [0.95, 1],
            duration: duration.base,
            ease: ease.spring,
          })
        })
      },
    )

    return () => scope.current?.revert() // removes animations + restores inline styles
  }, [])

  return (
    <div ref={root}>
      <button
        className="target"
        onClick={() => scope.current?.methods.pulse?.()}
      >
        Go
      </button>
    </div>
  )
}
```

Rules:

- **Scope everything.** Selectors inside a scope only match within `root`, so
  components can't animate each other's elements.
- **Always `scope.revert()` in cleanup.** This is what prevents leaks across
  client navigations and React Strict Mode double-mounts.
- **Animate after React commits.** When an animation targets an element React
  just rendered (a new notification, a swapped icon), trigger it from
  `useLayoutEffect` so the start frame is applied before paint.
- **Don't fight React over DOM content.** React owns text and attributes. The
  progress counter edits the _existing_ text node (`nodeValue`) so React's next
  render still updates the same node. Never replace React-managed children.
- **Avoid CSS transitions on animated properties.** shadcn buttons ship with
  `transition-all`; animated buttons override it with `transition-colors` so CSS
  doesn't smooth Anime.js's per-frame transforms.
- **Keep Server Components server-side.** Wrap server-rendered children in a
  small client wrapper (like `<Reveal>`) instead of turning the page into a
  Client Component.

## 4. Reduced motion

Two layers:

1. **Anime.js:** every scope passes
   `mediaQueries: { reduceMotion: "(prefers-reduced-motion: reduce)" }`. Constructors
   and methods check `self.matches.reduceMotion` and skip animating. The scope
   rebuilds automatically if the preference changes while the page is open.
2. **CSS:** a global `prefers-reduced-motion: reduce` rule shortens CSS
   transitions/animations (hover lifts, Radix animations) to effectively zero.
   Replay buttons are hidden with `motion-reduce:hidden`.

Under reduced motion all content is visible immediately and state changes are
instant; nothing is lost.

## 5. Entrances without a flash (`data-reveal`)

Server-rendered content would otherwise paint visible, disappear when the
animation starts, then fade in. To avoid that:

- Elements marked `data-reveal` are hidden by CSS **only** when
  `(scripting: enabled) and (prefers-reduced-motion: no-preference)`.
  Without JavaScript, or with reduced motion, they render normally.
- On mount, `takeOverReveal()` pins them at opacity 0 with `utils.set` (inside
  the scope, so `revert()` cleans it up) and marks them `data-revealed`, handing
  control to Anime.js.
- A CSS fallback animation forces them visible after 2.5s in case the bundle
  fails to load.

Don't nest `[data-reveal]` regions owned by different components.

## 6. Don'ts

- Don't animate anything that delivers urgent information (errors, form
  validation, live-region text). Show it instantly; decorate around it.
- Don't add infinite loops, parallax or scroll-jacking.
- Don't start animations in render or module scope (breaks SSR).
- Don't animate layout properties or cause reflow every frame.
- Don't import Anime.js into Server Components.
