"use client"

import { useEffect, useState } from "react"
import {
  ExternalLink,
  LoaderCircle,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react"

import { FormMessage, formatDate } from "@/components/tickets/fields"
import {
  CLAIM_STATUS_LABEL,
  reportEndpoint,
  SOURCE_OUTCOME_LABEL,
  SOURCE_TRUST_LABEL,
  type ClaimStatus,
  type ResearchClaim,
  type ResearchEvidence,
  type ResearchReport,
  type ResearchSource,
} from "@/lib/scout/types"
import { api } from "@/lib/tickets/client"
import type { ApiError } from "@/lib/tickets/types"
import { cn } from "@/lib/utils"

/**
 * One Scout research brief (DV-005A). Everything from a source (titles,
 * passages, values) is rendered as plain React text, so it's escaped:
 * retrieved HTML is never injected into the page. External links open in a
 * new tab with noopener/noreferrer and only for http(s) addresses.
 */

const STATUS_TONE: Record<ClaimStatus, string> = {
  supported: "text-status-completed ring-status-completed/35",
  conflicting: "text-status-failed ring-status-failed/40",
  unverified: "text-status-waiting ring-status-waiting/40",
  insufficient_evidence: "text-muted-foreground ring-border",
}

const TOPIC_LABEL: Record<string, string> = {
  price: "price",
  discount: "discount",
  commission: "commission",
  rating: "rating or reviews",
  performance: "performance claim",
  health: "health claim",
  certification: "certification",
  warranty: "warranty",
  delivery: "delivery",
  stock: "stock",
  superiority: "comparative claim",
}

function safeHref(url: string | null) {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null
  } catch {
    return null
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return url.slice(0, 60)
  }
}

function ExternalSource({ source }: { source: ResearchSource }) {
  const href = safeHref(source.finalUrl ?? source.requestedUrl)
  const text = hostOf(source.finalUrl ?? source.requestedUrl)
  if (!href) return <span>{text}</span>
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      referrerPolicy="no-referrer"
      className="inline-flex items-center gap-1 underline decoration-border underline-offset-2 hover:decoration-foreground"
    >
      {text}
      <ExternalLink aria-hidden="true" className="size-3" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  )
}

