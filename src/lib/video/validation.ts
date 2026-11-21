/**
 * Validation for everything a client can send about a video project.
 *
 * Shared by the Pixel Studio form (instant feedback) and, from DV-003B, by the
 * server (the real gate). Every input is treated as `unknown`: objects must
 * have exactly the expected keys, so a client cannot smuggle extra fields such
 * as FFmpeg arguments, file paths or codec options into a request.
 */
import {
  MAX_SCENE_FRAMES,
  MAX_TOTAL_FRAMES,
  MIN_SCENE_FRAMES,
  MIN_TOTAL_FRAMES,
  VIDEO_FORMAT,
} from "@/lib/video/format"
import { isAssetId, type AssetId } from "@/lib/video/ids"
import {
  AUDIO_CONTAINERS,
  AUDIO_MODES,
  AUDIO_ROLES,
  IMAGE_EXTENSIONS,
  IMAGE_MIME_TYPES,
  MUSIC_LEVELS,
  type AudioAsset,
  type AudioConfig,
  type AudioContainer,
  type AudioMode,
  type AudioRole,
  type MusicLevel,
  type Caption,
  type CaptionPosition,
  type CaptionRole,
  type ImageMimeType,
  type MediaAsset,
  type MediaAssetMetadata,
  type ProductInfo,
  type SceneKind,
  type VideoProject,
  type VideoScene,
  type VideoSettings,
} from "@/lib/video/types"

export interface ValidationIssue {
  /** Dotted path to the offending field: "name", "benefits.1", "scenes.0.caption.text". */
  path: string
  message: string
}

export type Validation<T> =
  { ok: true; value: T } | { ok: false; issues: ValidationIssue[] }

/** Character limits, counted in Unicode code points. */
export const TEXT_LIMITS = {
  name: 60,
  headline: 70,
  benefit: 80,
  callToAction: 40,
  disclosure: 140,
} as const

export const BENEFIT_COUNT = { min: 1, max: 5 } as const

export const MEDIA_LIMITS = {
  /** Per image. Large enough for a phone photo, small enough to keep renders fast. */
  maxBytes: 10 * 1024 * 1024,
  /** DV-003B: a hook, benefit and call-to-action image at minimum. */
  minCount: 3,
  maxCount: 6,
  /** Smallest side; below this an image is visibly soft at 1080 px wide. */
  minSide: 320,
  maxSide: 8192,
  maxPixels: 40_000_000,
} as const

/** Hook + up to five benefits + call to action, with room for one more. */
export const MAX_SCENES = 8

export const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  width: VIDEO_FORMAT.width,
  height: VIDEO_FORMAT.height,
  fps: VIDEO_FORMAT.fps,
  container: VIDEO_FORMAT.container,
  videoCodec: VIDEO_FORMAT.videoCodec,
  pixelFormat: VIDEO_FORMAT.pixelFormat,
  audio: VIDEO_FORMAT.audio,
}

export const DEFAULT_DISCLOSURE =
  "#ad · I may earn a commission if you buy through my link."

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Characters never allowed in captions: control characters, bidirectional
 * overrides (they can visually reorder text), other invisible format
 * characters except the joiners emoji need, private-use and lone surrogates.
 */
const FORBIDDEN_CHARACTERS =
  /[\p{Cc}\p{Co}\p{Cs}\u2028\u2029]|(?![\u200C\u200D])\p{Cf}/u

/** NFC-normalizes and collapses all whitespace (including newlines) to single spaces. */
export function normalizeText(raw: string) {
  return raw.normalize("NFC").replace(/\s+/gu, " ").trim()
}

export function codePointLength(text: string) {
  return Array.from(text).length
}

export interface TextRule {
  label: string
  max: number
}

/** Validates one caption-style text field. `path` is used in the issue. */
export function validateText(
  raw: unknown,
  rule: TextRule,
  path: string,
  emptyMessage = `Enter ${articleFor(rule.label)} ${rule.label.toLowerCase()}.`,
): Validation<string> {
  if (typeof raw !== "string") return fail(path, `${rule.label} must be text.`)
  const text = normalizeText(raw)
  if (text.length === 0) return fail(path, emptyMessage)
  if (FORBIDDEN_CHARACTERS.test(text))
    return fail(
      path,
      `${rule.label} contains invisible or control characters. Retype it without them.`,
    )
  const length = codePointLength(text)
  if (length > rule.max)
    return fail(
      path,
      `${rule.label} must be ${rule.max} characters or fewer (currently ${length}).`,
    )
  return { ok: true, value: text }
}

