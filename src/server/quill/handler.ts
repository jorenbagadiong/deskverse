import { setTimeout as sleep } from "node:timers/promises"

import type pg from "pg"

import { QUILL_TEMPLATES, type QuillScriptDocument } from "@/lib/quill/types"
import {
  HandlerAborted,
  type HandlerContext,
  type HandlerOutcome,
  type TaskHandler,
} from "@/server/orchestrator/workflows"
import { composeScript } from "@/server/quill/compose"
import {
  quillOllamaPropose,
  validateProposals,
  type Proposals,
  type QuillConfig,
} from "@/server/quill/ollama"
import { MIN_ELIGIBLE_FACTS, selectFacts } from "@/server/quill/select"
import { persistScript } from "@/server/quill/store"
import { validateScript } from "@/server/quill/validate"
import { ollamaStatus, type FetchLike } from "@/server/scout/ollama"
import { verifyScoutReport } from "@/server/scout/store"

/**
 * Quill's production handler for `quill.script` (DV-005B). Reads the
 * PINNED Scout report (never "the newest"), re-verifies it, writes the
 * script from eligible claims only, validates it, and returns it as a
 * deliverable that is stored in the same transaction that completes the
 * task. It fetches nothing from the web and changes no Scout or owner data.
 */

export interface QuillHandlerOptions {
  pool: pg.Pool
  config: QuillConfig
  ollamaFetch?: FetchLike
  /** Test-only: slow generation and a crash point before commit. */
  test?: { delayMs: number; crashBeforeCommit: string | null } | null
}

const MODEL_ATTEMPTS = 2