function ClaimItem({
  claim,
  evidence,
  sources,
}: {
  claim: ResearchClaim
  evidence: Map<string, ResearchEvidence>
  sources: Map<string, ResearchSource>
}) {
  return (
    <li
      className="flex flex-col gap-1 rounded-lg p-2 ring-1 ring-border"
      data-claim-status={claim.status}
      data-claim-origin={claim.origin}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs ring-1 ring-inset",
            STATUS_TONE[claim.status],
          )}
        >
          {CLAIM_STATUS_LABEL[claim.status]}
        </span>
        <span className="text-xs text-muted-foreground">
          {claim.origin === "owner" ? "Your claim" : "From the sources"}
        </span>
        {claim.topic ? (
          <span className="rounded-full px-2 py-0.5 text-xs text-status-waiting ring-1 ring-status-waiting/40 ring-inset">
            Sensitive: {TOPIC_LABEL[claim.topic] ?? claim.topic}
          </span>
        ) : null}
        {claim.timeSensitive ? (
          <span className="rounded-full px-2 py-0.5 text-xs text-muted-foreground ring-1 ring-border ring-inset">
            Time-sensitive
          </span>
        ) : null}
      </div>
      <p className="text-sm font-medium break-words">{claim.statement}</p>
      <p className="text-xs break-words text-muted-foreground">
        {claim.reason}
      </p>
      {claim.evidence.length > 0 ? (
        <ul aria-label="Evidence" className="flex flex-col gap-1">
          {claim.evidence.map((link) => {
            const e = evidence.get(link.key)
            const s = e ? sources.get(e.sourceKey) : undefined
            return (
              <li
                key={link.key}
                data-evidence-key={link.key}
                data-relationship={link.relationship}
                className="rounded-md bg-surface-sunken p-2 text-xs"
              >
                <p className="font-medium">
                  {link.key} ·{" "}
                  {link.relationship === "supports"
                    ? "supports"
                    : link.relationship === "contradicts"
                      ? "contradicts"
                      : "context"}
                  {s ? (
                    <>
                      {" "}
                      · {s.key} <ExternalSource source={s} />
                    </>
                  ) : null}
                </p>
                {e ? (
                  <>
                    <blockquote className="mt-1 border-l-2 border-border pl-2 break-words whitespace-pre-wrap">
                      {e.passage}
                    </blockquote>
                    <p className="mt-1 text-muted-foreground">
                      {e.location} ·{" "}
                      {e.method === "ollama"
                        ? `proposed by local model ${e.model ?? ""}, quote checked`
                        : e.method}
                    </p>
                  </>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </li>
  )
}

export function ResearchReportView({
  ticketId,
  runId,
  snapshotId,
}: {
  ticketId: string
  runId: string
  snapshotId: string
}) {
  const [report, setReport] = useState<ResearchReport | null>(null)
  const [evidence, setEvidence] = useState<ResearchEvidence[]>([])
  const [error, setError] = useState<ApiError | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const all: ResearchEvidence[] = []
      let first: ResearchReport | null = null
      // Evidence comes in pages of ≤ 100; a brief has at most 150.
      for (let offset = 0, pages = 0; pages < 5; pages++) {
        const result = await api<ResearchReport>(
          `${reportEndpoint(ticketId, runId, snapshotId)}?evidenceOffset=${offset}&evidenceLimit=100`,
        )
        if (cancelled) return
        if (!result.ok) {
          setError(result.error)
          return
        }
        first ??= result.data
        all.push(...result.data.evidence.items)
        offset += result.data.evidence.items.length
        if (
          offset >= result.data.evidence.total ||
          result.data.evidence.items.length === 0
        )
          break
      }
      setReport(first)
      setEvidence(all)
    })()
    return () => {
      cancelled = true
    }
  }, [ticketId, runId, snapshotId])

  if (error)
    return (
      <FormMessage>
        <p className="font-semibold">Couldn&apos;t load this research brief.</p>
        <p className="mt-1">{error.message}</p>
      </FormMessage>
    )
  if (!report)
    return (
      <p
        role="status"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <LoaderCircle
          aria-hidden="true"
          className="size-4 animate-spin motion-reduce:animate-none"
        />
        Loading the research brief…
      </p>
    )

  const evidenceByKey = new Map(evidence.map((e) => [e.key, e]))
  const sourceByKey = new Map(report.sources.map((s) => [s.key, s]))
  const claimByKey = new Map(report.claims.map((c) => [c.key, c]))
  const b = report.brief
  const group = (
    title: string,
    keys: string[],
    testId: string,
    empty: string,
  ) => (
    <section
      aria-label={title}
      data-testid={testId}
      className="flex flex-col gap-2"
    >
      <h5 className="text-sm font-semibold">
        {title} ({keys.length})
      </h5>
      {keys.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {keys.map((k) => {
            const c = claimByKey.get(k)
            return c ? (
              <ClaimItem
                key={k}
                claim={c}
                evidence={evidenceByKey}
                sources={sourceByKey}
              />
            ) : null
          })}
        </ul>
      )}
    </section>
  )

  return (
    <div
      className="flex flex-col gap-4"
      data-testid="research-report"
      data-report-status={report.status}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          Version {report.reportVersion} · {formatDate(report.createdAt)} ·{" "}
          {b.extraction.mode === "deterministic"
            ? "deterministic extraction (no AI model)"
            : `deterministic + local model ${b.extraction.model?.name ?? ""}`}
        </span>
        <span
          data-testid="report-integrity"
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 ring-1 ring-inset",
            report.integrity === "verified"
              ? "text-status-completed ring-status-completed/35"
              : "text-status-failed ring-status-failed/40",
          )}
        >
          {report.integrity === "verified" ? (
            <ShieldCheck aria-hidden="true" className="size-3" />
          ) : (
            <ShieldAlert aria-hidden="true" className="size-3" />
          )}
          {report.integrity === "verified"
            ? "Checksum verified"
            : "Checksum mismatch"}
        </span>
      </div>
      <p className="text-sm">
        {b.product.identification === "identified"
          ? `Identified as “${b.product.identifiedAs ?? b.product.name}”.`
          : `Scout couldn't confirm any source describes “${b.product.name}”.`}
        {b.status === "insufficient_evidence"
          ? " There isn't enough evidence for a complete brief."
          : ""}
      </p>
      {b.product.identifiers.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {b.product.identifiers
            .map((i) => `${i.label}: ${i.value} (${i.evidence.join(", ")})`)
            .join(" · ")}
        </p>
      ) : null}

      {group(
        "Conflicting information",
        b.conflicts,
        "research-conflicts",
        "No conflicts found.",
      )}
      {group(
        "Supported facts",
        b.supportedFacts,
        "research-supported",
        "Nothing could be confirmed from the sources.",
      )}
      {group(
        "Your unverified claims",
        b.unverifiedOwnerClaims,
        "research-unverified",
        "Every claim you made was checked against a source.",
      )}
      {b.insufficient.length > 0
        ? group(
            "Insufficient evidence",
            b.insufficient,
            "research-insufficient",
            "",
          )
        : null}

      <section
        aria-label="Factual selling points"
        className="flex flex-col gap-1"
      >
        <h5 className="text-sm font-semibold">
          Factually supportable points ({b.sellingPoints.length})
        </h5>
        <p className="text-xs text-muted-foreground">
          Facts Quill may build on, each backed by a source. Not marketing copy.
        </p>
        {b.sellingPoints.length > 0 ? (
          <ul className="list-disc pl-5 text-sm">
            {b.sellingPoints.map((p) => (
              <li key={p.claims.join(",")} className="break-words">
                {p.text}{" "}
                <span className="text-xs text-muted-foreground">
                  ({p.basis}; {p.claims.join(", ")})
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">None yet.</p>
        )}
      </section>

      {b.timeSensitive.length > 0 ? (
        <section
          aria-label="Time-sensitive information"
          className="flex flex-col gap-1"
        >
          <h5 className="text-sm font-semibold">
            Time-sensitive (as retrieved)
          </h5>
          <ul className="list-disc pl-5 text-sm">
            {b.timeSensitive.map((t) => (
              <li key={t.claim} className="break-words">
                {claimByKey.get(t.claim)?.statement}{" "}
                <span className="text-xs text-muted-foreground">
                  (as of {formatDate(t.retrievedAt)}; may have changed)
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Limitations" className="flex flex-col gap-1">
        <h5 className="text-sm font-semibold">Limitations</h5>
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          {b.limitations.map((l) => (
            <li key={l} className="break-words">
              {l}
            </li>
          ))}
        </ul>
      </section>
      {b.ownerActions.length > 0 ? (
        <section
          aria-label="What you can do"
          data-testid="research-actions"
          className="flex flex-col gap-1"
        >
          <h5 className="text-sm font-semibold">What you can do</h5>
          <ul className="list-disc pl-5 text-xs">
            {b.ownerActions.map((a) => (
              <li key={a} className="break-words">
                {a}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Sources" className="flex flex-col gap-1">
        <h5 className="text-sm font-semibold">
          Sources ({report.sources.length})
        </h5>
        <ul className="flex flex-col gap-1" data-testid="research-sources">
          {report.sources.map((s) => (
            <li
              key={s.key}
              data-source-outcome={s.outcome}
              className="flex flex-col rounded-md p-2 text-xs ring-1 ring-border"
            >
              <span className="font-medium break-words">
                {s.key} <ExternalSource source={s} /> ·{" "}
                {SOURCE_TRUST_LABEL[s.trust]}
              </span>
              <span className="break-words text-muted-foreground">
                {SOURCE_OUTCOME_LABEL[s.outcome]}
                {s.httpStatus ? ` · HTTP ${s.httpStatus}` : ""}
                {s.retrievedAt
                  ? ` · retrieved ${formatDate(s.retrievedAt)}`
                  : ""}
                {s.contentSha256
                  ? ` · sha256 ${s.contentSha256.slice(0, 12)}…`
                  : ""}
                {s.transport === "http" ? " · not encrypted (http)" : ""}
              </span>
              {s.title ? (
                <span className="break-words">“{s.title}”</span>
              ) : null}
              {s.detail ? (
                <span className="break-words text-muted-foreground">
                  {s.detail}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
