import { brand } from "@/config/brand"
import { cn } from "@/lib/utils"

/**
 * Provisional Deskverse mark: a robot visor peeking through an office portal
 * that sits on a desk. Colors come from semantic tokens, so it adapts to both
 * themes. Shapes are deliberately chunky to stay legible at 16px.
 */
export function LogoMark({
  className,
  title,
  animated = false,
}: {
  className?: string
  /** Provide when the mark stands alone and must be announced. */
  title?: string
  /** Adds hooks used by <AnimatedLogo>; parts start hidden until animated. */
  animated?: boolean
}) {
  const part = (name: string) =>
    animated ? { "data-logo-part": name, "data-reveal": "" } : {}
  const transformStyle = {
    transformBox: "fill-box",
    transformOrigin: "center",
  } as const

  return (
    <svg
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("size-8 shrink-0", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <rect
        {...part("frame")}
        style={transformStyle}
        x="2"
        y="2"
        width="28"
        height="28"
        rx="9"
        fill="var(--primary)"
      />
      <path
        {...part("portal")}
        style={transformStyle}
        d="M9.5 21V15.5a6.5 6.5 0 0 1 13 0V21Z"
        fill="var(--primary-foreground)"
      />
      <rect
        {...part("desk")}
        style={transformStyle}
        x="6"
        y="22.5"
        width="20"
        height="3.25"
        rx="1.6"
        fill="var(--primary-foreground)"
      />
      <rect
        {...part("visor")}
        style={transformStyle}
        x="12"
        y="14"
        width="8"
        height="3.25"
        rx="1.6"
        fill="var(--accent)"
      />
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn("font-semibold tracking-tight text-foreground", className)}
    >
      {brand.name}
    </span>
  )
}

/** Mark + wordmark lockup. The wordmark text doubles as the accessible name. */
export function Logo({
  className,
  markClassName,
  wordmarkClassName,
}: {
  className?: string
  markClassName?: string
  wordmarkClassName?: string
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark className={markClassName} />
      <Wordmark className={wordmarkClassName} />
    </span>
  )
}
