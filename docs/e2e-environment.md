# E2E environment notes: 3D office tests in GPU-less WSL

_Recorded at the DV-003A checkpoint and re-confirmed at DV-003B, DV-003C, DV-003D1, DV-003D2, DV-003D3, DV-004A, DV-004B, DV-004C, DV-005A and DV-005B (2026-11-22)._

## Summary

In WSL2 without a desktop Chrome, `E2E_CHANNEL=chromium yarn test:e2e` runs
the suite in Playwright's headless Chromium. Every test that renders the 3D
office then fails, **before and after DV-003A, DV-003B, DV-003C, DV-003D1, DV-003D2, DV-003D3, DV-004A, DV-004B, DV-004C, DV-005A and DV-005B**. The cause is the test
environment, not application code. All other tests pass, including every
Pixel Studio test.

| Run                                                | Passed | Failed | Office failures with the WebGL warning |
| -------------------------------------------------- | -----: | -----: | -------------------------------------: |
| Clean `main` (`dfde85a`), office specs only        |      0 |     24 |                                24 / 24 |
| `feat/dv-003-pixel-video-creator`, full suite      |     22 |     24 |                                24 / 24 |
| DV-003B on `main` (base `6c701c1`), full suite     |     27 |     24 |                                24 / 24 |
| DV-003C on `main` (base `f6ff233`), full suite     |     36 |     24 |                                24 / 24 |
| DV-003D1 on `main` (base `68adbb0`), full suite    |     45 |     24 |                                24 / 24 |
| DV-003D2 on `main` (base `f6fbba4`), full suite    |     52 |     24 |                                24 / 24 |
| DV-003D3 on `main` (base `731d432`), full suite    |     57 |     24 |                                24 / 24 |
| DV-004A on `main` (base `3a9e917`), full suite     |     65 |     24 |                                24 / 24 |
| DV-004B on `main` (base `81fca88`), ordinary suite |     69 |     24 |                                24 / 24 |
| DV-004C on `main` (base `8a69223`), ordinary suite |     69 |     24 |                                24 / 24 |
| DV-005A on `main` (base `f0f6690`), ordinary suite |     69 |     24 |                                24 / 24 |
| DV-005B on `main` (base `6c9c821`), ordinary suite |     69 |     24 |                                24 / 24 |
| DV-005C on `main` (base `13487da`), ordinary suite |     69 |     24 |                                24 / 24 |

