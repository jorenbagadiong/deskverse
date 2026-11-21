# Pixel video engine architecture

DV-003 adds **Pixel Studio** (`/studio/pixel`): a local-first tool that turns
your product images and captions into a 9:16 affiliate product video for
TikTok, Instagram Reels and YouTube Shorts. It's named after Pixel, the
team's video creator.

> **What this is not.** Pixel Studio does not generate AI footage, voices or
> images. FFmpeg _assembles media you supply_: it scales and frames your
> photos, draws your captions, mixes in your own voiceover and music, and
> joins everything into one MP4. Every pixel and every sound in the output
> comes from your images, your text and your audio files.

| Phase         | Scope                                                                                     | Status  |
| ------------- | ----------------------------------------------------------------------------------------- | ------- |
| **DV-003A**   | Environment detection, strict types, validation, storyboard UI, storage foundation        | ✅ Done |
| **DV-003B**   | Real rendering: uploads, server-built projects, FFmpeg renderer, queue, preview, download | ✅ Done |
| **DV-003C**   | Optional voiceover and background music, mixed and encoded as AAC                         | ✅ Done |
| **DV-003D1**  | Reliable job management: cancel, retry, history, delete, storage, restart recovery        | ✅ Done |
| **DV-003D2+** | Transitions, motion, templates and audio editing                                          | Planned |

## 1. FFmpeg and FFprobe

- **FFmpeg** is a command-line program that decodes, filters and encodes
  audio and video. Pixel Studio uses it to compose each scene (backdrop,
  framed product image, captions) and to encode the scenes as one H.264 MP4.
- **FFprobe** ships with FFmpeg and _reads_ media. Pixel Studio uses it to
  re-check every uploaded image and to verify every finished video before
  anyone can see it.

Both run as **native programs on your computer**. Deskverse doesn't use
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
ffmpeg  -hide_banner -filters  | grep -E ' (drawtext|gblur|colorchannelmixer|loop) '
```

Then open http://localhost:3000/studio/pixel and select **Check again** in the
_Local FFmpeg_ card. No server restart is needed (results are cached for at
most 30 seconds).

Ubuntu 24.04 ships FFmpeg 6.1 and Ubuntu 22.04 ships 4.4; both include
libx264 and libfreetype (for `drawtext`). Builds older than 5.0 work but show
an "untested" warning. **macOS:** `brew install ffmpeg`. **Native Windows
(without WSL):** install a full build (for example the gyan.dev or BtbN
builds) and add its `bin` folder to `PATH`.

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

`src/server/video/ffmpeg-capabilities.ts` (server-only) runs fixed, read-only
commands and parses their output:

| Command                           | Learns                                           |
| --------------------------------- | ------------------------------------------------ |
| `ffmpeg -hide_banner -version`    | FFmpeg version, license flags (GPL/LGPL/nonfree) |
| `ffprobe -hide_banner -version`   | FFprobe version                                  |
| `ffmpeg -hide_banner -encoders`   | Every H.264 and AAC encoder in the build         |
| `ffmpeg -hide_banner -filters`    | Whether each required filter exists              |
| Test encode (6 frames, discarded) | Which H.264 encoder actually works               |

- **Encoders are tested, not trusted.** Being listed in `-encoders` only
  means "compiled in"; hardware encoders often fail without a GPU or
  drivers. Candidates are ranked (`libx264`, `libopenh264`, other software,
  then hardware such as `h264_nvenc`, `h264_qsv`, `h264_vaapi`) and each is
  test-encoded in that order at 1080×1920 `yuv420p`, with the exact options
  renders use, into FFmpeg's null muxer, until one succeeds. Only an encoder
  that passed can be selected. If none pass, the status is `unsupported`.
  `libx264rgb` is excluded (it can't produce `yuv420p`).
- **Required filters** (exactly what the renderer uses): `color`, `split`,
  `scale`, `crop`, `gblur`, `colorchannelmixer`, `overlay`, `drawtext`,
  `format`, `loop`, `settb`, `setpts`, `setsar`, `concat`, `fade`.
  **Optional:** `xfade` (crossfades, planned for DV-003D).
- **Audio (DV-003C)** is checked separately and never blocks silent videos:
  the audio filters (`aresample`, `aformat`, `atrim`, `asetpts`, `apad`,
  `loudnorm`, `aloop`, `afade`, `asplit`, `sidechaincompress`, `amix`,
  `alimiter`) must exist, and an AAC encoder must pass a real half-second
  test encode (native `aac` first, then `libfdk_aac`, `aac_at`, `aac_mf`).
  Otherwise the report says `audio.ready: false` with a plain reason, the
  audio options are disabled in the studio, and silent rendering stays
  available.

| Status        | Meaning                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| `ready`       | FFmpeg + FFprobe found, all required filters present, an H.264 encoder passed its test encode |
| `missing`     | FFmpeg or FFprobe can't be found or started                                                   |
| `unsupported` | Installed, but a required filter is missing or no H.264 encoder works                         |

`GET /api/studio/pixel/capabilities` (`?refresh=1` skips the 30 s cache)
returns an `FfmpegCapabilityReport`: booleans, sanitized versions,
encoder/filter names with test results, a license label and plain-language
issues. It **never** includes executable paths, environment variables,
`./configure` flags (they can contain build paths) or raw process output.

All routes run on the **Node.js runtime**. With Cache Components enabled,
Next.js 16 doesn't allow (or need) `export const runtime`. Reading request
headers keeps them out of build-time prerendering.

## 4. Rendering workflow

```
Browser                                Server (this computer)
───────                                ──────────────────────
pick 3–6 images (File objects kept)
fill in text, preview storyboard
Render MP4 ─► POST /jobs ────────────► new draft job (generated ID)
           ─► POST /jobs/:id/assets ─► per image: size limit while streaming,
              (raw bytes, one per        byte sniffing, header dimensions,
               request)                  FFprobe codec/size check, test decode,
                                         stored as assets/<assetId>.<ext> (0600)
           ─► POST /jobs/:id/audio   ─► optional voiceover / music (DV-003C): byte
              ?role=… (raw bytes)        sniffing, FFprobe streams/codec, full decode,
                                         duration/channel/rate limits
           ─► POST /jobs/:id/render ─► { product, assetIds, audio? } only; storyboard
              (JSON)                     rebuilt server-side, project.json saved,
                                         job queued → 202 + status
