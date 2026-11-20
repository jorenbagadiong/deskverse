import { cn } from "@/lib/utils"

/** Consistent heading + spacing rhythm for showcase/documentation sections. */
export function Section({
  id,
  eyebrow,
  title,
  description,
  children,
  className,
}: {
  id: string
  eyebrow?: string
  title: string
  description?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn(
        "scroll-mt-20 border-t border-border py-section",
        className,
      )}
    >
      <header className="mb-stack max-w-2xl space-y-2">
        {eyebrow ? (
          <p className="text-eyebrow text-primary uppercase">{eyebrow}</p>
        ) : null}
        <h2 id={`${id}-title`} className="text-headline">
          {title}
        </h2>
        {description ? (
          <p className="text-muted-foreground">{description}</p>
        ) : null}
      </header>
      {children}
    </section>
  )
}