function articleFor(label: string) {
  return /^[aeiou]/i.test(label) ? "an" : "a"
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

export const PRODUCT_RULES = {
  name: { label: "Product name", max: TEXT_LIMITS.name },
  headline: { label: "Video headline", max: TEXT_LIMITS.headline },
  benefit: { label: "Benefit", max: TEXT_LIMITS.benefit },
  callToAction: { label: "Call to action", max: TEXT_LIMITS.callToAction },
  disclosure: { label: "Affiliate disclosure", max: TEXT_LIMITS.disclosure },
} as const satisfies Record<string, TextRule>

const PRODUCT_KEYS = [
  "name",
  "headline",
  "benefits",
  "callToAction",
  "disclosure",
] as const

export function validateProduct(
  input: unknown,
  basePath = "",
): Validation<ProductInfo> {
  const at = (key: string) => join(basePath, key)
  const object = readStrictObject(input, PRODUCT_KEYS, basePath, "Product")
  if (!object.ok) return object

  const issues: ValidationIssue[] = []
  const take = (result: Validation<string>) => {
    if (result.ok) return result.value
    issues.push(...result.issues)
    return ""
  }

  const name = take(
    validateText(object.value.name, PRODUCT_RULES.name, at("name")),
  )
  const headline = take(
    validateText(object.value.headline, PRODUCT_RULES.headline, at("headline")),
  )
  const callToAction = take(
    validateText(
      object.value.callToAction,
      PRODUCT_RULES.callToAction,
      at("callToAction"),
    ),
  )
  const disclosure = take(
    validateText(
      object.value.disclosure,
      PRODUCT_RULES.disclosure,
      at("disclosure"),
      "Enter an affiliate disclosure. Viewers must be told you may earn a commission.",
    ),
  )

  const benefits: string[] = []
  const rawBenefits = object.value.benefits
  if (!Array.isArray(rawBenefits)) {
    issues.push({ path: at("benefits"), message: "Benefits must be a list." })
  } else if (rawBenefits.length < BENEFIT_COUNT.min) {
    issues.push({ path: at("benefits"), message: "Add at least one benefit." })
  } else if (rawBenefits.length > BENEFIT_COUNT.max) {
    issues.push({
      path: at("benefits"),
      message: `Use at most ${BENEFIT_COUNT.max} benefits.`,
    })
  } else {
    rawBenefits.forEach((raw, index) => {
      const n = index + 1
      benefits.push(
        take(
          validateText(
            raw,
            { label: `Benefit ${n}`, max: TEXT_LIMITS.benefit },
            at(`benefits.${index}`),
            `Enter benefit ${n} or remove it.`,
          ),
        ),
      )
    })
  }

  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    value: { name, headline, benefits, callToAction, disclosure },
  }
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export function isImageMimeType(value: unknown): value is ImageMimeType {
  return (
    typeof value === "string" &&
    (IMAGE_MIME_TYPES as readonly string[]).includes(value)
  )
}

/** Lowercased extension after the last dot, or "" when there is none. */
export function extensionOf(fileName: string) {
  const base = fileName.split(/[\\/]/).pop() ?? ""
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ""
}

/**
 * A file name safe to *display*: last path segment only, no control or
 * bidi characters, at most 100 code points. Never used to build paths.
 */
export function sanitizeDisplayName(fileName: string) {
  const base = (fileName.split(/[\\/]/).pop() ?? "")
    .normalize("NFC")
    .replace(new RegExp(FORBIDDEN_CHARACTERS.source, "gu"), "")
    .replace(/\s+/gu, " ")
    .trim()
  const clipped = Array.from(base).slice(0, 100).join("")
  return clipped.length > 0 ? clipped : "image"
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`
}

const MEDIA_METADATA_KEYS = [
  "fileName",
  "mimeType",
  "sizeBytes",
  "width",
  "height",
] as const

/**
 * Validates what a client reports about an image. The server must still
 * re-check the bytes themselves (see `sniffImageType` in storage).
 */
export function validateMediaMetadata(
  input: unknown,
  basePath = "",
): Validation<MediaAssetMetadata> {
  const object = readStrictObject(
    input,
    MEDIA_METADATA_KEYS,
    basePath,
    "Image details",
  )
  if (!object.ok) return object
  const { fileName, mimeType, sizeBytes, width, height } = object.value
  const at = (key: string) => join(basePath, key)
  const name =
    typeof fileName === "string" ? sanitizeDisplayName(fileName) : "image"

  if (
    typeof fileName !== "string" ||
    fileName.length === 0 ||
    fileName.length > 255
  )
    return fail(
      at("fileName"),
      "The image needs a file name of 255 characters or fewer.",
    )
  if (!isImageMimeType(mimeType))
    return fail(
      at("mimeType"),
      `“${name}” isn't a supported image. Use JPEG, PNG or WebP.`,
    )
  const extension = extensionOf(fileName)
  if (!IMAGE_EXTENSIONS[mimeType].includes(extension))
    return fail(
      at("fileName"),
      `“${name}” has a file extension that doesn't match its type. Use .jpg, .png or .webp.`,
    )
  if (!isPositiveInteger(sizeBytes))
    return fail(at("sizeBytes"), `“${name}” is empty.`)
  if (sizeBytes > MEDIA_LIMITS.maxBytes)
    return fail(
      at("sizeBytes"),
      `“${name}” is ${formatBytes(sizeBytes)}. Images must be ${formatBytes(MEDIA_LIMITS.maxBytes)} or smaller.`,
    )
  if (!isPositiveInteger(width) || !isPositiveInteger(height))
    return fail(at("width"), `“${name}” has no readable dimensions.`)
  if (Math.min(width, height) < MEDIA_LIMITS.minSide)
    return fail(
      at("width"),
      `“${name}” is ${width}×${height} px. Each side must be at least ${MEDIA_LIMITS.minSide} px.`,
    )
  if (
    Math.max(width, height) > MEDIA_LIMITS.maxSide ||
    width * height > MEDIA_LIMITS.maxPixels
  )
    return fail(
      at("width"),
      `“${name}” is ${width}×${height} px. Images can be at most ${MEDIA_LIMITS.maxSide} px per side and 40 megapixels.`,
    )

  return {
    ok: true,
    value: { fileName, mimeType, sizeBytes, width, height },
  }
}