poll GET /jobs/:id every second ◄──── state + real progress
                                       queue worker (one at a time):
                                         1. FFmpeg ready + tested encoder?
                                         2. re-read + re-validate project.json
                                         3. fonts + caption files → work/
                                         4. compose one still PNG per scene
                                         5. encode H.264 (-progress pipe:1)
                                         6. FFprobe verification
                                         7. audio projects only: measure loudness,
                                            mix + mux AAC with the copied H.264,
                                            verify again (one AAC track)
                                         8. work/…mp4 → output/video.mp4
                                         9. job completed (or failed), work/ wiped
<video src=/jobs/:id/video>  ◄──────── verified MP4 only, byte ranges
Download MP4 (?download=1)   ◄──────── Content-Disposition: attachment
```

The browser receives a job ID and polls; no HTTP request is held open while
FFmpeg works.

### Scene composition

Each scene is composed once into a 1080×1920 still (`scene-N.png`):

1. **Backdrop:** the image scaled to cover the frame, blurred (`gblur`) and
   darkened, over the dark brand color (so transparent PNGs still look right).
2. **Product image:** the whole image fitted inside 960 × 800 px, centered
   with its proportions preserved (`force_original_aspect_ratio=decrease`).
   Nothing is cropped from the product.
3. **Text:** the affiliate disclosure (Inter Medium 32 px on a dark band, top
   of every scene), the caption (Inter Bold, 84 → 52 px, on a dark box, or on
   the accent pill for the call to action) and the product name under the
   hook and call to action.

**Mobile safe areas:** platform UI covers roughly the top ~200 px, the bottom
~400 px and a right-hand rail. Text stays between y = 210 and y ≈ 1560, in a
centered 820 px column.

**Text layout:** FFmpeg's `drawtext` doesn't wrap, so the server wraps
captions itself using real glyph widths read from the font file
(`font-metrics.ts`). Lines are balanced (no orphan last word), long words
break by character, and the font size steps down until a caption fits three
lines. Characters the font can't draw (emoji, CJK…) are rejected with a clear
message before rendering, instead of rendering as empty boxes.

### Encoding

The scene stills are fed as single-frame inputs. The `loop` filter repeats
each one for its exact frame count, `settb=1/30,setpts=N` gives exact 1/30 s
timestamps, and `concat` joins them with a 0.25 s fade-in and 0.4 s fade-out.
Scenes change with simple cuts.

- `libx264`: `-preset medium -crf 20 -tune stillimage -rc-lookahead 20
-profile:v high`. Other software encoders get a fixed bitrate (6 Mb/s for
  `libopenh264`) and hardware encoders 8 Mb/s.
- Always `-pix_fmt yuv420p -r 30 -frames:v <exact> -an -movflags +faststart`.
- Encoder threads: available cores − 1, capped at 4.

**Progress is never estimated.** While encoding, the UI shows FFmpeg's own
`out_time` (from `-progress pipe:1`) over the storyboard's exact duration.
Before that it shows the real number of composed scenes. Waiting, preparing
and verifying show no percentage.

### Output verification

Before a job may complete, FFprobe must confirm all of the following. If
anything is off, the file is discarded and the job fails with the list of
problems.

- MP4 container (format `mp4` and an ISO brand such as `isom`, not QuickTime)
- exactly one video stream, H.264, 1080 × 1920, `yuv420p`, 30/1 fps
- silent videos: no audio track. Audio videos: exactly one AAC-LC, 48 kHz,
  stereo track lasting the video's length (±0.1 s), plus a full decode of
  that track (metadata alone doesn't prove it plays)
- no other streams (subtitles, data)
- duration within 15–30 s and within 0.1 s of the storyboard
- frame count equal to the storyboard's
- non-empty file

### Queue and restarts

- One render at a time, at most 3 waiting (more → 429 "try again in a
  minute"), and the same job can't be started twice (409).
- State lives in `job.json`; live progress lives in memory.
- **Restarts:** when the server starts, any job still `queued` or `rendering`
  belongs to the previous process and is marked `failed` ("interrupted") and
  any partial output is deleted, so nothing half-rendered is reported as
  complete.
- Cancellation, retry, deletion and restart recovery: see §6 (DV-003D1).
- Startup cleanup only removes abandoned drafts (uploads never rendered)
  untouched for 24 hours and stray scratch files. Completed, failed and
  cancelled jobs are never removed automatically.
- Timeouts: 60 s per scene and 10 minutes for the encode. The process is
  killed with `SIGKILL` at the deadline. FFmpeg never waits for input (stdin
  is closed and `-nostdin` is set).

## 5. Audio: voiceover and background music (DV-003C)

Four choices, picked in the studio's **Audio** card: **No audio** (the
default and exactly the DV-003B pipeline), **Voiceover**, **Background
music**, or **Voiceover + music**.

### Supported files and limits

| Format | Container check (bytes)         | Accepted codecs (FFprobe)                                    |
| ------ | ------------------------------- | ------------------------------------------------------------ |
| MP3    | ID3 tag or MPEG Layer III frame | `mp3`                                                        |
| WAV    | `RIFF…WAVE`                     | `pcm_s16le`, `pcm_s24le`, `pcm_s32le`, `pcm_f32le`, `pcm_u8` |
| M4A    | `ftyp` with an MP4-family brand | `aac`, `alac`                                                |

- At most 30 MB per file, one voiceover and one music file per video.
- Mono or stereo only; sample rates 8–96 kHz (common rates only).
- Duration: at least 0.5 s; a voiceover at most 30.25 s (the longest video
  plus the tolerance); music at most 10 minutes.
- Rejected: corrupt files (a full decode must finish without errors), files
  with video, embedded cover art, subtitles, data or attachment streams,
  more than one audio track, unknown codecs, and anything whose bytes aren't
  MP3/WAV/M4A, whatever its name or browser-reported type. Each file is
  opened with the demuxer its bytes identified (`-f mp3|wav|mov`), never by
  guessing.
- Files are stored privately like images (`assets/<assetId>.<ext>`, 0600)
  under generated names; nothing is fetched from URLs.

### Timing rules

The video is N frames at 30 fps, so the audio is made **exactly N × 1600
samples at 48 kHz**: `apad` pads and `atrim` cuts at that boundary. No audio
file can lengthen or shorten the video.

- **Voiceover** starts at 0:00 with the first scene. Shorter narration is
  followed by silence to the end. Narration may run at most **0.25 s** past
  the end (it's trimmed exactly there); anything longer is **rejected**
  before rendering, with the actual lengths, instead of being cut off.
- **Music** starts at 0:00. A track shorter than the video loops (a finite
  number of repeats: `ceil(video / track)`, then trimmed); a longer one is
  trimmed. It fades in over 50 ms and out over the last 1.5 s. Loop seams
  are plain cuts, so loops sound best with tracks made to loop.

### Levels and mixing

Loudness is measured, not guessed: a first `loudnorm` pass analyses exactly
the audio that will be used, and the second pass applies a **linear** gain
from those measurements (two-pass EBU R128 normalization). Silent or
unmeasurable files are rejected rather than amplified.

| Source                  | Target (integrated)                          |
| ----------------------- | -------------------------------------------- |
| Voiceover               | −16 LUFS, true peak ≤ −1.5 dBTP              |
| Music alone             | −16 LUFS                                     |
| Music under a voiceover | low −30 LUFS (default), medium −26, high −23 |

With both, the music is additionally **ducked** while the narrator speaks
(`sidechaincompress`: threshold ≈ −30 dBFS, ratio 6, 20 ms attack, 400 ms
release), mixed with the voice without renormalization (`amix
normalize=0`), and the result passes a delay-compensated limiter at about
−1.5 dBFS (`alimiter latency=1`) and a 50 ms end fade against clicks.

### Encoding and muxing

The audio stage runs **after** the silent video is encoded and verified. It
copies the H.264 stream (`-c:v copy`, no second video encode) and encodes
only the audio: AAC-LC, 48 kHz, stereo, `-b:a 192k` with the AAC encoder that
passed its test encode. The native encoder treats 192 kb/s as a target; on
sparse content such as narration with pauses the average is lower (measured
63–197 kb/s). Every number in the audio filter graph is computed and
validated on the server; user files are only `-i file:` arguments.

### Verification and failure

The final MP4 must have one H.264 and one AAC-LC 48 kHz stereo stream, both
lasting the storyboard's duration (±0.1 s), and its audio must decode fully.
If measuring, mixing or verification fails, the job is marked failed with a
plain message and nothing is published. A missing AAC encoder fails an audio
job before any encoding starts.

### Measured results (FFmpeg 6.1.1, native `aac`)

From the real integration tests (generated sine-tone speech and music, so no
rights issues) and the four-mode benchmark:

- Voiceover onset in the output: 2.002 s for narration starting at 2.000 s.
- Speech loudness: −15.8 LUFS (target −16); music-only: −16.2 LUFS; full
  benchmark mixes: −16.1 to −16.3 LUFS integrated, peaks −10 to −11.6 dBFS.
- Voiceover + music: the speech band is 23 dB above the ducked music while
  talking; ducking lowers the music by about 8.5 dB during speech.
- Looped music keeps its level (0.04 dB drift); the last 0.15 s is more than
  20 dB quieter (fade-out).

## 6. Job management (DV-003D1)

Pixel Studio keeps every render as a job on disk, so history survives page
reloads and server restarts. The **Render history** card lists them with the
actions that make sense for each state, and the **Render** card offers
**Cancel render** while a render runs.

### Lifecycle

```
draft ──► queued ──► rendering ──► completed
  │         │            │
  │         │            ├──► failed ──► queued   (manual Retry)
  │         └────────────┴──► cancelled
  └──► (deleted)          completed / failed / cancelled ──► (deleted)
