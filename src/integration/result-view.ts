/**
 * Explicit, bounded, paged retrieval of stored results. Never runs a query,
 * refreshes paid work or writes state.
 */
import type { AdvisorResult, EvidenceRecord, ResultSection } from "../contracts.ts";

type Stored = { result: AdvisorResult; answer: string; evidence: Array<EvidenceRecord & { excerpt?: string }> };

export function renderSection(stored: Stored, section: ResultSection | "full"): string {
  const { result, evidence } = stored;
  const a = result.answer;
  const head = `WAI Advisor result ${result.requestId} [${result.state}] — historical record from ${result.completedAt}; not current evidence.`;
  switch (section) {
    case "full":
      return stored.answer || `${head}\n(no ANSWER.md)`;
    case "summary":
      return [
        head,
        `Recommendation: ${a?.recommendation ?? "(none)"}`,
        a ? `Basis: ${a.basis}` : "",
        a?.rationale ? `Rationale: ${a.rationale}` : "",
        result.warnings.length ? `Warnings:\n${result.warnings.map((w) => `- ${w}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    case "recommendations": {
      if (!a) return `${head}\nNo answer was produced.`;
      const parts = [head, `Recommendation: ${a.recommendation}`];
      if (a.suggestedFix) parts.push(`Suggested fix (not applied): ${a.suggestedFix}`);
      if (a.alternatives?.length) parts.push(`Alternatives:\n${a.alternatives.map((x) => `- ${x}`).join("\n")}`);
      if (a.verificationSuggestions.length) parts.push(`Suggested verification (not executed):\n${a.verificationSuggestions.map((x) => `- ${x}`).join("\n")}`);
      if (a.humanDecisions.length) parts.push(`Human decisions:\n${a.humanDecisions.map((d) => `- ${d.question}\n  recommendation: ${d.recommendation}\n  impact: ${d.impact}`).join("\n")}`);
      if (a.risks.length) parts.push(`Risks:\n${a.risks.map((x) => `- ${x}`).join("\n")}`);
      return parts.join("\n");
    }
    case "evidence": {
      const cited = new Set(a?.citations.map((c) => c.evidenceId) ?? []);
      const lines = [head, "Evidence (bounded, redacted excerpts; the index is not a source archive):"];
      for (const e of evidence) {
        lines.push(
          `[${e.id}]${cited.has(e.id) ? " (cited)" : ""} ${e.kind} ${e.path ?? ""}${e.startLine !== undefined ? `:${e.startLine}-${e.endLine}` : ""} ${e.label && e.kind !== "source_range" ? `(${e.label}) ` : ""}[${e.provenance}${e.truncated ? ", truncated" : ""}] ${e.error ? `ERROR ${e.error.code}: ${e.error.message}` : `sha256 ${e.digest.slice(0, 16)}…`}`,
        );
        if (!e.error && e.excerpt) lines.push(e.excerpt);
      }
      if (a?.citations.length) lines.push("Citations:", ...a.citations.map((c) => `- ${c.evidenceId} [${c.support}]${c.startLine ? ` lines ${c.startLine}-${c.endLine ?? c.startLine}` : ""}: ${c.claim}`));
      return lines.join("\n");
    }
    case "limits": {
      const u = result.usage;
      return [
        head,
        `Authority: none; delivery verified: false. The advisor ran no tests or commands.`,
        `Freshness: ${result.freshness.scope}${result.freshness.checkedAt ? ` at ${result.freshness.checkedAt}` : ""}; changed: ${result.freshness.changedEvidenceIds.join(", ") || "none"}; not rechecked: ${result.freshness.unavailableEvidenceIds.join(", ") || "none"}. Changes outside cited ranges are not detected.`,
        a?.missingEvidence.length ? `Missing evidence:\n${a.missingEvidence.map((m) => `- ${m}`).join("\n")}` : "",
        result.limitsHit.length ? `Limits reached: ${result.limitsHit.join(", ")}` : "",
        `Usage: ${u.modelCalls} model call(s), ${u.evidenceRequests} evidence request(s), ~${u.estimatedInputTokens} estimated input tokens; reported in/out ${u.actualInputTokens ?? "unknown"}/${u.actualOutputTokens ?? "unknown"}; cost ${u.costUsd === null ? "unknown" : `$${u.costUsd} (${u.costBasis})`}.`,
        result.warnings.length ? `Warnings:\n${result.warnings.map((w) => `- ${w}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
  }
}

export function pageText(text: string, cursor: number, maxChars: number): { page: string; nextCursor: number | null } {
  const start = Math.min(Math.max(0, cursor), text.length);
  const budget = Math.max(200, maxChars - 160);
  let end = Math.min(text.length, start + budget);
  if (end < text.length) {
    const nl = text.lastIndexOf("\n", end);
    if (nl > start + budget / 2) end = nl + 1;
  }
  return { page: text.slice(start, end), nextCursor: end < text.length ? end : null };
}
