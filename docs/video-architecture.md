# Pixel video engine architecture

DV-003 adds **Pixel Studio** (`/studio/pixel`): a local-first tool that turns
your product images and captions into a 9:16 affiliate product video for
TikTok, Instagram Reels and YouTube Shorts. It's named after Pixel, the
team's video creator.

> **What this is not.** Pixel Studio does not generate AI footage, voices or
> images. FFmpeg _assembles media you supply_: it crops and scales your
> photos, adds gentle motion, draws your captions and joins the scenes into
> one MP4. Every pixel in the output comes from your images and your text.

| Phase       | Scope                                                                              | Status        |
| ----------- | ---------------------------------------------------------------------------------- | ------------- |
| **DV-003A** | Environment detection, strict types, validation, storyboard UI, storage foundation | ✅ This phase |
| **DV-003B** | Real rendering: job queue, FFmpeg command builder, progress, download              | Planned       |
| **DV-003C** | Audio: music bed and/or voice-over, AAC encoding                                   | Planned       |

## 1. FFmpeg and FFprobe

- **FFmpeg** is a command-line program that decodes, filters and encodes
  audio and video. Pixel Studio will use it to scale and crop each image to
  1080×1920, apply a slow zoom (`zoompan`), draw captions (`drawtext`), fade
  between scenes and encode the result as H.264 in an MP4 container.
- **FFprobe** ships with FFmpeg and _reads_ media. It reports dimensions,
  duration, codecs and streams. DV-003B uses it to re-check uploaded images
  server-side and to verify the finished MP4.

Both run as **native programs on your computer**. Deskverse does not use
FFmpeg.wasm, cloud rendering or paid APIs, and it doesn't bundle FFmpeg. You
install it once with your OS package manager.

## 2. Installing FFmpeg (Windows 11 + WSL2 Ubuntu)

Deskverse runs inside WSL, so FFmpeg must be installed **inside Ubuntu**, not
on Windows. A Windows `ffmpeg.exe` isn't used.

```bash
# In the Ubuntu (WSL) terminal
sudo apt update
sudo apt install -y ffmpeg
```

Verify the install:

```bash
ffmpeg  -hide_banner -version | head -1   # e.g. ffmpeg version 6.1.1-3ubuntu5
ffprobe -hide_banner -version | head -1
ffmpeg  -hide_banner -encoders | grep -E ' (libx264|libopenh264|aac) '
ffmpeg  -hide_banner -filters  | grep -E ' (drawtext|zoompan|xfade) '
```

Then open http://localhost:3000/studio/pixel and select **Check again** in the
_Local FFmpeg_ card. No server restart is needed (results are cached for at
most 30 seconds).

Ubuntu 24.04 ships FFmpeg 6.1 and Ubuntu 22.04 ships 4.4. Both include
libx264, libfreetype (for `drawtext`), `zoompan` and `xfade`. Builds older
than 5.0 work but show an "untested" warning.

**macOS:** `brew install ffmpeg`. **Native Windows (without WSL):** install a
full build (for example from the gyan.dev or BtbN builds) and add its `bin`
folder to `PATH`.

### Non-standard locations

If FFmpeg isn't on `PATH`, point Deskverse at it with absolute paths. These
are server-side environment variables and are never sent to the browser:

```bash
DESKVERSE_FFMPEG_PATH=/opt/ffmpeg/bin/ffmpeg
DESKVERSE_FFPROBE_PATH=/opt/ffmpeg/bin/ffprobe
```

The file name must be `ffmpeg`/`ffprobe` (optionally `.exe`). Anything else,
such as a relative path or another program, is refused and shown as a
configuration error.

## 3. Environment detection

`src/server/video/ffmpeg-capabilities.ts` (server-only) runs four fixed,
read-only commands and parses their output:

| Command                         | Learns                                           |
| ------------------------------- | ------------------------------------------------ |
| `ffmpeg -hide_banner -version`  | FFmpeg version, license flags (GPL/LGPL/nonfree) |
| `ffprobe -hide_banner -version` | FFprobe version                                  |
| `ffmpeg -hide_banner -encoders` | Every H.264 and AAC encoder in the build         |
| `ffmpeg -hide_banner -filters`  | Whether each required filter exists              |

