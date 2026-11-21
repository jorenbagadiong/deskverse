import Link from "next/link"

import { Logo } from "@/components/brand/logo"
import { ThemeSwitcher } from "@/components/theme/theme-switcher"
import { brand } from "@/config/brand"
import { cn } from "@/lib/utils"

const nav = [
  // Hidden on the narrowest phones (under 400 px), so the menu and theme
  // switcher fit: the logo is also a home link, and the design-system
  // showcase is the least needed page on a phone.
  { href: "/", label: "Overview", className: "max-[399px]:hidden" },
  { href: "/tickets", label: "Tickets" },
  { href: "/office", label: "Office" },
  { href: "/studio/pixel", label: "Studio" },
  { href: "/brand", label: "Brand", className: "max-[399px]:hidden" },
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
              className={cn(
                "rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                "className" in item && item.className,
              )}
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