const MEDIA_ASSET_KEYS = [
  "id",
  "kind",
  "mimeType",
  "sizeBytes",
  "width",
  "height",
  "displayName",
] as const

export function validateMediaAsset(
  input: unknown,
  basePath = "",
): Validation<MediaAsset> {
  const object = readStrictObject(input, MEDIA_ASSET_KEYS, basePath, "Asset")
  if (!object.ok) return object
  const { id, kind, displayName, ...rest } = object.value
  if (!isAssetId(id)) return fail(join(basePath, "id"), "Unknown asset ID.")
  if (kind !== "image")
    return fail(join(basePath, "kind"), "Only images are supported.")
  if (typeof displayName !== "string")
    return fail(join(basePath, "displayName"), "Asset name must be text.")
  const metadata = validateMediaMetadata(
    { ...rest, fileName: guessFileName(displayName, rest.mimeType) },
    basePath,
  )
  if (!metadata.ok) return metadata
  const { mimeType, sizeBytes, width, height } = metadata.value
  return {
    ok: true,
    value: {
      id,
      kind,
      mimeType,
      sizeBytes,
      width,
      height,
      displayName: sanitizeDisplayName(displayName),
    },
  }
}

/** Stored assets keep only a display name; give it a matching extension to reuse the checks. */
function guessFileName(displayName: string, mimeType: unknown) {
  const ext = isImageMimeType(mimeType) ? IMAGE_EXTENSIONS[mimeType][0] : "bin"
  return `${displayName || "image"}.${ext}`
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

const SCENE_KINDS: readonly SceneKind[] = ["hook", "benefit", "call-to-action"]
const CAPTION_POSITIONS: readonly CaptionPosition[] = [
  "top",
  "center",
  "bottom",
]
const ROLE_FOR_KIND: Record<SceneKind, CaptionRole> = {
  hook: "headline",
  benefit: "benefit",
  "call-to-action": "call-to-action",
}
const RULE_FOR_ROLE: Record<CaptionRole, TextRule> = {
  headline: { label: "Caption", max: TEXT_LIMITS.headline },
  benefit: { label: "Caption", max: TEXT_LIMITS.benefit },
  "call-to-action": { label: "Caption", max: TEXT_LIMITS.callToAction },
}

const SCENE_KEYS = [
  "id",
  "kind",
  "durationFrames",
  "assetId",
  "caption",
] as const
const CAPTION_KEYS = ["text", "subtext", "role", "position"] as const

/** Checks one scene's duration in frames against the per-scene bounds. */
export function validateSceneDuration(
  frames: unknown,
  path = "durationFrames",
): Validation<number> {
  if (typeof frames !== "number" || !Number.isInteger(frames))
    return fail(path, "Scene duration must be a whole number of frames.")
  if (frames < MIN_SCENE_FRAMES || frames > MAX_SCENE_FRAMES)
    return fail(
      path,
      `Each scene must last ${MIN_SCENE_FRAMES / VIDEO_FORMAT.fps}–${MAX_SCENE_FRAMES / VIDEO_FORMAT.fps} seconds.`,
    )
  return { ok: true, value: frames }
}

/** Checks the whole video's length against the 15–30 second target. */
export function validateTotalDuration(
  totalFrames: number,
  path = "scenes",
): Validation<number> {
  if (totalFrames < MIN_TOTAL_FRAMES || totalFrames > MAX_TOTAL_FRAMES)
    return fail(
      path,
      `The video must last ${VIDEO_FORMAT.minDurationSeconds}–${VIDEO_FORMAT.maxDurationSeconds} seconds (currently ${(totalFrames / VIDEO_FORMAT.fps).toFixed(1)} s).`,
    )
  return { ok: true, value: totalFrames }
}

export function validateScenes(
  input: unknown,
  knownAssetIds: ReadonlySet<string>,
  basePath = "scenes",
): Validation<VideoScene[]> {
  if (!Array.isArray(input)) return fail(basePath, "Scenes must be a list.")
  if (input.length < 3 || input.length > MAX_SCENES)
    return fail(basePath, `A storyboard needs 3–${MAX_SCENES} scenes.`)

  const issues: ValidationIssue[] = []
  const scenes: VideoScene[] = []
  const seen = new Set<string>()

  input.forEach((raw, index) => {
    const at = (key: string) => join(`${basePath}.${index}`, key)
    const object = readStrictObject(
      raw,
      SCENE_KEYS,
      `${basePath}.${index}`,
      "Scene",
    )
    if (!object.ok) return issues.push(...object.issues)
    const { id, kind, durationFrames, assetId, caption } = object.value

    if (typeof id !== "string" || !/^scene-[1-9]\d?$/.test(id) || seen.has(id))
      issues.push({
        path: at("id"),
        message: "Scene IDs must be unique, like “scene-1”.",
      })
    else seen.add(id)

    if (!SCENE_KINDS.includes(kind as SceneKind)) {
      issues.push({ path: at("kind"), message: "Unknown scene type." })
      return
    }
    const sceneKind = kind as SceneKind
    const expected =
      index === 0
        ? "hook"
        : index === input.length - 1
          ? "call-to-action"
          : "benefit"
    if (sceneKind !== expected)
      issues.push({
        path: at("kind"),
        message:
          "Storyboards open with the hook, end with the call to action and show benefits in between.",
      })

    const duration = validateSceneDuration(durationFrames, at("durationFrames"))
    if (!duration.ok) issues.push(...duration.issues)

    if (assetId !== null && !(isAssetId(assetId) && knownAssetIds.has(assetId)))
      issues.push({
        path: at("assetId"),
        message: "Scene refers to an image that isn't in this project.",
      })

    const parsedCaption = validateCaption(
      caption,
      ROLE_FOR_KIND[sceneKind],
      at("caption"),
    )
    if (!parsedCaption.ok) issues.push(...parsedCaption.issues)

    if (duration.ok && parsedCaption.ok && issues.length === 0)
      scenes.push({
        id: id as string,
        kind: sceneKind,
        durationFrames: duration.value,
        assetId: assetId as AssetId | null,
        caption: parsedCaption.value,
      })
  })

  if (issues.length > 0) return { ok: false, issues }
  const total = validateTotalDuration(
    scenes.reduce((sum, scene) => sum + scene.durationFrames, 0),
    basePath,
  )
  if (!total.ok) return total
  return { ok: true, value: scenes }
}

function validateCaption(
  input: unknown,
  expectedRole: CaptionRole,
  path: string,
): Validation<Caption> {
  const object = readStrictObject(input, CAPTION_KEYS, path, "Caption")
  if (!object.ok) return object
  const { text, subtext, role, position } = object.value
  if (role !== expectedRole)
    return fail(join(path, "role"), "Caption style doesn't match the scene.")
  if (!CAPTION_POSITIONS.includes(position as CaptionPosition))
    return fail(
      join(path, "position"),
      "Captions go at the top, center or bottom.",
    )
  const parsedText = validateText(
    text,
    RULE_FOR_ROLE[expectedRole],
    join(path, "text"),
  )
  if (!parsedText.ok) return parsedText
  let parsedSubtext: string | null = null
  if (subtext !== null) {
    const result = validateText(
      subtext,
      { label: "Subtext", max: TEXT_LIMITS.name },
      join(path, "subtext"),
    )
    if (!result.ok) return result
    parsedSubtext = result.value
  }
  return {
    ok: true,
    value: {
      text: parsedText.value,
      subtext: parsedSubtext,
      role: expectedRole,
      position: position as CaptionPosition,
    },
  }
}

// ---------------------------------------------------------------------------
// Audio (DV-003C)
// ---------------------------------------------------------------------------

/**
 * Narration may run this much past the end of the video (trailing silence
 * or a breath); it is trimmed exactly at the video boundary. Anything longer
 * is rejected so speech is never cut off silently.
 */
export const VOICEOVER_TOLERANCE_SECONDS = 0.25

export const AUDIO_LIMITS = {
  /** A few minutes of WAV, or a long MP3. */
  maxBytes: 30 * 1024 * 1024,
  minSeconds: 0.5,
  /** The longest possible video plus the tolerance. */
  maxVoiceoverSeconds:
    VIDEO_FORMAT.maxDurationSeconds + VOICEOVER_TOLERANCE_SECONDS,
  /** Music loops or is trimmed; only up to one video length is used. */
  maxMusicSeconds: 10 * 60,
  channels: [1, 2] as readonly number[],
  sampleRates: [
    8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000,
  ] as readonly number[],
} as const

/** File extensions offered in the picker (the server identifies files by bytes). */
export const AUDIO_EXTENSIONS: Record<AudioContainer, readonly string[]> = {
  mp3: ["mp3"],
  wav: ["wav"],
  m4a: ["m4a"],
}

/** Browser-reported types we accept as a hint; never trusted for decoding. */
export const AUDIO_MIME_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/vnd.wave",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
] as const