- **libx264 is never assumed.** All H.264 encoders are listed and ranked:
  `libx264`, then `libopenh264`, then other software encoders, then hardware
  encoders (`h264_nvenc`, `h264_qsv`, `h264_vaapi`, `h264_amf`…).
  `libx264rgb` is excluded because it can't produce `yuv420p`. Hardware
  encoders are only _listed_ by FFmpeg. Whether the GPU and drivers work is
  proven by a test render in DV-003B, so a hardware-only build shows a
  warning.
- **Required filters:** `scale`, `crop`, `pad`, `setsar`, `fps`, `format`,
  `overlay`, `drawtext`, `zoompan`, `fade`, `concat`. **Optional:** `xfade`
  (smoother transitions; otherwise scenes cut).
- **AAC** is reported but only warns when missing, because audio arrives in
  DV-003C.

Result status:

| Status        | Meaning                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- |
| `ready`       | FFmpeg + FFprobe found, an H.264 encoder and all required filters exist (warnings may apply) |
| `missing`     | FFmpeg or FFprobe can't be found or started                                                  |
| `unsupported` | Installed, but no H.264 encoder or a required filter is missing                              |

Every problem comes with a plain-language message: not found, permission
denied, didn't respond within 5 s, not really FFmpeg, invalid override,
missing filters (with a note that `drawtext` needs libfreetype), and so on.

### Capability endpoint

`GET /api/studio/pixel/capabilities` (`?refresh=1` skips the 30 s cache)
returns an `FfmpegCapabilityReport` (`src/lib/video/capabilities.ts`). It
contains booleans, sanitized version strings, encoder/filter names, a derived
license label and human-readable issues. It **never** includes executable
paths, environment variables, `./configure` flags (which can contain build
paths) or raw process output.

The route runs on the **Node.js runtime**. With Cache Components enabled,
Next.js 16 doesn't allow (or need) `export const runtime`: Node.js is the only
runtime. Reading request headers keeps the route out of build-time
prerendering, so detection always runs on the serving machine. Other methods
answer `405`.

## 4. Video output target

Fixed in `src/lib/video/format.ts`. Clients can't change it.

| Property     | Value                                                                      |
| ------------ | -------------------------------------------------------------------------- |
| Resolution   | 1080 × 1920 px                                                             |
| Aspect ratio | 9:16 (vertical)                                                            |
| Frame rate   | 30 fps                                                                     |
| Container    | MP4 (`+faststart` in DV-003B, so playback starts before download finishes) |
| Video codec  | H.264, `yuv420p` (plays on every phone and platform)                       |
| Duration     | 15–30 seconds                                                              |
| Audio        | None until DV-003C                                                         |

### Storyboard template

`buildStoryboard()` (`src/lib/video/storyboard.ts`) produces a fixed template:

1. **Hook:** headline over the hero (first) image, with the product name
2. **Benefits:** one scene per benefit (1–5), cycling through the other images
3. **Call to action:** CTA button-style caption over the hero image

The **affiliate disclosure** is overlaid on every scene. Durations are whole
frames: base durations (3 s hook, 4 s per benefit, 4 s CTA) are fitted
proportionally into 15–30 s, with each scene kept within 2–8 s.

### Validation rules

`src/lib/video/validation.ts` is shared by the form and, from DV-003B, by the
server, where it is the real gate. Inputs are treated as `unknown`.

- **Strict objects:** unknown keys are rejected everywhere (product, scenes,
  captions, settings, assets). A request can't carry `ffmpegArgs`,
  `outputPath`, `filter`, `fontfile` or any other field.
- **Settings** must equal the fixed defaults exactly.
- **Text:** NFC-normalized and whitespace collapsed to one line. Lengths are
  counted in characters (product name 60, headline 70, benefit 80, CTA 40,
  disclosure 140). Control characters, bidi overrides, zero-width and other
  invisible format characters, private-use characters and lone surrogates
  are refused. Emoji joiners stay allowed.
- **Images:** JPEG, PNG or WebP only (no SVG or GIF), extension must match
  type, 1 byte to 10 MB, 1–6 images, each side 320–8192 px, at most 40 MP.
