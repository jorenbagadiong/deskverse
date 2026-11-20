import type { Metadata } from "next"
import { ArrowRight, Plus, Sparkles, Trash2, TriangleAlert } from "lucide-react"

import { AnimatedLogo } from "@/components/brand/animated-logo"
import { ButtonFeedbackDemo } from "@/components/brand/demos/button-feedback-demo"
import { DashboardCardsDemo } from "@/components/brand/demos/dashboard-cards-demo"
import { NotificationDemo } from "@/components/brand/demos/notification-demo"
import { StatusTransitionDemo } from "@/components/brand/demos/status-transition-demo"
import { TaskProgressDemo } from "@/components/brand/demos/task-progress-demo"
import { Logo, LogoMark } from "@/components/brand/logo"
import {
  EmployeeAvatar,
  EmployeeCard,
} from "@/components/employees/employee-card"
import { StatusBadge } from "@/components/employees/status-badge"
import { Section } from "@/components/layout/section"
import { Reveal } from "@/components/motion/reveal"
import { ThemeSwitcher } from "@/components/theme/theme-switcher"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { brand } from "@/config/brand"
import {
  brandColors,
  statusColors,
  type ColorToken,
} from "@/config/design-tokens"
import { EMPLOYEE_STATUSES, statusMeta } from "@/config/employee-status"
import { employees } from "@/config/employees"

export const metadata: Metadata = {
  title: "Brand",
  description: `Design system showcase for the provisional ${brand.name} brand.`,
}

const toc = [
  { id: "logo", label: "Logo" },
  { id: "color", label: "Color" },
  { id: "type", label: "Typography" },
  { id: "buttons", label: "Buttons" },
  { id: "cards", label: "Cards" },
  { id: "status", label: "Status" },
  { id: "motion", label: "Motion" },
  { id: "theme", label: "Theme" },
  { id: "team", label: "AI team" },
]

