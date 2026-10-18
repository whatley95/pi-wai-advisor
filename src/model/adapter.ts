/**
 * Model adapter boundary. The engine depends only on this interface; the Pi runtime
 * implementation lives in pi-runtime.ts and tests inject scripted adapters.
 */
import type { ModelSnapshot } from "../contracts.ts";
import type { ModelPricing } from "../core/budget.ts";

export interface ModelCallRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface ModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Locally computed from catalog prices × reported tokens; null when prices are unknown. */
  costUsd: number | null;
}

export type ModelCallResult =
  | { ok: true; text: string; usage: ModelUsage | null; truncated: boolean }
  | { ok: false; error: string; transient: boolean; usage: ModelUsage | null; aborted?: boolean };

export interface ModelDescription extends ModelSnapshot {
  contextWindow: number;
  maxTokens: number;
  pricing: ModelPricing;
}

export interface ModelAdapter {
  describe(): ModelDescription;
  /** Exactly one provider attempt; adapters must not retry internally. */
  call(request: ModelCallRequest): Promise<ModelCallResult>;
}

const TRANSIENT = /timeout|timed out|rate.?limit|overloaded|\b429\b|\b5\d\d\b|econnreset|socket hang up|network|temporar|unavailable/i;

export function isTransientError(message: string): boolean {
  return TRANSIENT.test(message);
}