export function isAudioMimeType(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (AUDIO_MIME_TYPES as readonly string[]).includes(value.toLowerCase())
  )
}

export const ROLE_LABEL: Record<AudioRole, string> = {
  voiceover: "Voiceover",
  music: "Background music",
}

/**
 * Browser-side pre-check of a chosen audio file (name, size, hinted type).
 * Duration and format are re-established on the server with FFprobe.
 */
export function validateAudioFile(
  file: { name: string; size: number; type: string },
  role: AudioRole,
): Validation<{ container: AudioContainer }> {
  const name = sanitizeDisplayName(file.name)
  const extension = extensionOf(file.name)
  const container = (AUDIO_CONTAINERS as readonly string[]).find((c) =>
    AUDIO_EXTENSIONS[c as AudioContainer].includes(extension),
  ) as AudioContainer | undefined
  if (!container || (file.type !== "" && !isAudioMimeType(file.type)))
    return fail(
      role,
      `“${name}” isn't a supported audio file. Use MP3, WAV or M4A.`,
    )
  if (file.size <= 0) return fail(role, `“${name}” is empty.`)
  if (file.size > AUDIO_LIMITS.maxBytes)
    return fail(
      role,
      `“${name}” is ${formatBytes(file.size)}. Audio files must be ${formatBytes(AUDIO_LIMITS.maxBytes)} or smaller.`,
    )
  return { ok: true, value: { container } }
}