export default function BrandPage() {
  return (
    <div className="mx-auto max-w-content px-gutter sm:px-gutter-lg">
      {/* Intro */}
      <div className="flex flex-col gap-8 py-section">
        <div className="flex flex-col gap-3">
          <p className="text-eyebrow text-primary uppercase">
            DV-001 · Brand &amp; design system
          </p>
          <h1 className="text-headline sm:text-display">Brand system</h1>
          <p className="max-w-2xl text-lg text-muted-foreground">
            Tokens, components and motion for {brand.name}: a professional
            automation dashboard with a playful robot workforce.
          </p>
        </div>
        {brand.provisional ? (
          <p className="flex max-w-2xl items-start gap-2 rounded-lg bg-accent/10 p-3 text-sm text-foreground ring-1 ring-accent/40 ring-inset">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-accent"
            />
            <span>
              <strong className="font-semibold">Provisional brand.</strong> “
              {brand.name}” and its logo are working names and may change
              because of potential trademark conflicts. Rename via{" "}
              <code className="font-mono text-xs">src/config/brand.ts</code>.
            </span>
          </p>
        ) : null}
        <nav aria-label="Page sections">
          <ul className="flex flex-wrap gap-2">
            {toc.map((item) => (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  className="inline-flex rounded-full bg-surface px-3 py-1 text-sm text-muted-foreground ring-1 ring-border transition-colors hover:text-foreground"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      {/* Logo */}
      <Section
        id="logo"
        eyebrow="Identity"
        title="Logo & wordmark"
        description="A robot visor peeking through an office portal that sits on a desk. Chunky geometry keeps it legible at 16px; every color is a theme token."
      >
        <div className="flex flex-col gap-6">
          <div className="rounded-2xl bg-surface p-6 ring-1 ring-border sm:p-10">
            <AnimatedLogo replayable />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {(["dark", "light"] as const).map((mode) => (
              <div
                key={mode}
                className={`${mode} flex flex-col gap-5 rounded-2xl bg-background p-6 text-foreground ring-1 ring-border`}
              >
                <p className="text-sm font-medium text-muted-foreground capitalize">
                  On {mode}
                </p>
                <Logo markClassName="size-10" wordmarkClassName="text-2xl" />
                <div className="flex items-end gap-4">
                  {[16, 24, 32, 48].map((px) => (
                    <div
                      key={px}
                      className="flex flex-col items-center gap-1.5"
                    >
                      <span
                        style={{ width: px, height: px }}
                        className="inline-flex"
                      >
                        <LogoMark className="size-full" />
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {px}px
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* Color */}
      <Section
        id="color"
        eyebrow="Tokens"
        title="Color palette"
        description="Components reference semantic tokens, never hex values. Values switch with the theme; text pairs meet WCAG AA (4.5:1) in both themes."
      >
        <div className="flex flex-col gap-8">
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {brandColors.map((color) => (
              <Swatch key={color.token} color={color} />
            ))}
          </ul>
          <div className="space-y-3">
            <h3 className="text-title">Status colors</h3>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {statusColors.map((color) => (
                <Swatch key={color.token} color={color} compact />
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {/* Typography */}
      <Section
        id="type"
        eyebrow="Tokens"
        title="Typography"
        description="Inter, self-hosted. A compact scale with tight tracking on large sizes and relaxed body copy."
      >
        <dl className="divide-y divide-border rounded-2xl bg-surface ring-1 ring-border">
          {[
            {
              token: "text-display",
              sample: "Your AI office",
              className: "text-headline sm:text-display",
            },
            {
              token: "text-headline",
              sample: "Seven specialists, one desk",
              className: "text-headline",
            },
            {
              token: "text-title",
              sample: "Weekly content pipeline",
              className: "text-title",
            },
            {
              token: "text-base",
              sample:
                "Scout gathers research, Quill drafts the script and Vera checks quality before anything ships.",
              className: "text-base",
            },
            {
              token: "text-sm · muted",
              sample: "Updated 2 minutes ago by Tempo",
              className: "text-sm text-muted-foreground",
            },
            {
              token: "text-eyebrow",
              sample: "Analytics",
              className: "text-eyebrow uppercase text-primary",
            },
            {
              token: "font-mono",
              sample: "task_8f21 · 00:14:32",
              className: "font-mono text-sm",
            },
          ].map((row) => (
            <div
              key={row.token}
              className="grid gap-2 p-5 sm:grid-cols-[10rem_1fr] sm:items-baseline"
            >
              <dt className="font-mono text-xs text-muted-foreground">
                {row.token}
              </dt>
              <dd className={`min-w-0 wrap-break-word ${row.className}`}>
                {row.sample}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      {/* Buttons */}
      <Section
        id="buttons"
        eyebrow="Components"
        title="Buttons & interactions"
        description="shadcn/ui buttons themed by tokens. Keyboard focus always shows a 2px ring; press feedback uses Anime.js on transform only."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Variants & sizes</CardTitle>
              <CardDescription>
                Tab through to check the focus ring.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-2">
                <Button>Primary</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="destructive">
                  <Trash2 aria-hidden="true" />
                  Delete
                </Button>
                <Button variant="link">Link</Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm">Small</Button>
                <Button>Default</Button>
                <Button size="lg">
                  Large
                  <ArrowRight aria-hidden="true" />
                </Button>
                <Button size="icon" variant="outline" aria-label="Add task">
                  <Plus aria-hidden="true" />
                </Button>
                <Button disabled>Disabled</Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge>Primary</Badge>
                <Badge variant="secondary">AI</Badge>
                <Badge variant="outline">Outline</Badge>
                <Badge variant="destructive">Error</Badge>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Interactive feedback</CardTitle>
              <CardDescription>
                A short squash-and-settle on press, and an icon pop on state
                change.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ButtonFeedbackDemo />
            </CardContent>
          </Card>
        </div>
      </Section>

      {/* Cards */}
      <Section
        id="cards"
        eyebrow="Components"
        title="Cards & elevation"
        description="Four elevation levels: sunken, flat, raised and glow. Cards reveal with a short staggered fade."
      >
        <div className="flex flex-col gap-8">
          <Reveal className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div
              data-reveal=""
              className="rounded-xl bg-surface-sunken p-5 ring-1 ring-border"
            >
              <p className="font-semibold">Sunken</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Wells, inputs, nested regions.
              </p>
            </div>
            <div
              data-reveal=""
              className="rounded-xl bg-card p-5 shadow-flat ring-1 ring-border"
            >
              <p className="font-semibold">Flat</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Default card surface.
              </p>
            </div>
            <a
              href="#cards"
              data-reveal=""
              className="group block rounded-xl bg-surface-raised p-5 shadow-raised ring-1 ring-border transition-[translate,box-shadow] duration-(--duration-base) ease-out-soft hover:-translate-y-1 hover:shadow-overlay"
            >
              <p className="flex items-center gap-1 font-semibold">
                Raised · interactive
                <ArrowRight
                  aria-hidden="true"
                  className="size-4 transition-transform group-hover:translate-x-0.5"
                />
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Hover lifts; clickable tiles.
              </p>
            </a>
            <div data-reveal="" className="rounded-xl bg-card p-5 shadow-glow">
              <p className="flex items-center gap-1.5 font-semibold">
                <Sparkles aria-hidden="true" className="size-4 text-primary" />
                Glow
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Highlights one active item.
              </p>
            </div>
          </Reveal>
          <div className="space-y-3">
            <h3 className="text-title">Dashboard card reveal</h3>
            <DashboardCardsDemo />
          </div>
        </div>
      </Section>

      {/* Status */}
      <Section
        id="status"
        eyebrow="Employees"
        title="Status indicators"
        description="Every state pairs a color with an icon and a text label. Status text updates instantly for assistive tech; animation is decoration only."
      >
        <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
          <ul className="flex flex-col gap-3">
            {EMPLOYEE_STATUSES.map((status) => (
              <li key={status} className="flex flex-wrap items-center gap-3">
                <StatusBadge status={status} />
                <span className="text-sm text-muted-foreground">
                  {statusMeta[status].description}
                </span>
              </li>
            ))}
          </ul>
          <Card>
            <CardHeader>
              <CardTitle>Status transitions</CardTitle>
              <CardDescription>
                Pick a state to see its transition.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <StatusTransitionDemo />
            </CardContent>
          </Card>
        </div>
      </Section>

      {/* Motion */}
      <Section
        id="motion"
        eyebrow="Anime.js v4"
        title="Motion demonstrations"
        description="Subtle and purposeful. Animations use transform and opacity only, clean up with scope.revert(), and switch off when your system asks for reduced motion."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Notifications</CardTitle>
              <CardDescription>
                New items slide in; the list space is reserved to avoid layout
                shift.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <NotificationDemo />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Task progress</CardTitle>
              <CardDescription>
                Bars scale and counters tick; the accessible value updates
                instantly.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TaskProgressDemo />
            </CardContent>
          </Card>
        </div>
      </Section>

      {/* Theme */}
      <Section
        id="theme"
        eyebrow="Themes"
        title="Light & dark"
        description="Dark is the default. Your choice is remembered locally; System follows your OS setting."
      >
        <div className="flex flex-col gap-6">
          <ThemeSwitcher showLabels />
          <div className="grid gap-4 md:grid-cols-2">
            {(["dark", "light"] as const).map((mode) => (
              <div
                key={mode}
                className={`${mode} flex flex-col gap-4 rounded-2xl bg-background p-5 text-foreground ring-1 ring-border`}
              >
                <p className="text-sm font-medium text-muted-foreground capitalize">
                  {mode} preview
                </p>
                <div className="flex items-center gap-3 rounded-xl bg-surface p-4 ring-1 ring-border">
                  <EmployeeAvatar employee={employees[1]} />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{employees[1].name}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      {employees[1].sampleTask}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <StatusBadge status="waiting" />
                  <StatusBadge status="completed" />
                  <StatusBadge status="failed" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground">
                    Primary
                  </span>
                  <span className="inline-flex h-8 items-center rounded-lg bg-secondary px-3 text-sm font-medium text-secondary-foreground">
                    Secondary
                  </span>
                  <span className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-sm font-medium text-accent-foreground">
                    Accent
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* Team */}
      <Section
        id="team"
        eyebrow="Coming in DV-002"
        title="The AI team"
        description="Seven specialists that will become friendly low-poly 3D robots in the virtual office. These 2D cards are placeholders; see docs/brand-guidelines.md for the 3D visual direction."
      >
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {employees.map((employee) => (
            <li key={employee.id} className="flex">
              <EmployeeCard employee={employee} className="w-full" />
            </li>
          ))}
        </ul>
      </Section>
    </div>
  )
}

function Swatch({
  color,
  compact = false,
}: {
  color: ColorToken
  compact?: boolean
}) {
  return (
    <li className="overflow-hidden rounded-xl bg-surface ring-1 ring-border">
      <div
        className={`flex items-end p-3 ${compact ? "h-16" : "h-24"}`}
        style={{ background: `var(${color.token})` }}
      >
        {color.onToken ? (
          <span
            className="text-sm font-semibold"
            style={{ color: `var(${color.onToken})` }}
          >
            Aa
          </span>
        ) : null}
      </div>
      <div className="space-y-1 p-3">
        <p className="text-sm font-semibold">{color.name}</p>
        <p className="font-mono text-xs break-all text-muted-foreground">
          {color.token}
        </p>
        {!compact ? (
          <p className="font-mono text-xs text-muted-foreground">
            {color.dark.toUpperCase()} · {color.light.toUpperCase()}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">{color.usage}</p>
      </div>
    </li>
  )
}
