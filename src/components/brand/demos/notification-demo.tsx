"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { animate, createScope, type Scope } from "animejs"
import { Bell, X } from "lucide-react"

import { StatusBadge } from "@/components/employees/status-badge"
import { Button } from "@/components/ui/button"
import type { EmployeeStatus } from "@/config/employee-status"
import { duration, ease, motionQueries } from "@/lib/motion"

type Notice = {
  id: number
  from: string
  message: string
  status: EmployeeStatus
}

/* Static sample feed — no external APIs. */
const SAMPLES: Omit<Notice, "id">[] = [
  {
    from: "Quill",
    message: "Script draft is ready for your approval.",
    status: "waiting",
  },
  {
    from: "Pixel",
    message: "Product teaser finished rendering.",
    status: "completed",
  },
  {
    from: "Relay",
    message: "Upload failed: thumbnail is missing.",
    status: "failed",
  },
  {
    from: "Scout",
    message: "Started researching this week's trends.",
    status: "working",
  },
  {
    from: "Ledger",
    message: "Weekly analytics report is available.",
    status: "completed",
  },
]

const MAX_VISIBLE = 3

export function NotificationDemo() {
  const [notices, setNotices] = useState<Notice[]>([{ id: 0, ...SAMPLES[0] }])
  const nextId = useRef(1)
  const lastAnimatedId = useRef(0)
  const root = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const scope = useRef<Scope | null>(null)

  useEffect(() => {
    scope.current = createScope({ root, mediaQueries: motionQueries }).add(
      (self) => {
        if (!self) return
        self.add("enter", (id: number) => {
          if (self.matches.reduceMotion) return
          animate(`[data-notice-id="${id}"]`, {
            opacity: [0, 1],
            translateY: [-10, 0],
            scale: [0.98, 1],
            duration: duration.base + 120,
            ease: ease.out,
          })
        })
      },
    )
    return () => scope.current?.revert()
  }, [])

  // Animate only newly added notices, before the browser paints them.
  const newestId = notices[0]?.id ?? -1
  useLayoutEffect(() => {
    if (newestId <= lastAnimatedId.current) return
    lastAnimatedId.current = newestId
    scope.current?.methods.enter?.(newestId)
  }, [newestId])

  function addNotice() {
    const id = nextId.current++
    const sample = SAMPLES[id % SAMPLES.length]
    setNotices((current) =>
      [{ id, ...sample }, ...current].slice(0, MAX_VISIBLE),
    )
  }

  function dismiss(id: number) {
    setNotices((current) => current.filter((n) => n.id !== id))
    // Keep keyboard focus somewhere sensible after the item disappears.
    triggerRef.current?.focus()
  }

  return (
    <div ref={root} className="flex flex-col gap-4">
      <Button ref={triggerRef} onClick={addNotice} className="self-start">
        <Bell aria-hidden="true" />
        Simulate notification
      </Button>

      {/* Fixed height for MAX_VISIBLE items so new notices never push the page around. */}
      <div
        role="log"
        aria-live="polite"
        aria-label="Team notifications"
        className="min-h-[15.5rem]"
      >
        {notices.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            No notifications.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {notices.map((notice) => (
              <li
                key={notice.id}
                data-notice-id={notice.id}
                className="flex items-start gap-3 rounded-lg bg-surface-raised p-3 shadow-raised ring-1 ring-border"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{notice.from}</span>
                    <StatusBadge status={notice.status} />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {notice.message}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Dismiss notification from ${notice.from}`}
                  onClick={() => dismiss(notice.id)}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
