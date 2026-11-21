import "server-only"

import { narrationWindow, samplesToSeconds } from "@/lib/video/audio-timing"
import { STATIC_EFFECTS } from "@/lib/video/effects"
import { VIDEO_FORMAT } from "@/lib/video/format"
import {
  videoEndpoint,
  type JobSummary,
  type NarrationSummary,
  type StorageSummary,
} from "@/lib/video/render-api"
import type { RenderProgress } from "@/lib/video/render-job"
import type { VideoProject } from "@/lib/video/types"
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
    effects: project ? (project.effects ?? STATIC_EFFECTS) : null,
    narration: project ? narrationSummary(project) : null,
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

/**
 * Where the voiceover plays in a server-built project (DV-003D3): the saved
 * timing resolved against the recording's FFprobe duration, exactly as the
 * renderer will use it. Null without a voiceover.
 */
export function narrationSummary(
  project: VideoProject,
): NarrationSummary | null {
  const id = project.audio?.voiceoverAssetId
  const recording = id
    ? project.audioAssets?.find((a) => a.id === id)
    : undefined
  if (!project.audio || !recording) return null
  const frames = project.scenes.reduce((n, s) => n + s.durationFrames, 0)
  const w = narrationWindow(
    project.audio.voiceoverTiming,
    recording.durationSeconds,
    frames,
  )
  return {
    startSeconds: samplesToSeconds(w.startSample),
    endSeconds: samplesToSeconds(w.endSample),
    trimStartSeconds: samplesToSeconds(w.trimStartSample),
    trimEndSeconds: samplesToSeconds(w.trimEndSample),
    videoSeconds: frames / VIDEO_FORMAT.fps,
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
