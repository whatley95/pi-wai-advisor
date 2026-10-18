/**
 * Scripted model adapter: each step receives the exact request (system + user
 * prompt) and returns a reply. Records every attempt for assertions.
 */
import type { ModelAdapter, ModelCallRequest, ModelCallResult, ModelDescription, ModelUsage } from "../../src/model/adapter.ts";
import { PROTOCOL_ID } from "../../src/core/protocol.ts";

export type Step =
  | string
  | ModelCallResult
  | ((request: ModelCallRequest, index: number) => string | ModelCallResult | Promise<string | ModelCallResult>);

export class ScriptedModel implements ModelAdapter {
  /** Every instance created in the current test; checked by tests/setup.ts after each test. */
  static readonly instances = new Set<ScriptedModel>();
  readonly requests: ModelCallRequest[] = [];
  /** Assertion errors thrown inside steps (the engine would otherwise absorb them). */
  readonly failures: unknown[] = [];
  private index = 0;
  constructor(
    private readonly steps: Step[],
    private readonly description: Partial<ModelDescription> = {},
    private readonly usage: ModelUsage | null = { input: 1000, output: 200, cacheRead: 100, cacheWrite: 0, costUsd: 0.002 },
  ) {
    ScriptedModel.instances.add(this);
  }

  describe(): ModelDescription {
    return {
      provider: "scripted",
      id: "advisor-1",
      contextWindow: 128_000,
      maxTokens: 8_000,
      pricing: { inputPerMTok: 1, outputPerMTok: 5 },
      ...this.description,
    };
  }

  get callCount(): number {
    return this.requests.length;
  }

  async call(request: ModelCallRequest): Promise<ModelCallResult> {
    this.requests.push(request);
    const step = this.steps[this.index++];
    if (step === undefined) {
      const error = new Error(`ScriptedModel: no step for call ${this.index}`);
      this.failures.push(error);
      throw error;
    }
    let out: string | ModelCallResult;
    try {
      out = typeof step === "function" ? await step(request, this.index - 1) : step;
    } catch (error) {
      this.failures.push(error);
      throw error;
    }
    if (typeof out === "string") return { ok: true, text: out, usage: this.usage, truncated: false };
    return out;
  }
}

export function evidenceTurn(...requests: unknown[]): string {
  return JSON.stringify({ protocol: PROTOCOL_ID, type: "evidence", requests });
}

export interface AnswerOverrides {
  recommendation?: string;
  rationale?: string;
  basis?: "source_backed" | "mixed" | "general_reasoning";
  citations?: Array<{ evidenceId: string; claim: string; startLine?: number; endLine?: number; support: "direct_observation" | "inference" | "caller_report" }>;
  missingEvidence?: string[];
  humanDecisions?: Array<{ question: string; recommendation: string; impact: string }>;
  verificationSuggestions?: string[];
  risks?: string[];
  suggestedFix?: string;
}

export function answerTurn(overrides: AnswerOverrides = {}): string {
  return JSON.stringify({
    protocol: PROTOCOL_ID,
    type: "answer",
    answer: {
      recommendation: "Recommendation text.",
      rationale: "Rationale text.",
      basis: "general_reasoning",
      citations: [],
      verificationSuggestions: [],
      missingEvidence: [],
      risks: [],
      humanDecisions: [],
      ...overrides,
    },
  });
}

/** Find the evidence ID the broker minted for a path in the prompt. */
export function evidenceIdFor(prompt: string, path: string, kind = "source_range"): string {
  const re = new RegExp(`\\[(E\\d+)\\] ${kind} ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  const m = re.exec(prompt);
  if (!m) throw new Error(`No ${kind} evidence for ${path} in prompt:\n${prompt.slice(0, 3000)}`);
  return m[1] as string;
}
