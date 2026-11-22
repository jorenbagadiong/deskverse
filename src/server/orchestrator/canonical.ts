import type { QueryResult } from "pg"
import { createHash } from "node:crypto"

/** Canonical JSON (sorted keys) for checksums (DV-004C; shared since DV-005B). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`
  return JSON.stringify(value)
}

export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex")

/** Anything with a `query` method: a pool or a client inside a transaction. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<QueryResult>
}
