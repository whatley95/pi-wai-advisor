/**
 * Advisor engine: bounded evidence-or-answer loop.
 *
 * - Model calls are sequential; every attempt (retry, repair, synthesis) is counted.
 * - A final-answer opportunity is reserved: the last call must answer.
 * - Evidence capacity is reserved for freshness rechecks of cited ranges.
 * - If synthesis cannot run within limits, a local partial result preserves evidence.
 */
import type { AdvisorAnswerDraft, AdvisorRequest, Freshness, ResultState, Usage } from "../contracts.ts";
import { AbortedError, type BrokerRequest, type BrokerResult, type EvidenceBroker } from "../evidence/broker.ts";
import { planDiscovery } from "../evidence/discovery.ts";
import type { EvidenceLedger } from "../evidence/ledger.ts";
import type { ModelAdapter, ModelCallResult, ModelUsage } from "../model/adapter.ts";
import { validateAnswer } from "./answer-validation.ts";
import type { Budget } from "./budget.ts";
import { selectProfileGuidance } from "./profile.ts";
import { planPrompt } from "./prompt.ts";
import { parseAdvisorTurn } from "./protocol.ts";

export type AbortReason = "cancelled" | "deadline" | "session_changed";

export interface EngineInput {
  request: AdvisorRequest;
  model: ModelAdapter;
  budget: Budget;
  ledger: EvidenceLedger;
  broker: EvidenceBroker;
  signal: AbortSignal;
  abortReason: () => AbortReason | null;
  progress: (message: string) => void;
  historical?: string;
  /** Usage that arrives after the local request finished (cancel/deadline race). */
  onLateUsage?: (usage: ModelUsage | null) => void;
  initialReadLines?: number;
}

export interface EngineOutcome {
  state: ResultState;
  answer: AdvisorAnswerDraft | null;
  warnings: string[];
  limitsHit: string[];
  freshness: Freshness;
  usage: Usage;
  /** Reason shown when no answer was produced. */
  reason?: string;
  profileIds: string[];
  manifestHints: string[];
}

