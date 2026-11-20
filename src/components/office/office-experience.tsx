"use client"

import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import dynamic from "next/dynamic"
import { useTheme } from "next-themes"
import {
  Box,
  LoaderCircle,
  Map as MapIcon,
  Maximize,
  Minimize,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  getOfficeEmployee,
  type FloorId,
  type OfficeEmployeeId,
  type ViewMode,
} from "@/config/office"
import { useFullscreen } from "@/hooks/use-fullscreen"
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion"
import { useWebGLSupport } from "@/hooks/use-webgl-support"
import {
  createLiveStore,
  liveLocation,
  type LiveStore,
} from "@/lib/office-live"
import {
  floorOf,
  locationLabel,
  movementOptions,
  type DestinationOption,
} from "@/lib/office-movement"
import {
  createInitialOfficeState,
  officeReducer,
} from "@/lib/office-simulation"
import { cn } from "@/lib/utils"

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

/** How often optional ambient wandering considers sending someone on a break. */
export const WANDER_INTERVAL_MS = 7000

export function OfficeExperience() {
  const [state, dispatch] = useReducer(
    officeReducer,
    undefined,
    createInitialOfficeState,
  )
  // Live, per-frame positions written by the 3D scene (a mutable Map, not React state).
  const [live] = useState<React.RefObject<LiveStore>>(() => ({
    current: createLiveStore(createInitialOfficeState().movement),
  }))
  const [display, setDisplay] = useState<Display>("3d")
  const camera = useRef<CameraApi>(null)
  const viewport = useRef<HTMLElement>(null)
  const fullscreen = useFullscreen(viewport)
  const webgl = useWebGLSupport()
  const reducedMotion = usePrefersReducedMotion()
  const { resolvedTheme } = useTheme()
  const show3d = display === "3d" && webgl === true

  /** Where someone is right now: the scene's live reading, else the reducer's. */
  const floorNow = (id: OfficeEmployeeId): FloorId =>
    (show3d ? live.current.get(id)?.floor : undefined) ??
    floorOf(state.movement[id])
  const from = (id: OfficeEmployeeId) =>
    show3d ? liveLocation(live.current, id) : undefined

  const select = (id: OfficeEmployeeId | null) =>
    dispatch({ type: "select", id, floor: id ? floorNow(id) : undefined })
  const setView = (view: ViewMode) =>
    dispatch({
      type: "setView",
      view,
      selectedFloor: state.selectedId ? floorNow(state.selectedId) : undefined,
    })

  // Without the 3D scene nothing animates walks, so every move is instant.
  const instant = reducedMotion || !show3d
  const move = (id: OfficeEmployeeId, option: DestinationOption["kind"]) => {
    if (option === "stop") {
      const at = from(id)
      if (at) dispatch({ type: "stop", id, at })
      return
    }
    dispatch({ type: "goTo", id, destination: option, from: from(id), instant })
  }

  const onArrive = useCallback(
    (id: OfficeEmployeeId, routeId: number) =>
      dispatch({ type: "arrive", id, routeId }),
    [],
  )
  const onFloorChange = useCallback(
    (id: OfficeEmployeeId, floor: FloorId) =>
      dispatch({ type: "followFloor", id, floor }),
    [],
  )

  // Optional ambient wandering: idle colleagues take short breaks on their own.
  useEffect(() => {
    if (!state.wander) return
    const timer = window.setInterval(
      () => dispatch({ type: "ambientTick", instant }),
      WANDER_INTERVAL_MS,
    )
    return () => window.clearInterval(timer)
  }, [state.wander, instant])

  const selectedId = state.selectedId
  const selectedStatus = selectedId ? state.statuses[selectedId] : null

  const map = (notice?: string) => (
    <OfficeMap
      statuses={state.statuses}
      movement={state.movement}
      selectedId={selectedId}
      onSelect={select}
      notice={notice}
    />
  )

  return (
    <div className="flex flex-col gap-4">
      <section
        ref={viewport}
        aria-label="Office view"
        aria-describedby="office-view-help"
        data-fullscreen={fullscreen.active ? "" : undefined}
        className={cn(
          "relative w-full overflow-hidden bg-[radial-gradient(ellipse_at_top,var(--surface-raised),var(--background)_75%)]",
          fullscreen.active
            ? "h-dvh"
            : "h-[clamp(22rem,78dvh,56rem)] rounded-2xl ring-1 ring-border",
        )}
      >
        <p id="office-view-help" className="sr-only">
          {show3d
            ? "Interactive 3D office with two floors. Drag to rotate all the way around and scroll or pinch to zoom. Use the floor buttons to switch floors. Every action is also available from the employee list and detail panel below."
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
              selectedId={selectedId}
              onSelect={select}
              view={state.view}
              theme={resolvedTheme === "light" ? "light" : "dark"}
              reducedMotion={reducedMotion}
              cameraRef={camera}
              movement={state.movement}
              live={live}
              onArrive={onArrive}
              onFloorChange={onFloorChange}
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
          <div className="flex min-w-0 flex-col items-start gap-2">
            <SimulatedTag className="pointer-events-auto bg-surface/90 backdrop-blur" />
            {fullscreen.active && selectedId ? (
              <p className="pointer-events-auto max-w-full truncate rounded-lg bg-surface/90 px-2.5 py-1 text-xs ring-1 ring-border backdrop-blur">
                <span className="font-semibold">
                  {getOfficeEmployee(selectedId).name}
                </span>{" "}
                <span className="text-muted-foreground">
                  · {locationLabel(state.movement[selectedId])}
                </span>
              </p>
            ) : null}
          </div>
          <div className="flex items-start gap-2">
            {webgl ? (
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={0}
                aria-label="Office display"
                value={display}
                onValueChange={(value) => {
                  if (!value) return
                  // The 2D map doesn't animate walks: finish any in progress.
                  if (value === "2d")
                    for (const [id, m] of Object.entries(state.movement))
                      if (m.kind === "walking")
                        dispatch({
                          type: "arrive",
                          id: id as OfficeEmployeeId,
                          routeId: m.routeId,
                        })
                  setDisplay(value as Display)
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
            {fullscreen.supported ? (
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={
                  fullscreen.active ? "Exit fullscreen" : "Enter fullscreen"
                }
                aria-pressed={fullscreen.active}
                className="pointer-events-auto bg-surface/90 backdrop-blur"
                onClick={() =>
                  fullscreen.active ? fullscreen.exit() : fullscreen.enter()
                }
              >
                {fullscreen.active ? (
                  <Minimize aria-hidden="true" />
                ) : (
                  <Maximize aria-hidden="true" />
                )}
              </Button>
            ) : null}
          </div>
        </div>

        {fullscreen.error ? (
          <div
            role="status"
            className="absolute inset-x-3 top-14 mx-auto flex max-w-md items-start gap-2 rounded-lg bg-surface/95 p-3 text-sm shadow-raised ring-1 ring-border backdrop-blur"
          >
            <p className="flex-1">{fullscreen.error}</p>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Dismiss"
              onClick={fullscreen.dismissError}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        ) : null}

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

      <div
        role="region"
        aria-label="Employees"
        className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)]"
      >
        <section
          aria-label="Team"
          className="flex min-w-0 flex-col gap-3 rounded-2xl bg-card p-4 text-card-foreground shadow-flat ring-1 ring-border"
        >
          <EmployeeList
            statuses={state.statuses}
            movement={state.movement}
            selectedId={selectedId}
            onSelect={select}
          />
          <label className="flex items-center justify-between gap-3 border-t border-border pt-3 text-sm">
            <span>
              <span className="block font-medium">Ambient breaks</span>
              <span className="block text-xs text-muted-foreground">
                Idle colleagues wander to the pantry or lounge on their own.
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={state.wander}
              onChange={(e) =>
                dispatch({ type: "setWander", on: e.target.checked })
              }
              className="size-4 accent-primary"
            />
          </label>
        </section>
        <EmployeeDetails
          selectedId={selectedId}
          status={selectedStatus}
          movement={selectedId ? state.movement[selectedId] : null}
          moveOptions={
            selectedId && selectedStatus
              ? movementOptions(selectedId, selectedStatus, state.movement)
              : []
          }
          onMove={(option) => {
            if (selectedId) move(selectedId, option)
          }}
          onSetStatus={(status) => {
            if (selectedId)
              dispatch({
                type: "setStatus",
                id: selectedId,
                status,
                from: from(selectedId),
                instant,
              })
          }}
          onClose={() => select(null)}
        />
        <div className="min-w-0 md:col-span-2 xl:col-span-1">
          <ActivityFeed entries={state.activity} />
        </div>
      </div>
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