- **Scenes:** 3–8 scenes, hook first and CTA last, 2–8 s each in whole
  frames, 15–30 s total, and image references must point at project images.

## 5. Local file storage

`src/server/video/storage.ts` (server-only). Data lives **outside the
repository** in the per-user application data folder:

| Platform    | Location                                                    |
| ----------- | ----------------------------------------------------------- |
| Linux / WSL | `$XDG_DATA_HOME/deskverse`, else `~/.local/share/deskverse` |
| macOS       | `~/Library/Application Support/Deskverse`                   |
| Windows     | `%LOCALAPPDATA%\Deskverse`                                  |

`DESKVERSE_DATA_DIR` overrides it. It must be absolute, and any location
inside the project (including `public/`) is refused, so private files can
never be served by Next.js or committed. In WSL this is the Linux filesystem,
which is fast and not synced by Windows tools.

```
<data>/video/jobs/<jobId>/
  job.json                 RenderJob metadata (state, assets, error, output)
  assets/<assetId>.<ext>   uploaded images, renamed to generated IDs
  work/                    temporary render files; wiped by cleanupWork()
  output/video.mp4         the finished render
```

The storage API covers job creation, image validation and storage, job
metadata and state transitions, asset paths for the renderer, work-directory
cleanup, job deletion, stale-job cleanup and safe output retrieval:

- **Generated IDs only:** `job_` / `asset_` + 128 random bits in hex. User
  file names are sanitized and kept for display only.
- **Path containment:** every path is built with `resolveInside()`, which
  allows only simple segments and proves the result stays under the root.
  Symlinks are refused and real paths re-checked, so `..`, absolute paths and
  link tricks can't escape.
- **Upload checks:** size limit before anything else, then the type is
  identified **by the file's bytes** (magic numbers), and it must match the
  declared type. Dimensions are read from headers without decoding pixels.
- **Owner-only permissions:** directories `0700`, files `0600`; files are
  written with `wx` (never overwrite) and metadata is written atomically
  (temp file + rename). Updates to one job are serialized.
- **Lifecycle:** `draft → queued → rendering → completed`, with `failed →
queued` retries and `cancelled`. Images can only be added to a draft.
  Stale-job cleanup never touches queued/rendering jobs or folders it didn't
  create.
- **Outputs:** returned only for `completed` jobs, and only if the file is a
  regular file inside storage. The absolute path is for server-side streaming
  and is never sent to the browser.

## 6. Render security boundaries

| Boundary                    | Rule                                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser → server            | The browser sends _data_ (text, images), never commands, flags, filters, paths or codec options. Strict validation rejects unknown fields.                                                                                      |
| Server → FFmpeg             | Only `execFile` (no shell) with argument arrays built by server code from the fixed format. Hard timeout, output cap, minimal environment (`PATH` + OS essentials), stdin closed. Raw errors are mapped to codes, never echoed. |
| Captions → FFmpeg (DV-003B) | Caption text is written to per-job text files and passed with `drawtext=textfile=…`. It is never interpolated into a filter string, so FFmpeg's filter escaping can't be abused.                                                |
| Files                       | Generated names, containment checks, symlink refusal, byte-level type sniffing, size limits, data dir outside the repo and `public/`.                                                                                           |
| Network                     | The capability endpoint checks `Host` (blocks DNS rebinding), `X-Forwarded-Host`/`-For`, `Origin` and `Sec-Fetch-Site` (blocks cross-site calls).                                                                               |

**Header checks are not a network firewall.** A program on another machine
that can reach the port can forge headers. `next dev` / `next start` listen on
all interfaces by default, so for strict local-only use bind to loopback:

```bash
yarn dev   -H 127.0.0.1
yarn start -H 127.0.0.1
```

WSL's localhost forwarding still lets your Windows browser reach
`http://localhost:3000`.

## 7. Licensing considerations

_This is general information, not legal advice._