export function createQuillHandler(options: QuillHandlerOptions): TaskHandler {
  const { pool, config } = options
  return {
    stage: "quill.script",
    kind: "production",
    async run(ctx: HandlerContext): Promise<HandlerOutcome> {
      const pin = ctx.params as {
        reportId?: unknown
        reportVersion?: unknown
        reportChecksum?: unknown
      }
      if (
        typeof pin.reportId !== "string" ||
        typeof pin.reportChecksum !== "string" ||
        !ctx.snapshot
      )
        return {
          status: "permanent",
          message: "This script task has no pinned research report.",
        }
      const verified = await verifyScoutReport(pool, pin.reportId)
      const productId = (
        ctx.snapshot.data.product as { id?: string } | undefined
      )?.id
      if (
        !verified ||
        verified.ticketId !== ctx.ticketId ||
        verified.productId !== productId ||
        verified.reportVersion !== pin.reportVersion ||
        verified.checksum !== pin.reportChecksum
      )
        return {
          status: "permanent",
          message:
            "The pinned research report is missing or isn't the one this task was planned with.",
        }
      if (!verified.intact)
        return {
          status: "permanent",
          message:
            "The pinned research report fails its checksum check; Quill doesn't write from it.",
        }
      if (verified.snapshotChecksum !== ctx.snapshot.checksum)
        return {
          status: "permanent",
          message:
            "The research report was made from different product data than this task's frozen copy.",
        }
      const report = verified.report
      const { eligible, excluded, conflicts } = selectFacts(report)
      const name = String(
        (ctx.snapshot.data.product as { name?: string }).name ??
          report.productName,
      )
      if (
        report.status === "insufficient_evidence" ||
        eligible.length < MIN_ELIGIBLE_FACTS
      ) {
        const parts = [
          `Only ${eligible.length} fact${eligible.length === 1 ? "" : "s"} about “${name}” can be used in a script (Quill needs ${MIN_ELIGIBLE_FACTS}).`,
          conflicts.length
            ? `Conflicting: ${conflicts.slice(0, 3).join(", ")}.`
            : "",
          excluded.length
            ? `Not usable: ${excluded
                .slice(0, 3)
                .map(
                  (e) =>
                    `“${e.statement.slice(0, 40)}” (${e.reason.replace(/\.$/, "").toLowerCase()})`,
                )
                .join("; ")}.`
            : "",
          "Add sources that state the product's features (a manufacturer page is best), run Scout again, then start a new script run from the new report.",
        ]
        return {
          status: "needs_input",
          message: parts.filter(Boolean).join(" ").slice(0, 500),
          details: {
            eligible: eligible.length,
            conflicts: conflicts.slice(0, 5),
          },
        }
      }

      if (options.test?.delayMs)
        try {
          await sleep(options.test.delayMs, undefined, { signal: ctx.signal })
        } catch {
          throw new HandlerAborted("aborted")
        }

      const base = {
        report,
        snapshot: ctx.snapshot,
        ticketId: ctx.ticketId,
        eligible,
        excluded,
        now: new Date(),
      }
      let doc: QuillScriptDocument = composeScript(base)

      // Optional local-model wording; every proposal is validated, and
      // anything rejected keeps its template text.
      if (config.generation === "ollama") {
        const generation: QuillScriptDocument["generation"] = {
          ...doc.generation,
        }
        if (!config.ollama)
          generation.note = `Local AI wording is configured but unusable (${config.ollamaProblem}); template wording was used.`
        else {
          const status = await ollamaStatus(
            {
              ...config.ollama,
              maxPromptChars: 8_000,
              maxOutputTokens: config.ollama.maxOutputTokens,
            },
            options.ollamaFetch,
            ctx.signal,
          ).catch(() => null)
          if (!status?.reachable || !status.modelAvailable)
            generation.note = `Local AI wording wasn't available (${status?.problem ?? "Ollama didn't answer"}); template wording was used.`
          else {
            let best: Proposals | null = null
            let rejected = 0
            for (let attempt = 0; attempt < MODEL_ATTEMPTS; attempt++) {
              if (ctx.signal.aborted) throw new HandlerAborted("aborted")
              try {
                const raw = await quillOllamaPropose(
                  config.ollama,
                  name,
                  doc.platform,
                  eligible.slice(0, 5),
                  ctx.signal,
                  options.ollamaFetch,
                )
                const p = validateProposals(raw, name, eligible.slice(0, 5))
                rejected += p.rejected.length
                if (!best || p.accepted > best.accepted) best = p
                if (p.rejected.length === 0) break
              } catch {
                if (ctx.signal.aborted) throw new HandlerAborted("aborted")
                rejected++
              }
            }
            generation.model = {
              name: config.ollama.model,
              digest: status.modelDigest,
              ollamaVersion: status.version,
              temperature: config.ollama.temperature,
            }
            generation.modelProposalsAccepted = best?.accepted ?? 0
            generation.modelProposalsRejected = rejected
            if (best && best.accepted > 0) {
              generation.mode = "template+ollama"
              const candidate = composeScript({
                ...base,
                wording: {
                  hook: best.hook,
                  benefits: best.benefits,
                  callToAction: best.callToAction,
                },
                generation: { ...generation, templates: QUILL_TEMPLATES },
              })
              // The whole script must still pass; otherwise keep the template.
              if (
                validateScript(candidate, eligible).every(
                  (f) => f.level !== "error",
                )
              )
                doc = candidate
              else {
                generation.mode = "template"
                generation.note =
                  "The local model's wording failed validation; template wording was used."
              }
            }
            if (rejected > 0 && !generation.note)
              generation.note = `${rejected} model proposal(s) were rejected (unsupported facts, numbers, wording or citations); template text was kept for those parts.`
          }
        }
        doc =
          doc.generation.mode === "template+ollama"
            ? doc
            : composeScript({ ...base, generation })
      }

      const findings = validateScript(doc, eligible)
      const errors = findings.filter((f) => f.level === "error")
      if (errors.length > 0)
        return {
          status: "permanent",
          message: `The script failed validation, so nothing was saved: ${errors
            .slice(0, 3)
            .map((e) => e.message)
            .join(" ")}`.slice(0, 500),
        }
      doc = { ...doc, findings }
      if (ctx.signal.aborted) throw new HandlerAborted("aborted")
      const final = doc
      return {
        status: "completed",
        result: { kind: "quill_script" },
        deliverable: {
          kind: "quill_script",
          persist: (client, commit) =>
            persistScript(client, commit, final, {
              beforeCommit: () => {
                const marker = options.test?.crashBeforeCommit
                if (marker && name.includes(marker) && ctx.attempt === 1)
                  process.kill(process.pid, "SIGKILL")
              },
            }),
        },
      }
    },
  }
}