/** Checks probed audio facts against the limits (used by the server). */
export function checkAudioFacts(
  facts: { durationSeconds: number; sampleRate: number; channels: number },
  role: AudioRole,
  name: string,
): string | null {
  if (!AUDIO_LIMITS.channels.includes(facts.channels))
    return `“${name}” has ${facts.channels} channels. Use mono or stereo audio.`
  if (!AUDIO_LIMITS.sampleRates.includes(facts.sampleRate))
    return `“${name}” uses an unusual sample rate (${facts.sampleRate} Hz). Use 44.1 or 48 kHz audio.`
  if (!(facts.durationSeconds >= AUDIO_LIMITS.minSeconds))
    return `“${name}” is too short (at least ${AUDIO_LIMITS.minSeconds} s).`
  const max =
    role === "voiceover"
      ? AUDIO_LIMITS.maxVoiceoverSeconds
      : AUDIO_LIMITS.maxMusicSeconds
  if (facts.durationSeconds > max)
    return role === "voiceover"
      ? `“${name}” is ${facts.durationSeconds.toFixed(1)} s long. A voiceover can be at most ${VIDEO_FORMAT.maxDurationSeconds} s (the longest video).`
      : `“${name}” is longer than ${AUDIO_LIMITS.maxMusicSeconds / 60} minutes. Trim it first.`
  return null
}

