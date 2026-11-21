# E2E environment notes: 3D office tests in GPU-less WSL

_Recorded at the DV-003A checkpoint (2026-11-21)._

## Summary

In WSL2 without a desktop Chrome, `E2E_CHANNEL=chromium yarn test:e2e` runs
the suite in Playwright's headless Chromium. Every test that renders the 3D
office then fails, **before and after DV-003A**. The cause is the test
environment, not application code. All other tests pass, including every
Pixel Studio test.

| Run                                           | Passed | Failed | Office failures with the WebGL warning |
| --------------------------------------------- | -----: | -----: | -------------------------------------: |
| Clean `main` (`dfde85a`), office specs only   |      0 |     24 |                                24 / 24 |
| `feat/dv-003-pixel-video-creator`, full suite |     22 |     24 |                                24 / 24 |

Both runs fail the same 24 office tests. On the feature branch, the 22 passing
tests are the 17 Pixel Studio tests, the 4 page smoke tests and the no-WebGL
fallback test.

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
