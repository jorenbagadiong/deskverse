import Link from "next/link"

import { Logo } from "@/components/brand/logo"
import { ThemeSwitcher } from "@/components/theme/theme-switcher"
import { brand } from "@/config/brand"
import { cn } from "@/lib/utils"

const nav = [
  // Hidden on narrow screens, so the menu and theme
  // switcher fit: the logo is also a home link, and the design-system
  // showcase is the least needed page on a phone.
  { href: "/", label: "Overview", className: "max-[549px]:hidden" },
  { href: "/tickets", label: "Tickets" },
  { href: "/approvals", label: "Approvals" },
  { href: "/office", label: "Office" },
  { href: "/studio/pixel", label: "Studio" },
  { href: "/brand", label: "Brand", className: "max-[549px]:hidden" },
]

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-content items-center gap-3 px-gutter sm:gap-6 sm:px-gutter-lg">
        <Link href="/" aria-label={`${brand.name} home`} className="rounded-md">
          <Logo
            markClassName="size-7"
            wordmarkClassName="hidden text-lg min-[550px]:inline"
          />
        </Link>
        <nav
          aria-label="Main"
          className="flex min-w-0 items-center gap-1 overflow-x-auto text-sm"
        >
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "rounded-md px-1.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:px-2",
                "className" in item && item.className,
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <ThemeSwitcher className="ml-auto shrink-0" />
      </div>
    </header>
  )
}