const AUDIO_ASSET_KEYS = [
  "id",
  "kind",
  "role",
  "container",
  "codec",
  "sizeBytes",
  "durationSeconds",
  "sampleRate",
  "channels",
  "displayName",
] as const

export function validateAudioAsset(
  input: unknown,
  basePath = "",
): Validation<AudioAsset> {
  const object = readStrictObject(input, AUDIO_ASSET_KEYS, basePath, "Audio")
  if (!object.ok) return object
  const a = object.value
  const at = (key: string) => join(basePath, key)
  if (!isAssetId(a.id)) return fail(at("id"), "Unknown audio ID.")
  if (a.kind !== "audio") return fail(at("kind"), "Not an audio file.")
  if (!(AUDIO_ROLES as readonly unknown[]).includes(a.role))
    return fail(at("role"), "Audio must be a voiceover or music.")
  if (!(AUDIO_CONTAINERS as readonly unknown[]).includes(a.container))
    return fail(at("container"), "Unsupported audio format.")
  if (typeof a.codec !== "string" || !/^[a-z0-9_]{1,32}$/.test(a.codec))
    return fail(at("codec"), "Unknown audio codec.")
  if (typeof a.displayName !== "string")
    return fail(at("displayName"), "Audio name must be text.")
  if (!isPositiveInteger(a.sizeBytes) || a.sizeBytes > AUDIO_LIMITS.maxBytes)
    return fail(at("sizeBytes"), "Audio file size is out of range.")
  if (
    typeof a.durationSeconds !== "number" ||
    typeof a.sampleRate !== "number" ||
    typeof a.channels !== "number"
  )
    return fail(at("durationSeconds"), "Audio details are missing.")
  const role = a.role as AudioRole
  const problem = checkAudioFacts(
    {
      durationSeconds: a.durationSeconds,
      sampleRate: a.sampleRate,
      channels: a.channels,
    },
    role,
    sanitizeDisplayName(a.displayName),
  )
  if (problem) return fail(at("durationSeconds"), problem)
  return {
    ok: true,
    value: {
      id: a.id,
      kind: "audio",
      role,
      container: a.container as AudioContainer,
      codec: a.codec,
      sizeBytes: a.sizeBytes,
      durationSeconds: a.durationSeconds,
      sampleRate: a.sampleRate,
      channels: a.channels as 1 | 2,
      displayName: sanitizeDisplayName(a.displayName),
    },
  }
}

/** Which audio roles each mode needs. */
export const MODE_NEEDS: Record<
  AudioMode,
  { voiceover: boolean; music: boolean }
> = {
  none: { voiceover: false, music: false },
  voiceover: { voiceover: true, music: false },
  music: { voiceover: false, music: true },
  "voiceover-and-music": { voiceover: true, music: true },
}

const AUDIO_CONFIG_KEYS = [
  "mode",
  "voiceoverAssetId",
  "musicAssetId",
  "musicLevel",
] as const

/**
 * Validates the audio choices against the job's uploaded audio files: the
 * mode decides which files are required (and forbids the others), and every
 * ID must be an uploaded file of the matching role.
 */
