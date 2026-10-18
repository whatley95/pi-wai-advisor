/**
 * Per-request budgets: model calls, evidence requests, per-call and cumulative
 * estimated input tokens, serialized bytes, retained evidence bytes, wall time and
 * optional cost reservations. Every attempt (retry, repair, synthesis, failed or
 * duplicate evidence request, freshness recheck) consumes allowance.
 *
 * Token counts are ESTIMATES (see estimateTokens); serialized bytes are exact for
 * the payload this extension constructs, not for hidden provider-side additions.
 */
import type { Limits } from "../contracts.ts";

/** Conservative estimator: ceil(UTF-8 bytes / 3) + 16 per message. Not a tokenizer. */
export function estimateTokens(text: string, messages = 1): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3) + 16 * messages;
}

export const ESTIMATOR_DESCRIPTION = "ceil(UTF-8 bytes / 3) + 16 tokens per message (conservative estimate, not a provider tokenizer)";

export interface ModelPricing {
  /** USD per million tokens; null when unknown. */
  inputPerMTok: number | null;
  outputPerMTok: number | null;
}

export type Admission = { ok: true } | { ok: false; limit: string; reason: string };

export class Budget {
  modelCalls = 0;
  evidenceRequests = 0;
  estimatedInputTokens = 0;
  reservedCostUsd = 0;
  readonly limitsHit = new Set<string>();
  readonly startedAtMs: number;
  readonly deadlineMs: number;

  constructor(
    readonly limits: Readonly<Limits>,
    /** Effective per-call input token ceiling after model capacity. */
    readonly perCallInputTokens: number,
    /** Effective output cap after model capacity. */
    readonly outputTokens: number,
    private readonly pricing: ModelPricing,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAtMs = now();
    this.deadlineMs = this.startedAtMs + limits.maxWallTimeMs;
  }

  timeLeftMs(): number {
    return Math.max(0, this.deadlineMs - this.now());
  }

  expired(): boolean {
    return this.timeLeftMs() <= 0;
  }

  remainingModelCalls(): number {
    return Math.max(0, this.limits.maxModelCalls - this.modelCalls);
  }

  remainingEvidence(): number {
    return Math.max(0, this.limits.maxEvidenceRequests - this.evidenceRequests);
  }

  /** Atomically reserve one evidence request (before dispatch). */
  reserveEvidence(keepInReserve = 0): boolean {
    if (this.expired()) {
      this.limitsHit.add("maxWallTimeMs");
      return false;
    }
    if (this.remainingEvidence() <= keepInReserve) {
      this.limitsHit.add("maxEvidenceRequests");
      return false;
    }
    this.evidenceRequests++;
    return true;
  }

  /** Check whether a model call with this payload could be admitted (no side effects). */
  checkModelCall(serialized: string, estimatedTokens: number): Admission {
    if (this.expired()) return { ok: false, limit: "maxWallTimeMs", reason: "The wall-time deadline has passed." };
    if (this.remainingModelCalls() <= 0) return { ok: false, limit: "maxModelCalls", reason: "No model calls remain." };
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > this.limits.maxSerializedRequestBytes)
      return { ok: false, limit: "maxSerializedRequestBytes", reason: `Payload is ${bytes} bytes (limit ${this.limits.maxSerializedRequestBytes}).` };
    if (estimatedTokens > this.perCallInputTokens)
      return { ok: false, limit: "maxInputTokens", reason: `Estimated ${estimatedTokens} input tokens exceed the per-call limit ${this.perCallInputTokens}.` };
    if (this.estimatedInputTokens + estimatedTokens > this.limits.maxCumulativeInputTokens)
      return {
        ok: false,
        limit: "maxCumulativeInputTokens",
        reason: `Cumulative estimate would reach ${this.estimatedInputTokens + estimatedTokens} (limit ${this.limits.maxCumulativeInputTokens}).`,
      };
    if (this.limits.maxCostUsd !== null) {
      const cost = this.callCostReservation(estimatedTokens);
      if (cost === null)
        return { ok: false, limit: "maxCostUsd", reason: "Model prices are unknown, so the configured cost cap cannot be enforced; remove the cap explicitly to proceed." };
      if (this.reservedCostUsd + cost > this.limits.maxCostUsd)
        return { ok: false, limit: "maxCostUsd", reason: `Reserving $${cost.toFixed(4)} would exceed maxCostUsd $${this.limits.maxCostUsd}.` };
    }
    return { ok: true };
  }

  /** Reserve a model call; caller must have checked admission with the same payload. */
  reserveModelCall(serialized: string, estimatedTokens: number): Admission {
    const admission = this.checkModelCall(serialized, estimatedTokens);
    if (!admission.ok) {
      this.limitsHit.add(admission.limit);
      return admission;
    }
    this.modelCalls++;
    this.estimatedInputTokens += estimatedTokens;
    if (this.limits.maxCostUsd !== null) this.reservedCostUsd += this.callCostReservation(estimatedTokens) ?? 0;
    return admission;
  }

  /** Estimated input cost plus maximum output cost for one call; null when prices unknown. */
  callCostReservation(estimatedTokens: number): number | null {
    const { inputPerMTok, outputPerMTok } = this.pricing;
    if (inputPerMTok === null || outputPerMTok === null) return null;
    return (estimatedTokens * inputPerMTok + this.outputTokens * outputPerMTok) / 1_000_000;
  }
}

/**
 * Apply model capacity: lower capacity wins over configuration, never the reverse.
 * Returns null when the model cannot fit even a minimal consultation.
 */
export function effectiveTokenLimits(
  limits: Readonly<Limits>,
  model: { contextWindow: number; maxTokens: number },
): { perCallInputTokens: number; outputTokens: number; notes: string[] } | { error: string } {
  const notes: string[] = [];
  const modelMaxOut = model.maxTokens > 0 ? model.maxTokens : limits.maxOutputTokens;
  const outputTokens = Math.min(limits.maxOutputTokens, modelMaxOut);
  if (outputTokens < limits.maxOutputTokens) notes.push(`Output cap lowered to the model maximum ${outputTokens}.`);
  if (outputTokens < 256) return { error: `The model's maximum output (${modelMaxOut}) is too small for an advisor answer.` };
  const safety = 512;
  const capacity = model.contextWindow > 0 ? model.contextWindow - outputTokens - safety : limits.maxInputTokens;
  const perCallInputTokens = Math.min(limits.maxInputTokens, capacity);
  if (perCallInputTokens < limits.maxInputTokens) notes.push(`Per-call input limit lowered to model capacity ${perCallInputTokens}.`);
  if (perCallInputTokens < 1500) return { error: `The model context window (${model.contextWindow}) cannot fit a minimal consultation.` };
  return { perCallInputTokens, outputTokens, notes };
}
