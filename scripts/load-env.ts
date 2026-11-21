import { loadEnvConfig } from "@next/env"

/**
 * Standalone scripts (yarn db:*) and, later, the background worker run
 * outside Next.js, so they don't get .env files loaded automatically. This
 * loads them exactly the way `next dev` does (.env.development.local,
 * .env.local, .env.development, .env), quietly. Import it first.
 */
loadEnvConfig(process.cwd(), true, {
  info: () => {},
  error: (...args: unknown[]) => console.error(...args),
})