export function validateAudioConfig(
  input: unknown,
  audioAssets: readonly AudioAsset[],
  basePath = "audio",
): Validation<AudioConfig> {
  const object = readStrictObject(
    input,
    AUDIO_CONFIG_KEYS,
    basePath,
    "Audio settings",
  )
  if (!object.ok) return object
  const { mode, voiceoverAssetId, musicAssetId, musicLevel } = object.value
  const at = (key: string) => join(basePath, key)
  if (!(AUDIO_MODES as readonly unknown[]).includes(mode))
    return fail(at("mode"), "Choose an audio option.")
  if (!(MUSIC_LEVELS as readonly unknown[]).includes(musicLevel))
    return fail(at("musicLevel"), "Choose a music level: low, medium or high.")
  const needs = MODE_NEEDS[mode as AudioMode]
  const issues: ValidationIssue[] = []
  const check = (
    role: AudioRole,
    id: unknown,
    needed: boolean,
    key: string,
  ) => {
    if (!needed) {
      if (id !== null && id !== undefined)
        issues.push({
          path: at(key),
          message: `${ROLE_LABEL[role]} isn't used with this audio option.`,
        })
      return
    }
    if (!isAssetId(id))
      return issues.push({
        path: at(key),
        message: `Add a ${ROLE_LABEL[role].toLowerCase()} file.`,
      })
    const asset = audioAssets.find((a) => a.id === id)
    if (!asset)
      return issues.push({
        path: at(key),
        message: `That ${ROLE_LABEL[role].toLowerCase()} file wasn't uploaded to this video.`,
      })
    if (asset.role !== role)
      issues.push({
        path: at(key),
        message: `That file was uploaded as ${ROLE_LABEL[asset.role].toLowerCase()}, not ${ROLE_LABEL[role].toLowerCase()}.`,
      })
  }
  check("voiceover", voiceoverAssetId, needs.voiceover, "voiceoverAssetId")
  check("music", musicAssetId, needs.music, "musicAssetId")
  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    value: {
      mode: mode as AudioMode,
      voiceoverAssetId: needs.voiceover ? (voiceoverAssetId as AssetId) : null,
      musicAssetId: needs.music ? (musicAssetId as AssetId) : null,
      musicLevel: musicLevel as MusicLevel,
    },
  }
}

/** Rejects narration longer than the video (plus the small tolerance). */
export function validateVoiceoverFits(
  voiceoverSeconds: number,
  videoFrames: number,
  path = "audio.voiceoverAssetId",
): Validation<number> {
  const videoSeconds = videoFrames / VIDEO_FORMAT.fps
  if (voiceoverSeconds > videoSeconds + VOICEOVER_TOLERANCE_SECONDS)
    return fail(
      path,
      `The voiceover is ${voiceoverSeconds.toFixed(1)} s but the video is ${videoSeconds.toFixed(1)} s. Shorten the narration, or add benefit scenes to lengthen the video (each adds about 4 s).`,
    )
  return { ok: true, value: voiceoverSeconds }
}

// ---------------------------------------------------------------------------
// Settings & project
// ---------------------------------------------------------------------------

const SETTINGS_KEYS = Object.keys(
  DEFAULT_VIDEO_SETTINGS,
) as (keyof VideoSettings)[]

/**
 * Settings are fixed: every value must equal DEFAULT_VIDEO_SETTINGS, except
 * `audio`, which is "none" (silent) or "aac" (the fixed AUDIO_OUTPUT format).
 * Anything else (another size, codec, or an extra key such as "ffmpegArgs")
 * is rejected rather than silently ignored.
 */
export function validateVideoSettings(
  input: unknown,
  basePath = "settings",
): Validation<VideoSettings> {
  const object = readStrictObject(
    input,
    SETTINGS_KEYS,
    basePath,
    "Video settings",
  )
  if (!object.ok) return object
  const issues: ValidationIssue[] = []
  for (const key of SETTINGS_KEYS) {
    if (key === "audio") {
      if (object.value.audio !== "none" && object.value.audio !== "aac")
        issues.push({
          path: join(basePath, key),
          message:
            'Video settings are fixed in this version: audio must be "none" or "aac".',
        })
      continue
    }
    if (object.value[key] !== DEFAULT_VIDEO_SETTINGS[key])
      issues.push({
        path: join(basePath, key),
        message: `Video settings are fixed in this version: ${key} must be ${String(DEFAULT_VIDEO_SETTINGS[key])}.`,
      })
  }
  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    value: {
      ...DEFAULT_VIDEO_SETTINGS,
      audio: object.value.audio as VideoSettings["audio"],
    },
  }
}

const PROJECT_KEYS = [
  "product",
  "assets",
  "scenes",
  "settings",
  // Optional (DV-003C); absent in silent DV-003B projects.
  "audio",
  "audioAssets",
] as const

