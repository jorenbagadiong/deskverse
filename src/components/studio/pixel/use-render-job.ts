"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import type {
  StudioAudio,
  StudioAudioFile,
} from "@/components/studio/pixel/audio-section"
import type { StudioImage } from "@/components/studio/pixel/image-picker"
import {
  assetsEndpoint,
  audioEndpoint,
  cancelEndpoint,
  FILE_NAME_HEADER,
  jobEndpoint,
  JOBS_ENDPOINT,
  renderEndpoint,
  type ApiError,
  type RenderJobStatus,
  type RenderRequest,
  type UploadedAsset,
  type UploadedAudio,
} from "@/lib/video/render-api"
import type { AudioRole, ProductInfo } from "@/lib/video/types"
import { MODE_NEEDS } from "@/lib/video/validation"

export type RenderView =
  | { kind: "idle" }
  | {
      kind: "uploading"
      uploaded: number
      total: number
      what: "images" | "audio"
    }
  | { kind: "starting" }
  | { kind: "tracking"; status: RenderJobStatus }
  | { kind: "error"; message: string }

const POLL_MS = 1000

/** Browsers sometimes report no type for audio; send a standard one by container. */
const AUDIO_TYPE: Record<StudioAudioFile["container"], string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
}

class ApiFailure extends Error {}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { cache: "no-store", ...init })
  } catch {
    throw new ApiFailure(
      "The Deskverse server didn't respond. Is it still running?",
    )
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      typeof body === "object" && body && "message" in body
        ? String((body as ApiError).message)
        : `The server answered with status ${response.status}.`
    throw new ApiFailure(message)
  }
  return body as T
}

/**
 * Drives one render: create a job, upload each original image File, ask the
 * server to render, then poll the job's real status. Nothing here invents
 * progress; it shows what the server reports.
 */
export function useRenderJob() {
  const [view, setView] = useState<RenderView>({ kind: "idle" })
  // Bumped on unmount or a new start, which stops any older polling loop.
  const generation = useRef(0)

  useEffect(() => {
    const current = generation
    return () => {
      current.current++
    }
  }, [])

  const start = useCallback(
    async (
      product: ProductInfo,
      images: readonly StudioImage[],
      audio?: StudioAudio,
    ) => {
      const run = ++generation.current
      const live = () => generation.current === run
      try {
        setView({
          kind: "uploading",
          uploaded: 0,
          total: images.length,
          what: "images",
        })
        const { jobId } = await call<{ jobId: string }>(JOBS_ENDPOINT, {
          method: "POST",
        })

        const assetIds: RenderRequest["assetIds"] = []
        for (const [index, image] of images.entries()) {
          if (!live()) return
          const { asset } = await call<{ asset: UploadedAsset }>(
            assetsEndpoint(jobId),
            {
              method: "POST",
              headers: {
                "Content-Type": image.file.type,
                [FILE_NAME_HEADER]: encodeURIComponent(image.file.name),
              },
              body: image.file,
            },
          )
          assetIds.push(asset.id)
          setView({
            kind: "uploading",
            uploaded: index + 1,
            total: images.length,
            what: "images",
          })
        }

        // Audio (DV-003C): the original files, one request per role.
        const needs = audio ? MODE_NEEDS[audio.mode] : null
        const files = (
          [
            ["voiceover", needs?.voiceover ? audio?.voiceover : null],
            ["music", needs?.music ? audio?.music : null],
          ] as [AudioRole, StudioAudioFile | null | undefined][]
        ).filter((entry): entry is [AudioRole, StudioAudioFile] => !!entry[1])
        const audioIds: Partial<Record<AudioRole, UploadedAudio["id"]>> = {}
        for (const [index, [role, file]] of files.entries()) {
          if (!live()) return
          setView({
            kind: "uploading",
            uploaded: index,
            total: files.length,
            what: "audio",
          })
          const { audio: uploaded } = await call<{ audio: UploadedAudio }>(
            audioEndpoint(jobId, role),
            {
              method: "POST",
              headers: {
                "Content-Type": file.file.type || AUDIO_TYPE[file.container],
                [FILE_NAME_HEADER]: encodeURIComponent(file.file.name),
              },
              body: file.file,
            },
          )
          audioIds[role] = uploaded.id
        }

        if (!live()) return
        setView({ kind: "starting" })
        const request: RenderRequest = {
          product,
          assetIds,
          ...(audio && audio.mode !== "none"
            ? {
                audio: {
                  mode: audio.mode,
                  voiceoverAssetId: audioIds.voiceover ?? null,
                  musicAssetId: audioIds.music ?? null,
                  musicLevel: audio.musicLevel,
                },
              }
            : {}),
        }
        let status = await call<RenderJobStatus>(renderEndpoint(jobId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        })

        let failures = 0
        while (live()) {
          setView({ kind: "tracking", status })
          if (status.state !== "queued" && status.state !== "rendering") return
          await new Promise((resolve) => setTimeout(resolve, POLL_MS))
          if (!live()) return
          try {
            status = await call<RenderJobStatus>(jobEndpoint(jobId))
            failures = 0
          } catch (error) {
            // Tolerate a brief hiccup; give up after several in a row.
            if (++failures >= 5) throw error
          }
        }
      } catch (error) {
        if (live())
          setView({
            kind: "error",
            message:
              error instanceof ApiFailure
                ? error.message
                : "Rendering couldn't start. Try again.",
          })
      }
    },
    [],
  )

  const busy =
    view.kind === "uploading" ||
    view.kind === "starting" ||
    (view.kind === "tracking" &&
      (view.status.state === "queued" || view.status.state === "rendering"))

  const activeJobId =
    view.kind === "tracking" &&
    (view.status.state === "queued" || view.status.state === "rendering")
      ? view.status.jobId
      : null

  /** Cancels the tracked render; the poll loop then sees its final state. */
  const cancel = useCallback(async () => {
    if (!activeJobId) return
    try {
      await call(cancelEndpoint(activeJobId), { method: "POST" })
    } catch (error) {
      setView({
        kind: "error",
        message:
          error instanceof ApiFailure
            ? error.message
            : "The render couldn't be cancelled. Try again.",
      })
    }
  }, [activeJobId])

  return { view, start, busy, cancel, canCancel: activeJobId !== null }
}