```

| State     | Actions in the history    |
| --------- | ------------------------- |
| Draft     | Delete                    |
| Queued    | Cancel                    |
| Rendering | Cancel                    |
| Completed | Preview, Download, Delete |
| Failed    | Retry, Delete             |
| Cancelled | Delete                    |

Transitions are checked against this table under a per-job lock, and retry
additionally requires the job to be `failed` at that moment ("expected
state"), so concurrent requests can't race. Completion, cancellation and
failure are mutually exclusive: only the queue decides an active job's final
state. Job files written by DV-003A/B/C are read unchanged.

### Cancellation

- **Queued:** the job leaves the waiting list immediately, becomes
  `cancelled`, frees its slot and never starts. Its uploads are kept until
  deleted.
- **Rendering:** the queue aborts the render's `AbortController`. The signal
  reaches every FFmpeg/FFprobe call (scene composition, encoding, loudness
  measurement, audio mixing, verification): `spawn`ed processes get SIGTERM,
  then SIGKILL if they're still running after 2 s; probes are killed at once.
  Each runner resolves only after its process has exited, then the scratch
  directory and any output are removed and the job becomes `cancelled`.
- **Near completion:** the abort flag is checked right before publishing and
  again before the `completed` transition. A cancel that arrives after FFmpeg
  finished but before publication wins (the output is discarded); one that
  arrives after the job completed is answered with the completed job.
  `cancelled → completed` is impossible.
- Cancelling a cancelled job again is harmless; drafts, completed and failed
  jobs can't be cancelled (409).

### Retry

Only `failed` jobs, including jobs interrupted by a restart. Retry reuses the
stored images, audio and server-built project (no re-upload) after
re-validating the project and checking that every file still exists; it
removes old scratch files and partial output, clears the error, and re-enters
the same bounded queue (one active render, three waiting). A second retry
while the first is pending is refused, as are retries of completed, cancelled,
queued or rendering jobs. FFmpeg (and AAC for audio projects) must be ready.
There are no automatic retries.

### History and deletion

- `GET /api/studio/pixel/jobs` returns at most 30 jobs by default (100 max),
  newest first, as summaries: product name, state, times, audio mode, image
  count, verified duration and size, error message, live progress and
  preview/download links for completed videos. No paths and no stored asset
  details.
- **Delete** (after a confirmation dialog) removes the job folder: images,
  audio, project, scratch files, video and metadata. Only real job folders
  named by generated IDs are deleted, symlinks are removed without being
  followed, and queued/rendering jobs are refused (cancel first). Afterwards
  the job's status and video endpoints answer 404.

### Storage and cleanup

`GET /api/studio/pixel/storage` sums real files only (no symlinks): uploads,
videos, scratch files and metadata, plus job counts by state (with
interrupted jobs counted separately). **Clean up temporary files**
(`POST …/storage/cleanup`) empties scratch folders of inactive jobs, removes
interrupted temp files and deletes drafts untouched for an hour. It never
touches queued or rendering jobs, completed videos, or failed and cancelled
jobs. Those are only removed when you delete them.

### Restart recovery

On startup the server:

1. stops orphaned `ffmpeg`/`ffprobe` processes of a previous server (Linux /
   WSL: via `/proc`, only processes of this user whose working directory is
   inside Pixel Studio's private job storage);
2. marks jobs still `queued` or `rendering` as `failed` with the reason
   "interrupted", and removes their partial output and scratch files;
3. leaves completed, failed and cancelled jobs as they are.

Interrupted jobs can then be retried. A render is never resumed halfway.

### Measured (FFmpeg 6.1.1, this machine)

- Real cancellation in every stage (integration tests, live process
  confirmed each time): settled in 9–449 ms. Encoding takes the longest
  because FFmpeg finishes the current frame on SIGTERM; no FFmpeg process
  remains afterwards.
- Over HTTP: the cancel request returns in 40–464 ms; afterwards the job is
  `cancelled`, its scratch and output folders are empty, its video answers
  404, and retry is refused.
- Rendering after DV-003D1: FFmpeg peak memory 469–471 MiB (DV-003C: 458–471)
  with identical outputs; the H.264 stream is still copied, not re-encoded.

## 7. Video output target

Fixed in `src/lib/video/format.ts`. Clients can't change it.

| Property     | Value                                                                            |
| ------------ | -------------------------------------------------------------------------------- |
| Resolution   | 1080 × 1920 px                                                                   |
| Aspect ratio | 9:16 (vertical)                                                                  |
| Frame rate   | 30 fps (constant)                                                                |
| Container    | MP4 with `+faststart` (playback starts before download ends)                     |
| Video codec  | H.264 (High profile with libx264), `yuv420p`                                     |
| Duration     | 15–30 seconds                                                                    |
| Audio        | None by default; with audio: AAC-LC, 48 kHz, stereo, 192 kb/s target, one stream |

### Storyboard template

`buildStoryboard()` (`src/lib/video/storyboard.ts`) produces a fixed
template. The browser uses it for the preview and **the server rebuilds it
independently** for rendering.

1. **Hook:** headline over the hero (first) image, with the product name
2. **Benefits:** one scene per benefit (1–5), cycling through the other images
3. **Call to action:** CTA pill over the hero image, with the product name

The affiliate disclosure is on every scene. Durations are whole frames: base
durations (3 s hook, 4 s per benefit, 4 s CTA) are fitted proportionally
into 15–30 s, with each scene kept within 2–8 s.

### Validation rules

`src/lib/video/validation.ts` is shared by the form and the server; the
server is the real gate.

- **Render requests** may contain exactly `{ product, assetIds, audio? }`.
  `audio` holds only a mode, uploaded audio IDs of this job and a music
  level. Scenes, timings, settings, captions, asset metadata, paths, filter
  graphs and FFmpeg options are rejected ("decided by the server").
- **Audio** IDs must belong to the job being rendered and match their role;
  the mode decides which files are required and forbids the others.
- **Strict objects** everywhere: unknown keys are errors.
- **Text:** NFC-normalized, whitespace collapsed to one line, lengths in
  characters (product name 60, headline 70, benefit 80, CTA 40, disclosure
  140). Control, bidi-override, zero-width, private-use and lone-surrogate
  characters are refused, and so are characters the video font can't draw.
- **Images:** 3–6 per video; JPEG, PNG or WebP only (no SVG or GIF); at most
  10 MB each; each side 320–8192 px, at most 40 MP. Every image ID must belong
  to the job being rendered (cross-job references are rejected) and appear
  only once.
- **Scenes:** 3–8, hook first and CTA last, 2–8 s each in whole frames,
  15–30 s total.

## 8. Local file storage

`src/server/video/storage.ts` (server-only). Data lives **outside the
repository** in the per-user application data folder:

| Platform    | Location                                                    |
| ----------- | ----------------------------------------------------------- |
| Linux / WSL | `$XDG_DATA_HOME/deskverse`, else `~/.local/share/deskverse` |
| macOS       | `~/Library/Application Support/Deskverse`                   |
| Windows     | `%LOCALAPPDATA%\Deskverse`                                  |

`DESKVERSE_DATA_DIR` overrides it. It must be absolute, and any location
inside the project (including `public/`) is refused, so private files can
never be served by Next.js or committed. Playwright runs use a throwaway
folder in the system temp directory.

```
<data>/video/jobs/<jobId>/
  job.json                 state, images, audio files, error, verified output facts
  project.json             the server-built project the renderer uses
  assets/<assetId>.<ext>   uploaded images and audio, renamed to generated IDs
  work/                    scratch space for one render, always emptied afterwards
  output/video.mp4         the finished, verified render