export function validateVideoProject(input: unknown): Validation<VideoProject> {
  const object = readStrictObject(input, PROJECT_KEYS, "", "Project")
  if (!object.ok) return object
  const issues: ValidationIssue[] = []

  const product = validateProduct(object.value.product, "product")
  if (!product.ok) issues.push(...product.issues)

  const assets: MediaAsset[] = []
  const rawAssets = object.value.assets
  if (!Array.isArray(rawAssets)) {
    issues.push({ path: "assets", message: "Images must be a list." })
  } else if (
    rawAssets.length < MEDIA_LIMITS.minCount ||
    rawAssets.length > MEDIA_LIMITS.maxCount
  ) {
    issues.push({
      path: "assets",
      message: `Add ${MEDIA_LIMITS.minCount}–${MEDIA_LIMITS.maxCount} product images.`,
    })
  } else {
    rawAssets.forEach((raw, index) => {
      const asset = validateMediaAsset(raw, `assets.${index}`)
      if (!asset.ok) return issues.push(...asset.issues)
      if (assets.some((a) => a.id === asset.value.id))
        return issues.push({
          path: `assets.${index}.id`,
          message: "Duplicate image.",
        })
      assets.push(asset.value)
    })
  }

  const scenes = validateScenes(
    object.value.scenes,
    new Set(assets.map((asset) => asset.id)),
  )
  if (!scenes.ok) issues.push(...scenes.issues)

  const settings = validateVideoSettings(object.value.settings)
  if (!settings.ok) issues.push(...settings.issues)

  // Audio: both fields absent (silent, as in DV-003B) or both present.
  const audioAssets: AudioAsset[] = []
  let audio: AudioConfig | undefined
  const rawAudio = object.value.audio
  const rawAudioAssets = object.value.audioAssets
  if (rawAudio === undefined && rawAudioAssets === undefined) {
    if (settings.ok && settings.value.audio !== "none")
      issues.push({
        path: "settings.audio",
        message: "A silent project can't use audio settings.",
      })
  } else if (!Array.isArray(rawAudioAssets) || rawAudioAssets.length > 2) {
    issues.push({
      path: "audioAssets",
      message: "Audio files must be a list of at most two.",
    })
  } else {
    rawAudioAssets.forEach((raw, index) => {
      const asset = validateAudioAsset(raw, `audioAssets.${index}`)
      if (!asset.ok) return issues.push(...asset.issues)
      if (
        audioAssets.some(
          (a) => a.id === asset.value.id || a.role === asset.value.role,
        )
      )
        return issues.push({
          path: `audioAssets.${index}`,
          message: "Duplicate audio file.",
        })
      audioAssets.push(asset.value)
    })
    const config = validateAudioConfig(rawAudio, audioAssets)
    if (!config.ok) issues.push(...config.issues)
    else {
      audio = config.value
      const used = [audio.voiceoverAssetId, audio.musicAssetId].filter(Boolean)
      if (audioAssets.some((a) => !used.includes(a.id)))
        issues.push({
          path: "audioAssets",
          message: "The project lists an audio file it doesn't use.",
        })
      if (
        settings.ok &&
        settings.value.audio !== (audio.mode === "none" ? "none" : "aac")
      )
        issues.push({
          path: "settings.audio",
          message: "Audio settings don't match the audio option.",
        })
      const voiceover = audioAssets.find(
        (a) => a.id === audio!.voiceoverAssetId,
      )
      if (voiceover && scenes.ok) {
        const fits = validateVoiceoverFits(
          voiceover.durationSeconds,
          scenes.value.reduce((n, scene) => n + scene.durationFrames, 0),
        )
        if (!fits.ok) issues.push(...fits.issues)
      }
    }
  }

  if (!product.ok || !scenes.ok || !settings.ok || issues.length > 0)
    return { ok: false, issues }
  return {
    ok: true,
    value: {
      product: product.value,
      assets,
      scenes: scenes.value,
      settings: settings.value,
      ...(audio ? { audio, audioAssets } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(
  path: string,
  message: string,
): { ok: false; issues: ValidationIssue[] } {
  return { ok: false, issues: [{ path, message }] }
}

function join(base: string, key: string) {
  return base ? `${base}.${key}` : key
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Accepts only a plain object whose keys are all in `keys` (missing keys read as undefined). */
function readStrictObject<K extends string>(
  input: unknown,
  keys: readonly K[],
  path: string,
  label: string,
): Validation<Record<K, unknown>> {
  if (!isPlainObject(input))
    return fail(path || label.toLowerCase(), `${label} must be an object.`)
  const unknownKeys = Object.keys(input).filter(
    (key) => !(keys as readonly string[]).includes(key),
  )
  if (unknownKeys.length > 0)
    return {
      ok: false,
      issues: unknownKeys.map((key) => ({
        path: join(path, key),
        message: `“${key}” isn't an accepted field.`,
      })),
    }
  const value = {} as Record<K, unknown>
  for (const key of keys)
    value[key] = Object.hasOwn(input, key) ? input[key] : undefined
  return { ok: true, value }
}
