import journalJson from "../../../drizzle/meta/_journal.json"

import type { Journal } from "@/server/db/migrations"

/** The migrations this checkout knows about (drizzle/meta/_journal.json), bundled at build time. */
export const journal: Journal = journalJson
