import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { RenderPanel } from "@/components/studio/pixel/render-panel"
import type {
  FailureStage,
  RenderView,
} from "@/components/studio/pixel/use-render-job"

/**
 * The render panel's failure alert names the step that failed: an upload the
 * server rejected isn't reported as a failed render. (Rendered to static
 * markup: the E2E fixture fails on any console error, and browsers log every
 * 4xx upload rejection as one.)
 */
function alertFor(view: RenderView) {
  const html = renderToStaticMarkup(
    createElement(RenderPanel, {
      requirements: [],
      canRender: true,
      busy: false,
      view,
      onRender: () => {},
    }),
  )
  const alert = /<div role="alert"[^>]*>([\s\S]*?)<\/div>/.exec(html)
  return alert
    ? alert[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .trim()
    : null
}

const MESSAGE =
  "“ph-11134207-7r98s-lybwn743fz3u15.webp” couldn't be verified: it doesn't decode cleanly (the file may be damaged)."

describe("render panel failure titles", () => {
  it("reports a rejected image as an image upload failure, with the server's reason", () => {
    expect(
      alertFor({ kind: "error", stage: "image-upload", message: MESSAGE }),
    ).toBe(`Image upload failed. ${MESSAGE}`)
  })

  it.each([
    ["audio-upload", "Audio upload failed."],
    ["start", "The render couldn't start."],
    ["render", "Render failed."],
    ["cancel", "Cancelling failed."],
  ] as [FailureStage, string][])("titles a %s failure “%s”", (stage, title) => {
    expect(alertFor({ kind: "error", stage, message: "Reason." })).toBe(
      `${title} Reason.`,
    )
  })

  it("keeps “Render failed.” for a job the server marked failed", () => {
    expect(
      alertFor({
        kind: "tracking",
        status: {
          jobId: `job_${"a".repeat(32)}` as never,
          state: "failed",
          progress: null,
          error: {
            code: "render-failed",
            message: "The libx264 encoder failed while encoding the video.",
          },
          output: null,
          videoUrl: null,
          downloadUrl: null,
        },
      }),
    ).toBe(
      "Render failed. The libx264 encoder failed while encoding the video.",
    )
  })

  it("shows no alert while idle", () => {
    expect(alertFor({ kind: "idle" })).toBeNull()
  })
})
