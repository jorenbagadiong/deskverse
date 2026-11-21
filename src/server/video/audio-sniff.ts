import "server-only"

import type { AudioContainer } from "@/lib/video/types"

/**
 * Identifies audio containers by their bytes, never by the name or MIME type
 * a browser reports. Only MP3, WAV and M4A are recognised. FFprobe then
 * confirms the container, codec, streams and duration.
 */

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

/** ISO base media brands used for audio-only MP4 files. */
const M4A_BRANDS = new Set([
  "M4A ",
  "M4B ",
  "mp42",
  "mp41",
  "isom",
  "iso2",
  "dash",
])

/** An MPEG-1/2 Layer III frame header: 11-bit sync, valid version/layer/bitrate/rate. */
function isMp3FrameHeader(b: Uint8Array, i: number) {
  if (i + 4 > b.length) return false
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return false
  const version = (b[i + 1] >> 3) & 0b11 // 01 is reserved
  const layer = (b[i + 1] >> 1) & 0b11 // 01 = Layer III
  const bitrate = b[i + 2] >> 4 // 0000 free, 1111 bad
  const rate = (b[i + 2] >> 2) & 0b11 // 11 reserved
  return (
    version !== 0b01 &&
    layer === 0b01 &&
    bitrate !== 0 &&
    bitrate !== 0b1111 &&
    rate !== 0b11
  )
}

export function sniffAudioContainer(bytes: Uint8Array): AudioContainer | null {
  if (bytes.length < 12) return null
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE")
    return "wav"
  if (ascii(bytes, 4, 4) === "ftyp" && M4A_BRANDS.has(ascii(bytes, 8, 4)))
    return "m4a"
  if (ascii(bytes, 0, 3) === "ID3") {
    // ID3v2 tag: 10-byte header + syncsafe size, then the first MPEG frame.
    if (bytes.length < 10) return null
    const size =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f)
    const footer = bytes[5] & 0x10 ? 10 : 0
    const frame = 10 + size + footer
    // Some encoders pad after the tag; scan a little for the first frame.
    for (let i = frame; i < Math.min(frame + 4096, bytes.length - 4); i++)
      if (isMp3FrameHeader(bytes, i)) return "mp3"
    return null
  }
  if (isMp3FrameHeader(bytes, 0)) return "mp3"
  return null
}

/** File extension used for stored audio (the name the server chooses). */
export const AUDIO_FILE_EXTENSION: Record<AudioContainer, string> = {
  mp3: "mp3",
  wav: "wav",
  m4a: "m4a",
}
