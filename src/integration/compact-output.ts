/**
 * Short, bounded return for the main agent / human. The combined serialized size of
 * every model-visible channel (text content + details; no structuredContent is
 * declared) is kept within maxReturnChars. The investigation archive stays on disk.
 */
import type { AdvisorRequest, AdvisorResult, CompactEnvelope } from "../contracts.ts";
import type { EvidenceLedger } from "../evidence/ledger.ts";

export const STANDING_LIMIT = "Advice only: the advisor ran no tests or commands and has no authority to approve, set PASS or certify delivery.";

export interface CompactInput {
  result: AdvisorResult;
  request: Pick<AdvisorRequest, "requestId" | "mode">;
  ledger: EvidenceLedger | null;
  resultPath: string | null;
  /** Reason when no answer exists. */
  reason?: string;
  /** Extra limits (e.g. persistence failure) that must be visible. */
  extraLimits?: string[];
  audience: "tool" | "command";
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`;
}

export function buildEnvelope(input: CompactInput, adviceMax = 1200, citationMax = 8, limitMax = 6): CompactEnvelope {
  const { result, ledger } = input;
  const answer = result.answer;
  const citations = (answer?.citations ?? [])
    .map((c) => {
      const r = ledger?.get(c.evidenceId)?.record;
      return { evidenceId: c.evidenceId, path: r?.path ?? r?.label ?? r?.kind ?? "?", ...(c.startLine ? { startLine: c.startLine } : {}), ...(c.endLine ? { endLine: c.endLine } : {}) };
    })
    .slice(0, citationMax);
  const limits: string[] = [];
  if (input.reason) limits.push(input.reason);
  for (const w of result.warnings) if (/^(Stale|Partial|Interrupted|Advice text uses)/.test(w)) limits.push(w);
  const omitted = result.warnings.filter((w) => w.startsWith("Evidence text omitted"));
  if (omitted.length) limits.push(`Context: some evidence text did not fit the per-call budget (${omitted.length} call(s)); citations to omitted text are rejected.`);
  limits.push(...(input.extraLimits ?? []));
  for (const missing of answer?.missingEvidence ?? []) limits.push(`Missing evidence: ${missing}`);
  if (result.limitsHit.length) limits.push(`Limits reached: ${result.limitsHit.join(", ")}.`);
  if (input.request.mode === "quick") limits.push("Quick mode: no project source was inspected (general reasoning / caller-supplied context only).");
  else if (answer?.basis === "general_reasoning") limits.push("Basis: general reasoning, not source citations.");
  const decisions = answer?.humanDecisions ?? [];
  const recommendation = answer ? answer.recommendation : `No advisor conclusion (${result.state}).`;
  // Decisions get their own budget and the count comes first, so clipping can never hide them.
  const recBudget = decisions.length ? Math.max(40, Math.floor(adviceMax * 0.55)) : adviceMax;
  let advice = clip(recommendation, recBudget);
  if (decisions.length) {
    const shown = decisions.slice(0, 3);
    const per = Math.max(30, Math.floor((adviceMax - recBudget) / shown.length / 2) - 20);
    const count = decisions.length > 3 ? `${decisions.length} (3 shown; ${decisions.length - 3} more in the detailed result)` : String(decisions.length);
    advice += ` Human decisions needed: ${count}: ${shown.map((d) => `${clip(d.question, per)} → recommended: ${clip(d.recommendation, per)}`).join("; ")}`;
  }
  return {
    requestId: result.requestId,
    state: result.state,
    advice,
    citations,
    limits: [...limits.map((l) => clip(l, 300)).slice(0, limitMax), STANDING_LIMIT],
    resultPath: input.resultPath,
  };
}

export function renderEnvelope(envelope: CompactEnvelope, audience: "tool" | "command"): string {
  const lines = [`WAI Advisor [${envelope.state}] request ${envelope.requestId}`, `Advice: ${envelope.advice}`];
  if (envelope.citations.length) {
    lines.push(
      `Evidence: ${envelope.citations
        .map((c) => `${c.evidenceId} ${c.path}${c.startLine ? `:${c.startLine}${c.endLine && c.endLine !== c.startLine ? `-${c.endLine}` : ""}` : ""}`)
        .join("; ")}`,
    );
  }
  lines.push("Limits:", ...envelope.limits.map((l) => `- ${l}`));
  if (envelope.resultPath) {
    lines.push(
      audience === "tool"
        ? `Detailed result: ${envelope.resultPath} (page it with wai_advisor_result; verify cited code before adopting advice).`
        : `Detailed result: ${envelope.resultPath} (/wai-advisor-result ${envelope.requestId} --full).`,
    );
  } else lines.push("Detailed result: not saved.");
  return lines.join("\n");
}

export interface CompactReturn {
  text: string;
  details: { requestId: string; state: string; resultPath: string | null };
  envelope: CompactEnvelope;
  /** Serialized size of all returned channels. */
  size: number;
}

export function returnSize(text: string, details: unknown): number {
  return JSON.stringify({ content: [{ type: "text", text }], details }).length;
}

/** Shrink advice/citations/limits until every channel together fits maxReturnChars. */
export function compactReturn(input: CompactInput, maxReturnChars: number): CompactReturn {
  const attempts: Array<[number, number, number]> = [
    [1200, 8, 6],
    [800, 6, 5],
    [500, 4, 4],
    [300, 3, 3],
    [180, 2, 2],
    [100, 1, 1],
    [60, 0, 1],
  ];
  for (const [adviceMax, citationMax, limitMax] of attempts) {
    const envelope = buildEnvelope(input, adviceMax, citationMax, limitMax);
    const text = renderEnvelope(envelope, input.audience);
    const details = { requestId: envelope.requestId, state: envelope.state, resultPath: envelope.resultPath };
    const size = returnSize(text, details);
    if (size <= maxReturnChars) return { text, details, envelope, size };
  }
  // Last resort: hard cut of the text, keeping identity and the standing limit.
  const envelope = buildEnvelope(input, 40, 0, 1);
  const details = { requestId: envelope.requestId, state: envelope.state, resultPath: envelope.resultPath };
  // Cut until the *serialized* size fits (JSON escaping can expand quotes, backslashes, newlines).
  const full = renderEnvelope(envelope, input.audience);
  let text = full;
  let keep = full.length;
  while (keep > 0 && returnSize(text, details) > maxReturnChars) {
    keep = Math.max(0, keep - Math.max(1, returnSize(text, details) - maxReturnChars));
    text = `${full.slice(0, keep)}…`;
  }
  return { text, details, envelope, size: returnSize(text, details) };
}

/** Bounded human-readable detailed report (ANSWER.md). */
export function renderAnswerMarkdown(result: AdvisorResult, request: AdvisorRequest, ledger: EvidenceLedger | null, reason?: string): string {
  const a = result.answer;
  const out: string[] = [
    `# WAI Advisor — ${result.requestId}`,
    "",
    `- State: **${result.state}** (consultation state only; not code completion, approval or PASS)`,
    `- Mode: ${request.mode}; model: ${result.model.provider}/${result.model.id}${result.model.effort ? ` (${result.model.effort})` : ""}`,
    `- Started: ${result.startedAt}; completed: ${result.completedAt}`,
    `- Authority: none; delivery verified: false`,
    "",
    "## Question",
    "",
    request.question,
    "",
  ];
  if (request.constraints.length) out.push("## Constraints", "", ...request.constraints.map((c) => `- ${c}`), "");
  if (reason) out.push("## Outcome", "", reason, "");
  if (a) {
    out.push("## Recommendation", "", a.recommendation, "", "## Rationale", "", a.rationale || "(none)", "", `Basis: ${a.basis}`, "");
    if (a.suggestedFix) out.push("## Suggested fix (not applied)", "", a.suggestedFix, "");
    if (a.citations.length) {
      out.push("## Citations", "");
      for (const c of a.citations) {
        const r = ledger?.get(c.evidenceId)?.record;
        out.push(`- ${c.evidenceId} [${c.support}] ${r?.path ?? r?.label ?? ""}${c.startLine ? `:${c.startLine}-${c.endLine ?? c.startLine}` : ""} — ${c.claim}`);
      }
      out.push("");
    }
    const list = (title: string, items: readonly string[] | undefined) => {
      if (items?.length) out.push(`## ${title}`, "", ...items.map((i) => `- ${i}`), "");
    };
    list("Alternatives", a.alternatives);
    list("Risks", a.risks);
    list("Missing evidence", a.missingEvidence);
    list("Suggested verification (proposals; not executed)", a.verificationSuggestions);
    if (a.humanDecisions.length) {
      out.push("## Human decisions", "");
      for (const d of a.humanDecisions) out.push(`- ${d.question}\n  - Recommendation: ${d.recommendation}\n  - Impact: ${d.impact}`);
      out.push("");
    }
  }
  out.push("## Freshness", "", `Scope: ${result.freshness.scope}${result.freshness.checkedAt ? ` (checked ${result.freshness.checkedAt})` : ""}. Changes outside cited ranges or in unread files are not detected.`);
  if (result.freshness.changedEvidenceIds.length) out.push(`Changed: ${result.freshness.changedEvidenceIds.join(", ")}`);
  if (result.freshness.unavailableEvidenceIds.length) out.push(`Not rechecked: ${result.freshness.unavailableEvidenceIds.join(", ")}`);
  out.push("");
  if (ledger?.all().length) {
    out.push("## Evidence ledger", "");
    for (const e of ledger.all()) {
      const r = e.record;
      out.push(
        `- ${r.id} ${r.kind} ${r.path ?? ""}${r.startLine !== undefined ? `:${r.startLine}-${r.endLine}` : ""} ${r.label && r.kind !== "source_range" ? `(${r.label}) ` : ""}[${r.provenance}${r.truncated ? ", truncated" : ""}] ${r.error ? `ERROR ${r.error.code}: ${r.error.message}` : `sha256 ${r.digest.slice(0, 16)}…`}`,
      );
    }
    out.push("");
  }
  const u = result.usage;
  out.push(
    "## Usage",
    "",
    `- Model calls: ${u.modelCalls}; evidence requests: ${u.evidenceRequests}`,
    `- Estimated input tokens: ${u.estimatedInputTokens} (estimate); reported input/output: ${u.actualInputTokens ?? "unknown"}/${u.actualOutputTokens ?? "unknown"}; cached input: ${u.cachedInputTokens ?? "unknown"}`,
    `- Cost: ${u.costUsd === null ? "unknown" : `$${u.costUsd} (${u.costBasis}, from catalog prices; not a billing statement)`}`,
    "",
  );
  if (result.limitsHit.length) out.push(`Limits reached: ${result.limitsHit.join(", ")}`, "");
  if (result.warnings.length) out.push("## Warnings", "", ...result.warnings.map((w) => `- ${w}`), "");
  out.push(STANDING_LIMIT, "");
  return out.join("\n");
}