```

- **Generated IDs only:** `job_` / `asset_` + 128 random bits in hex. User
  file names are sanitized and only displayed.
- **Path containment:** every path is built with `resolveInside()` (simple
  segments only, proven to stay under the root). Symlinks are refused and
  real paths re-checked.
- **Uploads:** `Content-Length` is checked first, the body is counted while
  streaming and cut off at 10 MB, the type is identified by the file's
  bytes, FFprobe must agree on codec and size, and FFmpeg must decode the
  image without errors. A failed check deletes the file again.
- **Owner-only permissions:** directories `0700`, files `0600`, files written
  with `wx` (never overwrite), metadata written atomically (temp file +
  rename), and updates to one job serialized. `project.json` can only be
  written while the job is a draft.
- **Outputs:** served only for `completed` jobs (which the queue sets only
  after verification), and only if the file is a regular file inside
  storage. Its path is never sent to the browser.

## 9. Security model

| Boundary          | Rule                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browser → server  | The browser sends _data_: image bytes, product text and image IDs. Never commands, flags, filters, paths, timings or codec options.                                                                                                              |
| Server → FFmpeg   | `spawn`/`execFile` with `shell: false` and argument arrays built by server code. `-nostdin`, closed stdin, `-protocol_whitelist file`, `file:` inputs/outputs, timeouts, output caps, minimal environment.                                       |
| Audio → FFmpeg    | Stored audio files are argv inputs with a forced demuxer (`-f mp3\|wav\|mov -i file:…`). The client chooses only a mode, IDs and one of three levels; every gain, sample count and timestamp in the graph is computed and validated server-side. |
| Captions → FFmpeg | Text goes to per-job UTF-8 files drawn with `drawtext=textfile=…:expansion=none`, so `%{…}`, quotes, colons and brackets are drawn literally. Filter graphs contain only generated, escaped values.                                              |
| Errors            | Users see plain messages. Raw FFmpeg output (which may contain paths) only goes to the server log.                                                                                                                                               |
| Files             | Generated names, containment checks, symlink refusal, byte sniffing plus FFprobe and decode checks, size limits, data outside the repo.                                                                                                          |
| Job management    | Cancel, retry, delete, history, storage and cleanup use the same local-only guard. Action endpoints take no body (any body is refused), IDs must be generated job IDs, and the server alone decides which files a job owns.                      |
| Network           | Every endpoint (capabilities, jobs, uploads, render, status, video) checks `Host` (DNS rebinding), `X-Forwarded-*`, `Origin` and `Sec-Fetch-Site`. The render request must be JSON.                                                              |
| Hosting           | Rendering is **disabled** (503) when a hosting platform is detected (`VERCEL`, `NETLIFY`, `RENDER`, `FLY_APP_NAME`, `RAILWAY_ENVIRONMENT`, `K_SERVICE`, `AWS_LAMBDA_FUNCTION_NAME`, `DYNO`) or `DESKVERSE_DISABLE_LOCAL_RENDERING=1` is set.     |

**These checks are not authentication.** Headers can be forged by a program
that reaches the port directly. `next dev` / `next start` listen on all
interfaces by default, so run Deskverse bound to loopback:

```bash
yarn dev   -H 127.0.0.1
yarn start -H 127.0.0.1
```

WSL's localhost forwarding still lets your Windows browser reach
`http://localhost:3000`. Don't deploy Pixel Studio's rendering anywhere
public. The hosting gate is a safety net, not a substitute for keeping it
local.

