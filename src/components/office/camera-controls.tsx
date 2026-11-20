"use client"

import { RotateCcw, RotateCw, Undo2, ZoomIn, ZoomOut } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import type { CameraApi } from "./scene/camera-rig"

/**
 * Button alternative to drag/scroll camera gestures. Rotation is hidden on
 * small screens to keep mobile controls simple (touch can still rotate).
 */
export function CameraControls({
  camera,
  className,
}: {
  camera: React.RefObject<CameraApi | null>
  className?: string
}) {
  return (
    <div
      role="toolbar"
      aria-label="Camera"
      className={cn(
        "flex items-center gap-1 rounded-xl bg-surface/90 p-1 shadow-raised ring-1 ring-border backdrop-blur",
        className,
      )}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Rotate left"
        className="hidden sm:inline-flex"
        onClick={() => camera.current?.rotate(-1)}
      >
        <RotateCcw aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Rotate right"
        className="hidden sm:inline-flex"
        onClick={() => camera.current?.rotate(1)}
      >
        <RotateCw aria-hidden="true" />
      </Button>
      <span
        aria-hidden="true"
        className="mx-0.5 hidden h-5 w-px bg-border sm:block"
      />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Zoom in"
        onClick={() => camera.current?.zoom(1)}
      >
        <ZoomIn aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Zoom out"
        onClick={() => camera.current?.zoom(-1)}
      >
        <ZoomOut aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="sm" onClick={() => camera.current?.reset()}>
        <Undo2 aria-hidden="true" />
        <span className="sr-only sm:not-sr-only">Reset view</span>
      </Button>
    </div>
  )
}
