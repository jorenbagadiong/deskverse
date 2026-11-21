"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import type { StudioImage } from "@/components/studio/pixel/image-picker"
import {
  assetsEndpoint,
  FILE_NAME_HEADER,
  jobEndpoint,
  JOBS_ENDPOINT,
  renderEndpoint,
  type ApiError,
  type RenderJobStatus,
  type RenderRequest,
  type UploadedAsset,
} from "@/lib/video/render-api"
import type { ProductInfo } from "@/lib/video/types"

export type RenderView =
  | { kind: "idle" }
  | { kind: "uploading"; uploaded: number; total: number }
  | { kind: "starting" }
  | { kind: "tracking"; status: RenderJobStatus }
  | { kind: "error"; message: string }

const POLL_MS = 1000

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
    async (product: ProductInfo, images: readonly StudioImage[]) => {
      const run = ++generation.current
      const live = () => generation.current === run
      try {
        setView({ kind: "uploading", uploaded: 0, total: images.length })
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
          })
        }

        if (!live()) return
        setView({ kind: "starting" })
        const request: RenderRequest = { product, assetIds }
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

  return { view, start, busy }
}