All runs fail the same 24 office tests. At DV-003A, the 22 passing tests
were the 17 Pixel Studio tests, the 4 page smoke tests and the no-WebGL
fallback test. At DV-003B, the 27 passing tests are 19 Pixel Studio UI
tests (15 desktop, 4 mobile; FFmpeg mocked), the 3 real-server tests in
`e2e/pixel-render.spec.ts` (a real render through the UI plus two API
rejection tests; none skipped, FFmpeg 6.1.1 is installed), the 4 page smoke
tests and the fallback test. At DV-003C, the 36 passing tests add the 7
audio tests in `e2e/pixel-audio.spec.ts` (5 mocked UI tests, a real
voiceover + music render and real audio rejection) and a mobile audio test
at both widths. At DV-003D1, the 45 passing tests add the 7 job-management
tests in `e2e/pixel-jobs.spec.ts` (3 mocked history tests, real cancel,
history after refresh with preview/download/delete, finding and cancelling a
running render after refresh, and API rejection) and a mobile history test
at both widths. At DV-003D2, the 52 passing tests add the 7 visual-effects
tests in `e2e/pixel-effects.spec.ts` (defaults and storyboard label,
keyboard switching to static, disabled effects on a build without the
filters, reduced motion, 360/375 px layout, EXIF preview/server agreement,
and a real gentle zoom + crossfade render with preview, download, frame
check and history after reload). At DV-003D3, the 57 passing tests add the
5 voiceover-timing tests in `e2e/pixel-audio-timing.spec.ts` (trim/offset
controls with live summary and timeline, per-field validation that blocks
rendering, the exact millisecond request plus server-approved timing, the
360 px layout, and a real render of trimmed, offset narration over looping
music with preview, download, a 300 Hz band level check and history after
reload); two DV-003C audio tests were updated for the deliberately changed
rules (timed fit message, 5-minute recording limit). At DV-004A, the 65
passing tests add the 8 database-status tests in
`e2e/system-database.spec.ts` (Ready, Not configured, Database not running
and Connection failed states, an unreachable server and Check again, the
360 px layout, the real endpoint's safe no-store report, and refusal of
cross-site requests). At DV-004B, the ordinary suite's 69 passing tests add
the 4 mocked Affiliate Ticket list-state tests in `e2e/ticket-states.spec.ts`.
The database-writing ticket specs (`e2e/tickets*.spec.ts`, 11 tests) run
separately with `yarn test:e2e:db` on their own scratch database: 11 passed,
none of them render the 3D office. At DV-004C the database suite has 18
tests (adding 7 Workflow tests in `e2e/tickets-workflow.spec.ts`, run with a
real orchestrator worker process): 18 passed. The ordinary suite is
unchanged: 69 passed. No new failures
appeared. At DV-005A the database suite has 24 tests (adding 6 Scout
Research tests in `e2e/tickets-research.spec.ts`; a real worker reads local
fixture sites through Scout's test network, never the internet): 24 passed.
The ordinary suite is unchanged: 69 passed, 24 failed (the same office
tests). Both suites need `E2E_CHANNEL=chromium` in this WSL setup. At
DV-005B the database suite has 30 tests (adding 6 Quill Scripts tests in
`e2e/tickets-quill.spec.ts`, with the real worker writing scripts from
fixture-site research): 30 passed. The ordinary suite: 69 passed, 24
failed (the same office tests). At DV-005C the database suite has 36 tests (adding 6
Pixel Videos tests in `e2e/tickets-pixel.spec.ts`, with the real worker
rendering real videos with FFmpeg): 36 passed. The ordinary suite: 69
passed, 24 failed (the same office tests, each with the software WebGL
warning). The bundled Playwright Chromium has no H.264 decoder
(`canPlayType` returns ""), so in-browser playback of the MP4s is **not
tested**; their delivery (type, `nosniff`, `no-store`, ranges, download)
is.

## Environment

- Windows 11, WSL2 kernel `6.6.87.2-microsoft-standard-WSL2`, Ubuntu 24.04.1
- Playwright 1.56.1 with its bundled headless Chromium 141 (build 1194), no
  desktop Chrome installed in WSL
- WSL GPU paravirtualization is present (`/dev/dxg`, `/usr/lib/wsl/lib/libd3d12.so`),
  but headless Chromium doesn't use it by default

## Root cause

Without a usable GPU, Chromium falls back to SwiftShader (software WebGL) and
logs this console warning when the 3D scene creates its WebGL context:

```
[GroupMarkerNotSet(crbug.com/242999)!:…]Automatic fallback to software WebGL
has been deprecated. Please use the --enable-unsafe-swiftshader
(about:flags#enable-unsafe-swiftshader) flag to opt in to lower security
guarantees for trusted content.
```

`e2e/fixtures.ts` fails any test that logs an unexpected warning or error, by
design. So every test that opens `/office` with WebGL fails on this line. In
two tests, software rendering is also too slow for the test's timeouts: a walk
to the pantry that hasn't arrived after 30 s, and a camera or click wait that
times out. Which slow-render failure appears varies between runs.

The warning's text doesn't depend on the application: it is Chromium reporting
that it had no hardware GPU.

## Failing tests (identical on `main` and the feature branch)

`e2e/office.spec.ts` (desktop):

- renders the single-floor office with all seven employees
- selects each of the seven employees
- keyboard: arrow keys move through the whole team
- supports all five simulated states and records activity
- room controls focus each room of the floor
- clicking a robot in the 3D scene selects that employee
- 2D map toggle shows the single-floor plan and stays operable
- light and dark themes both render the office
- reduced motion › renders on demand only and the camera reset is exact
- reduced motion › status changes are instant (no Anime.js transforms)

`e2e/living-office.spec.ts` (desktop):

- walking › walks to the pantry and back without touching the task status
- walking › stop interrupts a walk mid-corridor
- walking › working employees stay at their desk until the task is done
- reduced motion › moves between rooms are instant
- reduced motion › the camera rotates a full 360° and back to the identical view
- layout and fullscreen › full-width simulation with cards below
- layout and fullscreen › enters and leaves fullscreen, keeping the scene and selection
- layout and fullscreen › a rejected fullscreen request shows a notice instead of failing

`e2e/mobile.spec.ts` (3 tests × `mobile-375` and `mobile-360`):

- fits the screen with simplified controls and no overlap
- every employee can be selected by tapping the list
- room switcher works on touch

## What was deliberately not done

- No office test was skipped, and no assertion was changed.
- The console-warning rule in `e2e/fixtures.ts` was not relaxed, and this
  warning was not added to its ignore list. A blanket ignore would also hide
  real WebGL problems.
- `--enable-unsafe-swiftshader` was not added to `playwright.config.ts`.
  Chromium labels that flag as lowering security guarantees, and it must only
  ever be used for trusted test content, never in a production browser.

## Running the office tests successfully

Run the suite where Chrome has hardware WebGL:

- **Native Windows:** a Windows checkout with Chrome installed runs
  `yarn test:e2e` on the default `chrome` channel and the Windows GPU.
- **A Linux or macOS machine with a GPU and Chrome,** or a CI runner with GPU
  support.

Not yet tried, options for a future milestone:

- Getting headless Chromium in WSL to use the D3D12-backed GPU (`/dev/dxg`)
  through Mesa's d3d12 driver.
- An opt-in, test-only Playwright project that passes
  `--enable-unsafe-swiftshader`, kept separate from the default projects. This
  would remove the warning but not the slow-render timeouts.

## DV-006A verification (2026-11-22)

The database browser suite passed **43 tests**, with **0 failed, 0 skipped**.
The seven new Vera flows use a real worker, genuine persisted Scout/Quill/Pixel
inputs and actual FFmpeg QA. They cover exact selection, keyboard start,
scene/disclosure evidence, source links, historical versions, API ownership and
strict inputs, worker offline/recovery, and 360/375 px light/dark layouts. After
making the latest-QA pointer independent of paginated history, all seven Vera
flows passed again against the final build.

The ordinary suite passed **69**, failed **24**, and skipped **0**. All failures
are the same ten desktop office, eight living-office and six mobile office tests
listed above. Every failed test includes the existing software-WebGL warning.
No new failure was classified as a GPU failure, and no office test/assertion,
console-warning allowlist or browser flag was changed. Actual browser H.264
playback remains **NOT TESTED** because no compatible installed browser was
available; HTTP delivery and FFmpeg decoding are separate verified checks.
