"use client"

import { useReducer, useRef, useState } from "react"
import dynamic from "next/dynamic"
import { useTheme } from "next-themes"
import { Box, LoaderCircle, Map as MapIcon } from "lucide-react"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { ViewMode } from "@/config/office"
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion"
import { useWebGLSupport } from "@/hooks/use-webgl-support"
import {
  createInitialOfficeState,
  officeReducer,
} from "@/lib/office-simulation"

import { ActivityFeed } from "./activity-feed"
import { CameraControls } from "./camera-controls"
import { EmployeeDetails } from "./employee-details"
import { EmployeeList } from "./employee-list"
import { FloorSwitcher } from "./floor-switcher"
import { OfficeMap } from "./office-map"
import { SceneErrorBoundary } from "./scene-error-boundary"
import type { CameraApi } from "./scene/camera-rig"
import { SimulatedTag } from "./simulated-tag"

// three.js + R3F live in their own chunk, loaded only in the browser.
const OfficeScene = dynamic(() => import("./scene/office-scene"), {
  ssr: false,
  loading: () => <SceneLoading />,
})

type Display = "3d" | "2d"

export function OfficeExperience() {
  const [state, dispatch] = useReducer(
    officeReducer,
    undefined,
    createInitialOfficeState,
  )
  const [display, setDisplay] = useState<Display>("3d")
  const camera = useRef<CameraApi>(null)
  const webgl = useWebGLSupport()
  const reducedMotion = usePrefersReducedMotion()
  const { resolvedTheme } = useTheme()

  const select = (id: typeof state.selectedId) =>
    dispatch({ type: "select", id })
  const setView = (view: ViewMode) => dispatch({ type: "setView", view })
  const selectedStatus = state.selectedId
    ? state.statuses[state.selectedId]
    : null
  const show3d = display === "3d" && webgl === true

  const map = (notice?: string) => (
    <OfficeMap
      statuses={state.statuses}
      selectedId={state.selectedId}
      onSelect={select}
      notice={notice}
    />
  )

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_23rem]">
      <section
        aria-label="Office view"
        aria-describedby="office-view-help"
        className="relative h-[min(68vh,28rem)] overflow-hidden rounded-2xl bg-[radial-gradient(ellipse_at_top,var(--surface-raised),var(--background)_75%)] ring-1 ring-border sm:h-136 lg:h-168"
      >
        <p id="office-view-help" className="sr-only">
          {show3d
            ? "Interactive 3D office with two floors. Drag to rotate and scroll or pinch to zoom. Use the floor buttons to switch floors. Every action is also available from the employee list and detail panel."
            : "2D floor plan of both office floors with one button per employee."}
        </p>

        {webgl === null ? (
          <SceneLoading />
        ) : show3d ? (
          <SceneErrorBoundary
            fallback={map(
              "The 3D view couldn't start on this device, so here's the 2D floor plan.",
            )}
          >
            <OfficeScene
              statuses={state.statuses}
              selectedId={state.selectedId}
              onSelect={select}
              view={state.view}
              theme={resolvedTheme === "light" ? "light" : "dark"}
              reducedMotion={reducedMotion}
              cameraRef={camera}
            />
          </SceneErrorBoundary>
        ) : (
          map(
            webgl === false
              ? "Your browser or device doesn't support WebGL, so the office is shown as a 2D floor plan."
              : undefined,
          )
        )}

        {/* Overlays: kept to the edges so they never cover the robots */}
        <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-2">
          <SimulatedTag className="pointer-events-auto bg-surface/90 backdrop-blur" />
          {webgl ? (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={0}
              aria-label="Office display"
              value={display}
              onValueChange={(value) => {
                if (value) setDisplay(value as Display)
              }}
              className="pointer-events-auto bg-surface/90 backdrop-blur"
            >
              <ToggleGroupItem
                value="3d"
                className="data-[state=on]:text-primary"
              >
                <Box aria-hidden="true" />
                3D
              </ToggleGroupItem>
              <ToggleGroupItem
                value="2d"
                className="data-[state=on]:text-primary"
              >
                <MapIcon aria-hidden="true" />
                2D map
              </ToggleGroupItem>
            </ToggleGroup>
          ) : null}
        </div>
        {show3d ? (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-end justify-between gap-2">
            <CameraControls camera={camera} className="pointer-events-auto" />
            <FloorSwitcher
              view={state.view}
              onChange={setView}
              className="pointer-events-auto"
            />
          </div>
        ) : null}
      </section>

      <aside aria-label="Employees" className="flex min-w-0 flex-col gap-4">
        <EmployeeList
          statuses={state.statuses}
          selectedId={state.selectedId}
          onSelect={select}
        />
        <EmployeeDetails
          selectedId={state.selectedId}
          status={selectedStatus}
          onSetStatus={(status) => {
            if (state.selectedId)
              dispatch({ type: "setStatus", id: state.selectedId, status })
          }}
          onClose={() => select(null)}
        />
        <ActivityFeed entries={state.activity} />
      </aside>
    </div>
  )
}

function SceneLoading() {
  return (
    <div className="grid h-full place-items-center text-sm text-muted-foreground">
      <span className="inline-flex items-center gap-2">
        <LoaderCircle
          aria-hidden="true"
          className="size-4 animate-spin motion-reduce:animate-none"
        />
        Loading the office…
      </span>
    </div>
  )
}