- **FFmpeg** is LGPL 2.1+ by default. Builds configured with `--enable-gpl`
  (needed for libx264, as in Ubuntu's package) are GPL. Builds with
  `--enable-nonfree` (e.g. `libfdk_aac`) may be used but **not
  redistributed**. Pixel Studio shows the detected license and warns about
  non-free builds.
- **Deskverse doesn't bundle, link or distribute FFmpeg.** It starts the copy
  you installed as a separate program, so FFmpeg's license terms don't extend
  to Deskverse's code. If a future release bundles FFmpeg binaries, it must
  ship the license text and corresponding source as the (L)GPL requires.
- **H.264 is covered by patents** administered by a patent pool (Via LA, which
  absorbed MPEG LA's AVC program). Pool terms have historically waived
  royalties for internet video distributed free to viewers, but review the
  current terms for your use, especially for paid or commercial distribution
  of the encoder itself. Cisco's prebuilt OpenH264 binaries come with Cisco
  covering the pool royalties.
- **Your media:** you need the rights to every image you use. Affiliate
  programs often restrict how product images may be used (some only allow
  images fetched through their own tools), so check your program's terms.
- **Disclosure:** advertising rules (e.g. the US FTC Endorsement Guides) and
  platform policies require a clear disclosure when you can earn a
  commission. Pixel Studio requires disclosure text and shows it on every
  scene. Also use each platform's branded-content or paid-partnership
  setting.

## 8. Phase A limitations

- **No rendering.** The Render button is disabled with an explanation, and no
  video file is produced.
- Images are previewed in the browser with `blob:` URLs and are **not
  uploaded**. The storage layer is implemented and tested but not yet wired
  to an upload endpoint.
- The storyboard is a static preview (no motion, transitions or timing
  playback). Captions use the browser's font, while the render will use a
  bundled font.
- One fixed template and format. No audio.
- Capability detection lists hardware encoders but can't confirm they work
  without a test render.

## 9. Planned DV-003B: rendering

1. **Upload endpoint** (localhost-only, size-limited streaming) that calls
   `storage.addImageAsset()`, plus FFprobe re-validation of each image.
2. **Server-side project validation** with `validateVideoProject()`. The
   server rebuilds the storyboard itself rather than trusting client scenes.
3. **FFmpeg command builder:** a pure, unit-tested function from a
   `VideoProject` plus the selected encoder to an argument array, with
   per-scene `scale/crop/zoompan/fade`, `drawtext=textfile=` captions with
   a bundled open-licensed font (OFL), `concat`, `-pix_fmt yuv420p -r 30
-movflags +faststart`, and encoder-specific quality flags (`-crf` for
   libx264, bitrate for others).
4. **Job queue:** one render at a time, `queued → rendering → completed/failed`,
   progress from `-progress pipe:1`, cancellation by killing the child,
   timeouts, and `cleanupWork()` afterwards.
5. **Output:** FFprobe verification (1080×1920, H.264, 30 fps, duration),
   then a localhost-only download route that streams
   `resolveCompletedOutput()`, plus stale-job cleanup on startup.
6. **Hardware encoder test:** a one-second probe render before trusting a
   hardware-only encoder.

## 10. Code map

```
src/lib/video/               shared, client-safe
  format.ts                  fixed output format, frame helpers
  types.ts                   ProductInfo, MediaAsset, VideoScene, Caption, VideoSettings, VideoProject
  ids.ts                     RenderJobId / AssetId: generation + strict patterns
  render-job.ts              job states, transitions, RenderJob metadata
  validation.ts              all input validation
  storyboard.ts              storyboard template + duration fitting
  capabilities.ts            public capability report types, required filters
src/server/                  server-only (import "server-only")
  process/run-executable.ts  the only way to start a program (execFile, no shell)
  video/ffmpeg-capabilities.ts  detection, parsing, encoder ranking, cache
  video/storage.ts           private job storage, path safety, data dir
  video/image-sniff.ts       byte-level image type and dimension checks
  http/local-request.ts      localhost-only header checks
src/app/api/studio/pixel/capabilities/route.ts   GET capability report
src/app/studio/pixel/page.tsx                    Pixel Studio page
src/components/studio/pixel/                     studio UI
tests/video-config.test.ts, tests/ffmpeg-capabilities.test.ts, tests/video-storage.test.ts
e2e/pixel-studio.spec.ts, e2e/pixel-studio-mobile.spec.ts
```

Unit and UI tests mock FFmpeg (an injected runner, and a mocked endpoint in
Playwright), so they don't need FFmpeg installed.