## 10. Licensing and redistribution

_General information, not legal advice._

- **FFmpeg** is LGPL 2.1+ by default. Builds with `--enable-gpl` (needed for
  libx264, as in Ubuntu's package) are GPL. Builds with `--enable-nonfree`
  may be used but **not redistributed**. Pixel Studio shows the detected
  license and warns about non-free builds.
- **Deskverse doesn't bundle, link or distribute FFmpeg.** It starts the copy
  you installed as a separate program, so FFmpeg's license terms don't extend
  to Deskverse's code. If a future release bundles FFmpeg binaries, it must
  ship the license text and corresponding source as the (L)GPL requires.
- **H.264 is covered by patents** administered by a patent pool (Via LA,
  which absorbed MPEG LA's AVC program). Pool terms have historically waived
  royalties for internet video distributed free to viewers; review the
  current terms for your use, especially for paid distribution. Cisco's
  prebuilt OpenH264 binaries come with Cisco covering the pool royalties.
- **Caption font:** Inter 4.1 by The Inter Project Authors, under the SIL Open
  Font License 1.1 (`assets/fonts/inter/LICENSE.txt`). The OFL allows
  commercial use, bundling with software and embedding in videos you
  distribute. The font files may not be sold on their own, and modified
  versions must be renamed. Deskverse ships the unmodified static
  `Inter-Bold.ttf` and `Inter-Medium.ttf` from the official 4.1 release.
- **AAC:** the native FFmpeg `aac` encoder is part of FFmpeg's LGPL code and
  is what Deskverse prefers. `libfdk_aac` is non-free (not redistributable).
- **Your media:** you need the rights to every image **and every audio file**
  you use. Commercial affiliate videos need music licensed for commercial
  use (many "free" tracks are personal-use only) and voice recordings you
  made or may use. Deskverse doesn't fetch, check or license audio; the
  studio shows this notice whenever audio is chosen.
- **Images:** affiliate programs often restrict how product images may be
  used, so check your program's terms.
- **Disclosure:** advertising rules (e.g. the US FTC Endorsement Guides) and
  platform policies require a clear disclosure when you can earn a
  commission. Pixel Studio requires disclosure text and burns it into every
  scene. Also use each platform's branded-content or paid-partnership
  setting.

## 11. Measured performance

One full render on the development machine (WSL2, Ubuntu 24.04, 16 cores,
9.6 GB RAM, FFmpeg 6.1.1, libx264, no GPU), from four real JPEG photos
(three at 3840×2400, one at 1920×1080) uploaded through the HTTP API:

| Measure                                    | Result                      |
| ------------------------------------------ | --------------------------- |
| Render request → verified completion       | 9.3 s                       |
| Output                                     | 19.0 s, 570 frames, 1.45 MB |
| FFmpeg peak memory (one process at a time) | 471 MiB                     |
| FFmpeg peak CPU                            | ~3.9 cores                  |
| Upload + FFprobe checks (3 photos, via UI) | ~0.7 s                      |
| Full decode of the output                  | no errors                   |

libx264's own frame buffers dominate memory use. An earlier version fed the
scenes as looping inputs, which made FFmpeg decode every scene ahead in
parallel and reached 1.4–1.7 GB. The single-frame inputs plus `loop` filter,
4-thread cap and shorter lookahead bring it under 0.5 GB, and memory no
longer grows with the number of scenes. Rendering on CPU is expected; slow
isn't failing, and the encode timeout is 10 minutes.

**With audio (DV-003C),** same machine and photos, 19 s video:

| Mode              | Render | FFmpeg peak |    File | Audio (average)       |
| ----------------- | -----: | ----------: | ------: | --------------------- |
| Silent (baseline) |  8.8 s |     458 MiB | 1.45 MB | none                  |
| Voiceover         |  9.8 s |     471 MiB | 1.61 MB | AAC-LC 63 kb/s stereo |
| Music             | 10.4 s |     458 MiB | 1.93 MB | AAC-LC 197 kb/s       |
| Voiceover + music | 11.3 s |     469 MiB | 1.89 MB | AAC-LC 180 kb/s       |

Video and audio streams last exactly 19.000 s in every mode, and the H.264
bitstream is byte-identical to the silent render (copied, never re-encoded).
All four files decode without errors. In Firefox, the three audio videos
play with an audio track and audible output (the silent one has no audio
track); Firefox reports 19.02 s because of AAC encoder padding, within the
0.1 s tolerance.

## 12. Limitations

- One fixed template, simple cuts, no motion or transitions.
- Audio: no trimming, offsets, crossfaded loops or per-scene sync points;
  narration always starts at 0:00. Music loop seams are hard cuts. MP3s with
  embedded cover art must be exported without artwork first. Loudness
  targets are met by two-pass normalization and measured in tests, but they
  aren't a broadcast-compliance certification.
- Captions support the characters in Inter (Latin, Greek, Cyrillic and common
  symbols). Emoji and CJK are rejected rather than drawn.
- JPEG EXIF orientation isn't applied. A phone photo stored sideways with a
  rotation tag renders sideways, so rotate it before uploading.
- Jobs are managed by one server process. Running several Deskverse servers
  on the same data folder isn't supported.
- Orphaned FFmpeg processes are found and stopped on Linux/WSL only (via
  `/proc`); elsewhere they end on their own when their input is processed.
- The in-page preview needs a browser with H.264 playback (Chrome, Edge,
  Firefox, Safari). Playwright's bundled Chromium can't decode H.264, so the
  E2E suite checks the file itself and playback only where supported.

## 13. Remaining work

**DV-003D2 and later:** crossfades (`xfade`), gentle motion on stills, EXIF
orientation, and more templates. Audio follow-ups: trimming and offsets
for narration, crossfaded music loops, per-scene timing cues, and accepting
MP3s with cover art by ignoring the picture.

## 14. Code map

```
assets/fonts/inter/            Inter Bold + Medium (OFL 1.1) for captions
src/lib/video/                 shared, client-safe
  format.ts                    fixed output format, frame helpers
  types.ts                     ProductInfo, MediaAsset, VideoScene, Caption, VideoSettings, VideoProject
  ids.ts                       RenderJobId / AssetId: generation + strict patterns
  render-job.ts                job states, transitions, RenderOutput, RenderProgress
  render-api.ts                HTTP contract: endpoints, request/status shapes (incl. audio)
  validation.ts                all input validation
  storyboard.ts                storyboard template + duration fitting
  capabilities.ts              capability report types, required filters
src/server/                    server-only (import "server-only")
  process/run-executable.ts    execFile runner + streaming spawn (no shell), AbortSignal cancellation
  process/orphans.ts           stops orphaned FFmpeg of a previous server (Linux /proc)
  http/local-request.ts        loopback Host/Origin/Fetch-Metadata checks
  http/local-api.ts            endpoint guard, hosting gate, bounded body reading
  http/range.ts                byte ranges, download names
  http/render-errors.ts        error → HTTP response mapping
  video/ffmpeg-capabilities.ts detection, parsing, encoder test encodes, cache
  video/ffmpeg-command.ts      layout, caption wrapping, escaping, argument arrays
  video/ffprobe.ts             probe arguments, image/audio/output verification, progress parser
  video/audio-command.ts       loudness measurement, audio mix/mux arguments, AAC options
  video/audio-sniff.ts         byte-level MP3/WAV/M4A identification
  video/font-metrics.ts        TrueType cmap/hmtx parsing, glyph coverage, widths
  video/project.ts             trusted project reconstruction
  video/render-service.ts      one render: compose → encode → verify → publish
  video/render-queue.ts        one-at-a-time queue: cancel, retry, delete, restart recovery
  video/job-summary.ts         history rows and storage summary (no paths)
  video/storage.ts             private job storage, path safety, data dir
  video/image-sniff.ts         byte-level image type and dimension checks
  video/upload-verify.ts       FFprobe + decode upload check, public job status
src/app/api/studio/pixel/      capabilities, jobs (list/create/status/delete), assets, audio, render,
                               cancel, retry, video, storage, storage/cleanup routes
src/components/studio/pixel/   studio UI, render panel, render history, use-render-job hook
tests/*.test.ts                unit tests (FFmpeg mocked)
tests/integration/             real-FFmpeg integration tests: video and the four audio modes
e2e/pixel-*.spec.ts            Playwright: UI (mocked FFmpeg) and real rendering
```
