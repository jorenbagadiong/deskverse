import "server-only"

import {
  videoEndpoint,
  type JobSummary,
  type StorageSummary,
} from "@/lib/video/render-api"
import type { RenderProgress } from "@/lib/video/render-job"
import type { JobRecord, StorageUsage } from "@/server/video/storage"

/**
 * One history row. Only facts the user needs: no paths, no stored asset
 * metadata, and actions decided here from the job's actual state.
 */
export function jobSummary(
  { job, project }: JobRecord,
  progress: RenderProgress | null,
): JobSummary {
  const active = job.state === "queued" || job.state === "rendering"
  const done = job.state === "completed" && job.output !== null
  return {
    jobId: job.id,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    productName: project?.product.name ?? null,
    audioMode: project ? (project.audio?.mode ?? "none") : null,
    imageCount: project?.assets.length ?? job.assets.length,
    durationSeconds: done ? job.output!.durationSeconds : null,
    sizeBytes: done ? job.output!.sizeBytes : null,
    error: job.state === "failed" ? job.error : null,
    progress: active ? progress : null,
    videoUrl: done ? videoEndpoint(job.id) : null,
    downloadUrl: done ? videoEndpoint(job.id, true) : null,
    actions: {
      cancel: active,
      retry: job.state === "failed",
      delete: !active,
      preview: done,
    },
  }
}

export function storageSummary(usage: StorageUsage): StorageSummary {
  return {
    totalBytes: usage.totalBytes,
    uploadBytes: usage.uploadBytes,
    outputBytes: usage.outputBytes,
    workBytes: usage.workBytes,
    otherBytes: usage.otherBytes,
    jobs: usage.jobs,
    completed: usage.byState.completed,
    failed: usage.byState.failed,
    interrupted: usage.interrupted,
    cancelled: usage.byState.cancelled,
    drafts: usage.byState.draft,
    active: usage.byState.queued + usage.byState.rendering,
    unreadable: usage.unreadable,
  }
}
