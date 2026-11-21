import {
  HandlerAborted,
  type HandlerContext,
  type HandlerOutcome,
  type TaskHandler,
} from "@/server/orchestrator/workflows"
import type { ScoutConfig } from "@/server/scout/config"
import {
  DEFAULT_FETCH_LIMITS,
  realNetwork,
  ScoutFetcher,
  type NetworkDeps,
} from "@/server/scout/net/fetcher"
import {
  ollamaExtract,
  ollamaStatus,
  type FetchLike,
} from "@/server/scout/ollama"
import {
  ResearchCancelled,
  researchProduct,
  type SnapshotProduct,
} from "@/server/scout/research"
import { persistResearch } from "@/server/scout/store"

/**
 * Scout's production task handler for `scout.research` (DV-005A). Uses the
 * orchestrator for everything else (claims, leases, heartbeats, fencing,
 * retries, pause/cancel, events): Scout has no queue of its own.
 */

export interface ScoutHandlerOptions {
  config: ScoutConfig
  /** Real network by default; fixture networks in tests. */
  network?: NetworkDeps
  /** For the local model only (loopback). */
  ollamaFetch?: FetchLike
  /** Test-only crash point between writing the report and committing. */
  crashBeforeCommit?: (productName: string, attempt: number) => boolean
}

export function createScoutHandler(options: ScoutHandlerOptions): TaskHandler {
  const { config } = options
  const fetcher = new ScoutFetcher(options.network ?? realNetwork, {
    ...DEFAULT_FETCH_LIMITS,
    maxPageBytes: config.maxPageBytes,
    requestTimeoutMs: config.requestTimeoutMs,
    connectTimeoutMs: Math.min(5_000, config.requestTimeoutMs),
    hostIntervalMs: config.hostIntervalMs,
  })
  const ollama = config.ollama
    ? {
        model: config.ollama.model,
        status: (signal: AbortSignal) =>
          ollamaStatus(config.ollama!, options.ollamaFetch, signal),
        extract: (
          product: string,
          passages: { id: string; text: string }[],
          signal: AbortSignal,
        ) =>
          ollamaExtract(
            config.ollama!,
            product,
            passages,
            signal,
            options.ollamaFetch,
          ),
      }
    : null

  return {
    stage: "scout.research",
    kind: "production",
    async run(ctx: HandlerContext): Promise<HandlerOutcome> {
      const product = (
        ctx.snapshot?.data as { product?: SnapshotProduct } | undefined
      )?.product
      if (!product)
        return {
          status: "permanent",
          message: "This research task has no frozen product snapshot.",
        }
      let outcome
      try {
        outcome = await researchProduct(
          product,
          {
            attempt: ctx.attempt,
            maxAttempts: ctx.maxAttempts,
            signal: ctx.signal,
          },
          { fetcher, config, ollama },
        )
      } catch (error) {
        if (error instanceof ResearchCancelled || ctx.signal.aborted)
          throw new HandlerAborted("aborted")
        throw error
      }
      if (ctx.signal.aborted) throw new HandlerAborted("aborted")
      if (outcome.kind === "needs_input")
        return {
          status: "needs_input",
          message: outcome.message,
          details: { sources: outcome.problems },
        }
      if (outcome.kind === "transient")
        return {
          status: "transient",
          message: outcome.message,
          retryAfterMs: outcome.retryAfterMs,
          details: { sources: outcome.problems },
        }
      const name = typeof product.name === "string" ? product.name : ""
      const report = outcome
      return {
        status: "completed",
        result: { kind: "scout_research" },
        deliverable: {
          kind: "scout_research",
          persist: (client, commit) =>
            persistResearch(client, commit, report, {
              beforeCommit: () => {
                if (options.crashBeforeCommit?.(name, ctx.attempt))
                  process.kill(process.pid, "SIGKILL")
              },
            }),
        },
      }
    },
  }
}
