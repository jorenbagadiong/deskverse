/**
 * Single source of truth for the (provisional) brand.
 *
 * "Deskverse" is a working name only and may change because of potential
 * trademark conflicts. Every user-facing reference to the product name should
 * read from this object, so a rename is a one-line change here (plus the static
 * favicon in `src/app/icon.svg`, which cannot import TypeScript).
 */
export const brand = {
  name: "Deskverse",
  tagline: "Your AI automation office",
  description:
    "A futuristic AI automation office: a professional dashboard paired with a playful virtual workplace staffed by robot employees.",
  /** Shown as a warning badge wherever the brand is showcased. */
  provisional: true,
  repositoryUrl: "https://github.com/jorenbagadiong/deskverse",
} as const

export type Brand = typeof brand
