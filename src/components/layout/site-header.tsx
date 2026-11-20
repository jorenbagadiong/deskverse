import Link from "next/link"

import { Logo } from "@/components/brand/logo"
import { ThemeSwitcher } from "@/components/theme/theme-switcher"
import { brand } from "@/config/brand"

const nav = [
  { href: "/", label: "Overview" },
  { href: "/brand", label: "Brand" },
]

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-content items-center gap-3 px-gutter sm:gap-6 sm:px-gutter-lg">
        <Link href="/" aria-label={`${brand.name} home`} className="rounded-md">
          <Logo
            markClassName="size-7"
            wordmarkClassName="hidden text-lg min-[400px]:inline"
          />
        </Link>
        <nav aria-label="Main" className="flex items-center gap-1 text-sm">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <ThemeSwitcher className="ml-auto" />
      </div>
    </header>
  )
}
