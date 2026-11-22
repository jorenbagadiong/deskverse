import type { TicketPlatform } from "@/lib/tickets/types"
import { PLATFORM_CHECKLIST } from "./types"
/** Preparation reminders only; no remote policy retrieval, legal certification or account changes. */
export const PLATFORM_PREPARATION: Record<
  TicketPlatform,
  { version: typeof PLATFORM_CHECKLIST; actions: string[] }
> = {
  tiktok: {
    version: PLATFORM_CHECKLIST,
    actions: [
      "Check TikTok's current branded/commercial-content disclosure requirements.",
      "Confirm the applicable content disclosure setting in the later publishing workflow.",
      "Inspect top tabs, right rail and bottom controls on a real device.",
    ],
  },
  instagram_reels: {
    version: PLATFORM_CHECKLIST,
    actions: [
      "Check Instagram's current branded-content and partnership labeling requirements.",
      "Confirm any required paid-partnership setting in the later publishing workflow.",
      "Inspect Reels overlays at the actual playback size.",
    ],
  },
  youtube_shorts: {
    version: PLATFORM_CHECKLIST,
    actions: [
      "Check YouTube's current paid-promotion and affiliate-disclosure requirements.",
      "Confirm any required paid-promotion declaration in the later publishing workflow.",
      "Inspect Shorts overlays at the actual playback size.",
    ],
  },
  other: {
    version: PLATFORM_CHECKLIST,
    actions: [
      "Identify the destination platform before approval.",
      "Verify its current commercial-content disclosure rules and account settings.",
      "Inspect actual device overlays before publishing.",
    ],
  },
}
