import type pg from "pg"
import type { TaskHandler } from "@/server/orchestrator/workflows"
import { reviewVideo } from "./engine"
import { persistReview } from "./store"

export function createVeraHandler(options: {
  pool: pg.Pool
  dataRoot: string
  commands: { ffmpeg: string; ffprobe: string }
  beforeCommit?: () => void
}): TaskHandler {
  return {
    stage: "vera.review",
    kind: "production",
    async run(ctx) {
      const document = await reviewVideo(options.pool, ctx, options)
      return {
        status: "completed",
        result: { kind: "vera_review" },
        deliverable: {
          kind: "vera_review",
          persist: (c, commit) =>
            persistReview(c, commit, document, options.beforeCommit),
        },
      }
    },
  }
}
