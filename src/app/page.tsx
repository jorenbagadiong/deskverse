import Link from "next/link"
import { ArrowRight, Boxes, Palette, Workflow } from "lucide-react"

import { AnimatedLogo } from "@/components/brand/animated-logo"
import { EmployeeAvatar } from "@/components/employees/employee-card"
import { StatusBadge } from "@/components/employees/status-badge"
import { Reveal } from "@/components/motion/reveal"
import { Button } from "@/components/ui/button"
import { brand } from "@/config/brand"
import { employees } from "@/config/employees"

const milestones = [
  {
    id: "DV-001",
    title: "Brand & design system",
    body: "Tokens, themes, logo, motion patterns and the /brand showcase.",
    Icon: Palette,
    current: false,
  },
  {
    id: "DV-002",
    title: "3D virtual office",
    body: "All seven AI employees at work across two floors of an interactive isometric HQ.",
    Icon: Boxes,
    current: true,
  },
  {
    id: "Later",
    title: "Automation workflows",
    body: "Local-first task pipelines the AI team can run and report on.",
    Icon: Workflow,
    current: false,
  },
]

export default function Home() {
  return (
    <div className="mx-auto max-w-content px-gutter sm:px-gutter-lg">
      <section className="flex flex-col gap-8 py-section sm:py-section-lg">
        <AnimatedLogo />
        <div className="flex max-w-2xl flex-col gap-4">
          <h1 className="text-headline sm:text-display">{brand.tagline}</h1>
          <p className="text-lg text-muted-foreground">{brand.description}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/office">
              Enter the office
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/brand">Explore the brand system</Link>
          </Button>
        </div>
      </section>

      <section
        aria-labelledby="team-title"
        className="border-t border-border py-section"
      >
        <h2 id="team-title" className="mb-stack text-title">
          Meet the team
        </h2>
        <Reveal className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {employees.map((employee) => (
            <div
              key={employee.id}
              data-reveal=""
              className="flex items-center gap-3 rounded-xl bg-card p-3 shadow-flat ring-1 ring-border"
            >
              <EmployeeAvatar employee={employee} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{employee.name}</p>
                <p className="text-sm text-muted-foreground">{employee.role}</p>
              </div>
              <StatusBadge
                status={employee.sampleStatus}
                className="hidden xl:inline-flex"
              />
            </div>
          ))}
        </Reveal>
      </section>

      <section
        aria-labelledby="roadmap-title"
        className="border-t border-border py-section"
      >
        <h2 id="roadmap-title" className="mb-stack text-title">
          Roadmap
        </h2>
        <ol className="grid gap-4 md:grid-cols-3">
          {milestones.map(({ id, title, body, Icon, current }) => (
            <li
              key={id}
              className={`flex flex-col gap-2 rounded-xl p-5 ring-1 ${current ? "bg-card shadow-glow ring-primary/40" : "bg-surface-sunken ring-border"}`}
            >
              <div className="flex items-center gap-2">
                <Icon aria-hidden="true" className="size-4 text-primary" />
                <span className="font-mono text-xs text-muted-foreground">
                  {id}
                </span>
                {current ? (
                  <span className="ml-auto text-xs font-medium text-primary">
                    In progress
                  </span>
                ) : null}
              </div>
              <p className="font-semibold">{title}</p>
              <p className="text-sm text-muted-foreground">{body}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