/** Evidence requests held back for final freshness rechecks. */
export function recheckReserve(maxEvidenceRequests: number): number {
  if (maxEvidenceRequests < 2) return 0;
  return Math.min(3, Math.max(1, Math.floor(maxEvidenceRequests / 4)));
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortedError());
      return;
    }
    const onAbort = () => reject(new AbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function describeRequest(request: BrokerRequest): string {
  switch (request.tool) {
    case "read_file":
      return `read_file ${request.path}:${request.startLine}-${request.endLine}`;
    case "search_code":
      return `search_code "${request.query}"${request.path ? ` in ${request.path}` : ""}`;
    case "list_files":
      return `list_files ${request.path || "."}`;
    case "native_diff":
      return "native_diff";
  }
}

export async function runEngine(input: EngineInput): Promise<EngineOutcome> {
  const { request, model, budget, ledger, broker, signal } = input;
  const limits = budget.limits;
  const warnings: string[] = [];
  const notes: string[] = [];
  const turnLog: string[] = [];
  const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, known: true, costKnown: true, any: false };
  const reserve = request.mode === "inspect" ? recheckReserve(limits.maxEvidenceRequests) : 0;
  let manifestHints: string[] = [];
  let skippedForAllowance = false;

  const recordUsage = (usage: ModelUsage | null) => {
    usageTotals.any = true;
    if (!usage) {
      usageTotals.known = false;
      usageTotals.costKnown = false;
      return;
    }
    usageTotals.input += usage.input + usage.cacheRead + usage.cacheWrite;
    usageTotals.output += usage.output;
    usageTotals.cacheRead += usage.cacheRead;
    usageTotals.cacheWrite += usage.cacheWrite;
    if (usage.costUsd === null) usageTotals.costKnown = false;
    else usageTotals.cost += usage.costUsd;
  };

  const finish = (state: ResultState, answer: AdvisorAnswerDraft | null, freshness: Freshness, reason?: string, profileIds: string[] = []): EngineOutcome => ({
    state,
    answer,
    warnings,
    limitsHit: [...budget.limitsHit],
    freshness,
    reason,
    profileIds,
    manifestHints,
    usage: {
      modelCalls: budget.modelCalls,
      evidenceRequests: budget.evidenceRequests,
      estimatedInputTokens: budget.estimatedInputTokens,
      actualInputTokens: usageTotals.any && usageTotals.known ? usageTotals.input : null,
      actualOutputTokens: usageTotals.any && usageTotals.known ? usageTotals.output : null,
      cachedInputTokens: usageTotals.any && usageTotals.known ? usageTotals.cacheRead : null,
      costUsd: usageTotals.any && usageTotals.costKnown ? Number(usageTotals.cost.toFixed(6)) : null,
      costBasis: usageTotals.any && usageTotals.costKnown ? "estimated" : "unknown",
    },
  });
  const notChecked: Freshness = { scope: "not_checked", checkedAt: null, changedEvidenceIds: [], unavailableEvidenceIds: [] };
  const hostEvidenceCount = () => ledger.all().filter((e) => e.record.provenance === "host_observed" && !e.record.error).length;
  const abortOutcome = (profileIds: string[] = []): EngineOutcome => {
    const reason = input.abortReason() ?? "cancelled";
    if (reason === "deadline") {
      budget.limitsHit.add("maxWallTimeMs");
      return finish(hostEvidenceCount() ? "partial" : "failed", null, notChecked, "The wall-time deadline passed before an answer was produced.", profileIds);
    }
    return finish("cancelled", null, notChecked, reason === "session_changed" ? "The Pi session changed; the consultation was cancelled." : "The consultation was cancelled.", profileIds);
  };

  const noteSkipped = (results: BrokerResult[]) => {
    for (const r of results) {
      if (r.kind === "skipped") {
        skippedForAllowance = true;
        notes.push(`Not executed: ${describeRequest(r.request)} — ${r.reason}`);
      }
    }
  };

  try {
    if (request.suppliedEvidence.length) broker.addSupplied(request.suppliedEvidence);

    // ---- Initial discovery (inspect) ---------------------------------------------
    if (request.mode === "inspect") {
      const caps = request.capabilities;
      if (caps.length === 0) {
        return finish(
          "blocked",
          null,
          notChecked,
          "Inspect mode needs permission-checked host read/search/list tools, and none are callable in this context. No local or shell fallback is used. Ask the main agent to call the wai_advisor tool (which runs with Pi's tool permissions), enable the read/grep/find tools, or use --quick for advice without source access.",
        );
      }
      const hasSeedsOrMentions = request.seedPaths.length > 0 || /[\w.-]+\/[\w.-]+\.[A-Za-z0-9]{1,10}/.test(request.question);
      if (!caps.includes("search_code") && !caps.includes("list_files") && !hasSeedsOrMentions) {
        return finish(
          "blocked",
          null,
          notChecked,
          "Only read_file is callable and no seed paths were given, so relevant source cannot be discovered. Provide seed paths (seedPaths / file paths in the question), or have a human enable Pi's grep/find tools (e.g. \"defaultTools\": [\"+grep\", \"+find\", \"+ls\"] in Pi settings, or --tools), or use quick mode. The advisor never enables tools itself.",
        );
      }
      for (const missing of (["read_file", "search_code", "list_files"] as const).filter((c) => !caps.includes(c))) {
        warnings.push(`Host capability ${missing} was not available; investigation coverage is reduced.`);
      }
      const plan = planDiscovery({
        question: request.question,
        constraints: request.constraints,
        seedPaths: request.seedPaths,
        allowance: Math.max(0, budget.remainingEvidence() - reserve - 1),
        canList: caps.includes("list_files"),
        canSearch: caps.includes("search_code"),
        canRead: caps.includes("read_file"),
        initialReadLines: input.initialReadLines ?? 160,
      });
      for (const rejected of plan.rejectedSeeds) notes.push(`Seed not read: ${rejected.path} — ${rejected.reason}`);
      const initial: BrokerRequest[] = [...plan.seedReads, ...(plan.manifestListing ? [plan.manifestListing] : []), ...plan.searches];
      if (initial.length) {
        input.progress("discovering relevant source");
        const results = await broker.executeBatch(initial, reserve);
        noteSkipped(results);
        turnLog.push(`initial discovery: ${results.map((r) => (r.kind === "evidence" ? `${describeRequest(r.request)} → ${r.entry.record.id}` : `${describeRequest(r.request)} (skipped)`)).join("; ")}`);
        const manifest = results.find((r) => r.kind === "evidence" && r.request.tool === "list_files" && "pattern" in r.request && r.request.pattern);
        if (manifest && manifest.kind === "evidence") manifestHints = (manifest.entry.paths ?? []).slice(0, 40);
      }
    }
    const profile = request.mode === "inspect" ? selectProfileGuidance(`${request.question}\n${request.constraints.join("\n")}`, manifestHints) : { ids: [], text: "" };

    // ---- Model loop ------------------------------------------------------------
    let consecutiveInvalid = 0;
    let validated: ReturnType<typeof validateAnswer> | null = null;
    let failure: string | null = null;
    let unaffordable: string | null = null;
    /** Evidence whose text was cut from the most recent call (the model never saw it). */
    let omittedInCall: ReadonlySet<string> = new Set();

    for (;;) {
      if (signal.aborted) return abortOutcome(profile.ids);
      const callsLeft = budget.remainingModelCalls();
      if (callsLeft <= 0) {
        budget.limitsHit.add("maxModelCalls");
        unaffordable = "All model calls were used before an answer was produced.";
        break;
      }
      const finalCall = callsLeft === 1;
      const evidenceLeft = request.mode === "inspect" ? Math.max(0, budget.remainingEvidence() - reserve) : 0;
      const cumulativeLeft = limits.maxCumulativeInputTokens - budget.estimatedInputTokens;
      const planned = planPrompt(
        {
          requestId: request.requestId,
          mode: request.mode,
          question: request.question,
          constraints: request.constraints,
          capabilities: request.mode === "inspect" ? request.capabilities.filter((c) => c !== "native_diff") : [],
          callNumber: budget.modelCalls + 1,
          maxCalls: limits.maxModelCalls,
          evidenceLeft,
          evidenceReserved: request.mode === "inspect" ? Math.min(reserve, budget.remainingEvidence()) : 0,
          finalCall,
          profileGuidance: profile.text,
          manifestHints,
          notes: evidenceLeft === 0 && request.mode === "inspect" ? [...notes, "No evidence requests remain: answer now with the evidence you have and list what is missing."] : notes,
          turnLog,
          evidence: ledger.all(),
          historical: input.historical,
        },
        Math.min(budget.perCallInputTokens, cumulativeLeft),
        limits.maxSerializedRequestBytes,
      );
      notes.length = 0;
      if (!planned) {
        budget.limitsHit.add(cumulativeLeft < budget.perCallInputTokens ? "maxCumulativeInputTokens" : "maxInputTokens");
        unaffordable = "The next model call could not fit within the per-call/cumulative input or serialized-size limits.";
        break;
      }
      if (planned.omittedEvidenceIds.length) warnings.push(`Evidence text omitted from call ${budget.modelCalls + 1} to fit the context budget: ${planned.omittedEvidenceIds.join(", ")}.`);
      omittedInCall = new Set(planned.omittedEvidenceIds);
      const admission = budget.reserveModelCall(planned.serialized, planned.estimatedTokens);
      if (!admission.ok) {
        unaffordable = admission.reason;
        break;
      }
      input.progress(`advisor model call ${budget.modelCalls}/${limits.maxModelCalls}${finalCall ? " (final)" : ""}`);
      const pending = model.call({ system: planned.system, user: planned.user, maxOutputTokens: budget.outputTokens, signal });
      let result: ModelCallResult;
      try {
        result = await raceAbort(pending, signal);
      } catch (error) {
        if (error instanceof AbortedError || signal.aborted) {
          pending.then(
            (late) => input.onLateUsage?.(late.usage),
            () => input.onLateUsage?.(null),
          );
          recordUsage(null);
          return abortOutcome(profile.ids);
        }
        throw error;
      }
      recordUsage(result.usage);
      if (!result.ok) {
        if (result.aborted || signal.aborted) return abortOutcome(profile.ids);
        if (result.transient && request.mode === "inspect" && budget.remainingModelCalls() >= 2 && !budget.expired()) {
          warnings.push(`A model attempt failed transiently and was retried (counted): ${result.error.slice(0, 160)}`);
          continue;
        }
        failure = `Model call failed: ${result.error}`;
        break;
      }
      const parsed = result.truncated
        ? ({ ok: false, reason: `The reply was cut off at the output cap (${budget.outputTokens} tokens); answer more concisely.` } as const)
        : parseAdvisorTurn(result.text);
      if (!parsed.ok) {
        consecutiveInvalid++;
        if (request.mode === "quick" || consecutiveInvalid >= 2 || budget.remainingModelCalls() === 0) {
          failure = `The advisor reply did not follow the protocol: ${parsed.reason}`;
          break;
        }
        warnings.push(`A malformed advisor reply was rejected and one repair attempt was made (counted): ${parsed.reason}`);
        notes.push(`Your previous reply was rejected: ${parsed.reason} Reply with exactly one valid JSON object.`);
        continue;
      }
      consecutiveInvalid = 0;
      const turn = parsed.turn;
      if (turn.type === "evidence") {
        if (request.mode === "quick" || finalCall) {
          unaffordable = finalCall ? "The advisor requested more evidence on its final allowed call instead of answering." : "Quick mode has no source tools.";
          budget.limitsHit.add("maxModelCalls");
          break;
        }
        const usable = turn.requests.slice(0, Math.max(0, budget.remainingEvidence() - reserve));
        for (const dropped of turn.requests.slice(usable.length)) {
          skippedForAllowance = true;
          budget.limitsHit.add("maxEvidenceRequests");
          notes.push(`Not executed: ${describeRequest(dropped)} — no evidence-request allowance remains.`);
        }
        if (usable.length === 0) {
          turnLog.push(`call ${budget.modelCalls}: requested ${turn.requests.map(describeRequest).join("; ")} (none executed: allowance exhausted)`);
          continue;
        }
        const results = await broker.executeBatch(usable, reserve);
        noteSkipped(results);
        turnLog.push(
          `call ${budget.modelCalls}: ${results.map((r) => (r.kind === "evidence" ? `${describeRequest(r.request)} → ${r.entry.record.id}${r.reused ? " (unchanged, reused)" : ""}${r.entry.record.error ? " (failed)" : ""}` : `${describeRequest(r.request)} (skipped)`)).join("; ")}`,
        );
        continue;
      }
      validated = validateAnswer(turn.answer, ledger, request.mode, omittedInCall);
      break;
    }

    if (!validated) {
      if (failure) return finish("failed", null, notChecked, failure, profile.ids);
      const evidence = hostEvidenceCount();
      return finish(
        evidence ? "partial" : "blocked",
        null,
        notChecked,
        `${unaffordable ?? "No answer was produced."} No advisor conclusion was produced${evidence ? `; ${evidence} evidence item(s) were gathered and are listed in the detailed result` : ""}.`,
        profile.ids,
      );
    }

    // ---- Validation, state and freshness ----------------------------------------
    warnings.push(...validated.warnings);
    const answer = validated.answer;
    let state: ResultState = "completed";
    const reasons: string[] = [];
    if (answer.missingEvidence.length) reasons.push("the advisor reported missing evidence");
    if (skippedForAllowance) reasons.push("some requested evidence was not executed within the allowance");
    if (validated.rejected.length && answer.basis !== "general_reasoning") reasons.push("some citations were rejected");
    if (request.mode === "inspect" && hostEvidenceCount() === 0) reasons.push("no project source was successfully inspected");
    if (request.mode === "inspect" && validated.validHostCitations === 0 && validated.rejected.length > 0) reasons.push("no valid source citations remain");
    if (reasons.length) {
      state = "partial";
      warnings.push(`Partial: ${reasons.join("; ")}.`);
    }

    let freshness: Freshness = notChecked;
    const cited = [...new Set(answer.citations.map((c) => c.evidenceId))].filter((id) => ledger.get(id)?.record.provenance === "host_observed");
    if (request.mode === "inspect" && cited.length) {
      if (signal.aborted && input.abortReason() !== "deadline") return abortOutcome(profile.ids);
      input.progress(`rechecking ${cited.length} cited evidence item(s)`);
      const changed: string[] = [];
      const unavailable: string[] = [];
      for (const [index, id] of cited.entries()) {
        const entry = ledger.get(id);
        try {
          const status = entry ? await broker.recheck(entry) : "unavailable";
          if (status === "changed") changed.push(id);
          if (status === "unavailable") unavailable.push(id);
        } catch (error) {
          // A deadline during rechecks keeps the (paid) answer but marks it unconfirmed;
          // a user cancel or session change still cancels.
          if (!(error instanceof AbortedError) || input.abortReason() !== "deadline") throw error;
          budget.limitsHit.add("maxWallTimeMs");
          unavailable.push(...cited.slice(index));
          break;
        }
      }
      freshness = { scope: "cited_ranges_and_captured_diff", checkedAt: new Date().toISOString(), changedEvidenceIds: changed, unavailableEvidenceIds: unavailable };
      if (changed.length || unavailable.length) {
        state = "stale";
        if (changed.length) warnings.push(`Stale: cited evidence changed before publication (${changed.join(", ")}).`);
        if (unavailable.length) warnings.push(`Stale/unconfirmed: freshness of ${unavailable.join(", ")} could not be rechecked within the allowance or permissions.`);
      }
    }
    return finish(state, answer, freshness, undefined, profile.ids);
  } catch (error) {
    if (error instanceof AbortedError || signal.aborted) return abortOutcome();
    return finish("failed", null, notChecked, `Internal error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
