import "../load-env"

import { getPool } from "@/server/db/client"
import { scoutDiagnostics } from "@/server/scout/http"

/**
 * yarn scout:check — read-only Scout diagnostics (DV-005A): whether
 * research is on, source limits, the extraction mode, the optional local
 * model (loopback only; GET /api/version and /api/tags, never a download),
 * whether a worker that can run Scout checked in recently, and what's
 * missing. Fetches no source and changes nothing. A reachable model is
 * not proof that any research succeeded.
 */
scoutDiagnostics()
  .then(async (d) => {
    const o = d.extraction.ollama
    console.log(
      `Scout handler:   ${d.handlerRegistered ? "registered in workers started with this configuration" : "not registered (research is off)"}`,
    )
    console.log(
      `Source retrieval: ${d.retrieval.enabled ? "on" : "off"}; up to ${d.retrieval.maxSources} references per product, ${d.retrieval.maxPageKB} KB per page`,
    )
    console.log(`Extraction:      ${d.extraction.mode}`)
    if (d.extraction.mode === "ollama")
      console.log(
        `Local model:     ${o.configured ? `${o.model} at ${o.endpoint}: ${o.reachable ? `Ollama ${o.version ?? "?"} reachable` : "Ollama not reachable"}, model ${o.modelAvailable ? "installed" : "not installed"}` : "not usable"}${o.problem ? ` — ${o.problem}` : ""}`,
      )
    console.log(
      `Research workflow: ${d.researchWorkflow.id} ${d.researchWorkflow.available ? "available" : "unavailable"}`,
    )
    console.log(
      `Full campaign:   ${d.fullCampaign.available ? "available" : `not available yet (${d.fullCampaign.missing.join(", ")})`}`,
    )
    console.log(
      `Worker:          ${d.worker.status === "running" ? `checked in ${d.worker.lastSeenSecondsAgo}s ago${d.worker.handlesResearch ? " (can run Scout)" : " (can't run Scout)"}` : d.worker.status === "not_seen" ? "none checked in during the last 15 s" : "unknown (database unreachable)"}`,
    )
    if (d.missingConfiguration.length) {
      console.log("\nTo do:")
      for (const m of d.missingConfiguration) console.log(`  - ${m}`)
    }
    await getPool()
      .end()
      .catch(() => {})
  })
  .catch(async (error: unknown) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
    await getPool()
      .end()
      .catch(() => {})
    process.exit(1)
  })
