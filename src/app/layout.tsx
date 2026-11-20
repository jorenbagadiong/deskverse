import type { Metadata, Viewport } from "next"
import localFont from "next/font/local"

import { SiteHeader } from "@/components/layout/site-header"
import { ThemeProvider } from "@/components/theme/theme-provider"
import { brand } from "@/config/brand"
import "./globals.css"

// Inter, self-hosted from the @fontsource-variable/inter package:
// no network request at build or run time, so the app works fully offline.
const inter = localFont({
  src: "../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
})

export const metadata: Metadata = {
  title: { default: brand.name, template: `%s · ${brand.name}` },
  description: brand.description,
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#080f1c" },
    { media: "(prefers-color-scheme: light)", color: "#f5f8fc" },
  ],
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // next-themes sets the theme class on <html> before hydration.
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="min-h-dvh overflow-x-clip">
        <ThemeProvider>
          <a
            href="#main"
            className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
          >
            Skip to content
          </a>
          <SiteHeader />
          <main id="main" tabIndex={-1} className="focus:outline-none">
            {children}
          </main>
        </ThemeProvider>
      </body>
    </html>
  )
}
