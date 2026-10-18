/**
 * Model adapter over Pi's supported runtime: `ctx.modelRegistry.streamSimple()`.
 * Authentication is resolved by Pi; no credentials are read, stored or logged here.
 *
 * Retry control: every call passes `maxRetries: 0`. Inspection of
 * @earendil-works/pi-ai 1.3.0 showed the APIs below disable SDK retries and run
 * Pi's own retry wrapper only when maxRetries > 0, so one call is one attempt.
 * Other APIs (e.g. bedrock-converse-stream, whose AWS SDK client retries opaquely,
 * virtual/routed models, and unknown extension APIs) are rejected because
 * maxModelCalls could not be enforced for them.
 */
import type { ModelCallRequest, ModelCallResult, ModelAdapter, ModelDescription, ModelUsage } from "./adapter.ts";
import { isTransientError } from "./adapter.ts";

export const RETRY_VERIFIED_APIS: readonly string[] = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "pi-messages",
];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Minimal structural view of Pi's Model<Api>. */
export interface PiModelLike {
  id: string;
  name?: string;
  api: string;
  provider: string;
  type?: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null | undefined>;
  contextWindow: number;
  maxTokens: number;
  input?: string[];
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

interface PiUsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

interface PiAssistantMessageLike {
  content?: Array<{ type: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
  usage?: PiUsageLike;
}

export interface PiModelRegistryLike {
  getAll(): PiModelLike[];
  getAvailable(): PiModelLike[];
  find(provider: string, id: string): PiModelLike | undefined;
  hasConfiguredAuth(model: PiModelLike): boolean;
  streamSimple(model: PiModelLike, context: unknown, options?: Record<string, unknown>): { result(): Promise<PiAssistantMessageLike> };
  getRegisteredProviderConfig?(provider: string): { streamSimple?: unknown } | undefined;
  /** Authoritative async auth resolution (Pi refreshes the hasConfiguredAuth snapshot asynchronously). */
  getProviderAuth?(provider: string): Promise<unknown>;
}

/**
 * Whether Pi can authenticate the provider. Only presence is checked; the resolved
 * credential is never stored, logged or returned.
 */
export async function isAuthConfigured(registry: PiModelRegistryLike, provider: string, cache?: Map<string, boolean>): Promise<boolean> {
  const cached = cache?.get(provider);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    ok = registry.hasConfiguredAuth({ provider } as PiModelLike);
  } catch {
    ok = false;
  }
  if (!ok && registry.getProviderAuth) {
    try {
      ok = (await registry.getProviderAuth(provider)) !== undefined;
    } catch {
      ok = false;
    }
  }
  cache?.set(provider, ok);
  return ok;
}

/** Same rules as pi-ai getSupportedThinkingLevels (1.3.0). */
export function supportedThinkingLevels(model: PiModelLike): string[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export type Compatibility = { ok: true; notes: string[] } | { ok: false; reason: string };

export function checkModelCompatibility(
  registry: PiModelRegistryLike,
  model: PiModelLike,
  effort: string | undefined,
  trustedApis: readonly string[] = RETRY_VERIFIED_APIS,
  authConfigured: boolean = registry.hasConfiguredAuth(model),
): Compatibility {
  const notes: string[] = [];
  if (model.type && model.type !== "chat") return { ok: false, reason: `${model.provider}/${model.id} is not a chat model.` };
  if (!trustedApis.includes(model.api))
    return {
      ok: false,
      reason: `API "${model.api}" is not supported: WAI Advisor could not verify that its retries are disabled, so maxModelCalls could not be enforced (virtual/routed models are also unsupported).`,
    };
  const custom = registry.getRegisteredProviderConfig?.(model.provider);
  if (custom?.streamSimple)
    return { ok: false, reason: `Provider "${model.provider}" registers a custom stream implementation whose retry behavior cannot be verified.` };
  if (!authConfigured) return { ok: false, reason: `No authentication is configured for provider "${model.provider}". Log in or configure it in Pi first.` };
  if (model.input && !model.input.includes("text")) return { ok: false, reason: "The model does not accept text input." };
  if (!(model.contextWindow > 0)) notes.push("The model reports no context window; configured limits apply unchanged.");
  if (effort !== undefined) {
    const levels = supportedThinkingLevels(model);
    if (!levels.includes(effort)) return { ok: false, reason: `Reasoning level "${effort}" is not supported by ${model.provider}/${model.id} (supported: ${levels.join(", ")}).` };
  }
  return { ok: true, notes };
}

function usageOf(message: PiAssistantMessageLike, pricesKnown: boolean): ModelUsage | null {
  const u = message.usage;
  if (!u || typeof u.input !== "number" || typeof u.output !== "number") return null;
  const total = u.cost?.total;
  return {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    costUsd: pricesKnown && typeof total === "number" ? total : null,
  };
}

export class PiRuntimeModelAdapter implements ModelAdapter {
  constructor(
    private readonly registry: PiModelRegistryLike,
    private readonly model: PiModelLike,
    private readonly effort: string | undefined,
  ) {}

  describe(): ModelDescription {
    const cost = this.model.cost;
    const known = !!cost && (cost.input > 0 || cost.output > 0);
    return {
      provider: this.model.provider,
      id: this.model.id,
      ...(this.effort ? { effort: this.effort } : {}),
      contextWindow: this.model.contextWindow,
      maxTokens: this.model.maxTokens,
      pricing: { inputPerMTok: known ? (cost as { input: number }).input : null, outputPerMTok: known ? (cost as { output: number }).output : null },
    };
  }

  async call(request: ModelCallRequest): Promise<ModelCallResult> {
    const pricesKnown = this.describe().pricing.inputPerMTok !== null;
    const context = {
      systemPrompt: request.system,
      messages: [{ role: "user", content: request.user, timestamp: Date.now() }],
    };
    const options: Record<string, unknown> = {
      signal: request.signal,
      maxTokens: request.maxOutputTokens,
      maxRetries: 0,
      ...(this.effort && this.effort !== "off" ? { reasoning: this.effort } : {}),
    };
    let message: PiAssistantMessageLike;
    try {
      message = await this.registry.streamSimple(this.model, context, options).result();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { ok: false, error: text.slice(0, 500), transient: !request.signal.aborted && isTransientError(text), usage: null, aborted: request.signal.aborted };
    }
    const usage = usageOf(message, pricesKnown);
    if (message.stopReason === "aborted") return { ok: false, error: "Model call aborted.", transient: false, usage, aborted: true };
    if (message.stopReason === "error") {
      const text = message.errorMessage ?? "Model call failed.";
      return { ok: false, error: text.slice(0, 500), transient: isTransientError(text), usage };
    }
    const text = (message.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    return { ok: true, text, usage, truncated: message.stopReason === "length" };
  }
}
