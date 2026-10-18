/**
 * Citation validation: IDs must be broker-minted for this request, successful, of
 * the right provenance for the declared support, and line references must lie within
 * the returned range (or on a returned search hit). This proves reference
 * consistency only, not that the model's interpretation is correct.
 */
import type { AdvisorAnswerDraft, AdvisorMode, Citation } from "../contracts.ts";
import type { EvidenceLedger } from "../evidence/ledger.ts";

export interface ValidatedAnswer {
  answer: AdvisorAnswerDraft;
  rejected: Array<{ citation: Citation; reason: string }>;
  validHostCitations: number;
  warnings: string[];
}

const AUTHORITY_LANGUAGE = /\b(all tests (?:pass|passed)|tests? (?:pass(?:ed|es)?|are passing|succeeded)|verdict:\s*pass|\bPASS\b|approved?\b|LGTM|certif(?:y|ied)|ready to (?:ship|merge|deploy))/;

function checkCitation(citation: Citation, ledger: EvidenceLedger, omitted: ReadonlySet<string>): string | null {
  const entry = ledger.get(citation.evidenceId);
  if (!entry) return "unknown evidence ID (not minted for this request)";
  const r = entry.record;
  if (r.error) return `evidence ${r.id} is a failed request`;
  // Each model call is stateless: evidence whose text was cut from the answering call was not seen.
  if (omitted.has(r.id)) return `evidence ${r.id} text was omitted from the answering call to fit the budget`;
  const caller = r.provenance === "caller_supplied";
  if (citation.support === "caller_report" && !caller) return "caller_report must cite caller-supplied evidence";
  if (citation.support === "direct_observation" && caller) return "caller-supplied evidence cannot be a direct observation";
  const { startLine, endLine } = citation;
  if (startLine === undefined && endLine === undefined) return null;
  const start = startLine ?? endLine ?? 0;
  const end = endLine ?? startLine ?? 0;
  if (end < start) return "endLine is before startLine";
  if (r.kind === "source_range") {
    if (r.startLine === undefined || r.endLine === undefined || start < r.startLine || end > r.endLine)
      return `lines ${start}-${end} are outside the returned range ${r.startLine}-${r.endLine}`;
    return null;
  }
  if (r.kind === "search_hits") {
    if (!entry.hits?.some((hit) => hit.line >= start && hit.line <= end)) return `no returned search hit lies on lines ${start}-${end}`;
    return null;
  }
  if (caller) return null;
  return "line numbers are not meaningful for this evidence kind";
}

export function validateAnswer(draft: AdvisorAnswerDraft, ledger: EvidenceLedger, mode: AdvisorMode, omitted: ReadonlySet<string> = new Set()): ValidatedAnswer {
  const rejected: ValidatedAnswer["rejected"] = [];
  const kept: Citation[] = [];
  for (const citation of draft.citations) {
    const reason = checkCitation(citation, ledger, omitted);
    if (reason) rejected.push({ citation, reason });
    else kept.push(citation);
  }
  const warnings: string[] = [];
  const validHostCitations = kept.filter((c) => ledger.get(c.evidenceId)?.record.provenance === "host_observed").length;
  let basis = draft.basis;
  if (mode === "quick" && basis !== "general_reasoning") {
    basis = kept.length ? "mixed" : "general_reasoning";
    if (draft.basis === "source_backed") warnings.push("Quick mode inspected no project source; the basis was relabelled.");
  }
  if (basis === "source_backed" && validHostCitations === 0) {
    basis = kept.length ? "mixed" : "general_reasoning";
    warnings.push("The answer claimed to be source-backed but has no valid host-observed citations; basis relabelled.");
  }
  if (rejected.length) warnings.push(`${rejected.length} citation(s) rejected: ${rejected.map((r) => `${r.citation.evidenceId} (${r.reason})`).join("; ").slice(0, 400)}`);
  const allText = [draft.recommendation, draft.rationale, draft.suggestedFix ?? "", ...draft.verificationSuggestions].join("\n");
  if (AUTHORITY_LANGUAGE.test(allText))
    warnings.push("Advice text uses pass/approval language; the advisor executed no tests and has no approval authority.");
  return { answer: { ...draft, basis, citations: kept }, rejected, validHostCitations, warnings };
}
