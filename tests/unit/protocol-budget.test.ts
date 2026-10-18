import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/config.ts";
import { Budget, effectiveTokenLimits, estimateTokens } from "../../src/core/budget.ts";
import { PROTOCOL_ID, parseAdvisorTurn } from "../../src/core/protocol.ts";
import { parseAdvisorArgs } from "../../src/integration/args.ts";
import { answerTurn, evidenceTurn } from "../helpers/scripted-model.ts";

describe("turn protocol", () => {
  it("accepts a strict envelope, optionally fenced", () => {
    expect(parseAdvisorTurn(answerTurn()).ok).toBe(true);
    expect(parseAdvisorTurn("```json\n" + evidenceTurn({ tool: "list_files" }) + "\n```").ok).toBe(true);
  });

  it.each([
    ["prose around JSON", `Sure! ${answerTurn()}`],
    ["missing protocol", JSON.stringify({ type: "answer", answer: {} })],
    ["run_command action", JSON.stringify({ protocol: PROTOCOL_ID, type: "evidence", requests: [{ tool: "run_command", command: "cat .env" }] })],
    ["extra argument", JSON.stringify({ protocol: PROTOCOL_ID, type: "evidence", requests: [{ tool: "list_files", recursive: true }] })],
    ["too many requests", evidenceTurn({ tool: "list_files" }, { tool: "list_files" }, { tool: "list_files" }, { tool: "list_files" })],
    ["non-literal search", JSON.stringify({ protocol: PROTOCOL_ID, type: "evidence", requests: [{ tool: "search_code", query: "a.*b", literal: false }] })],
    ["provider switch field", JSON.stringify({ protocol: PROTOCOL_ID, type: "answer", provider: "attacker", answer: JSON.parse(answerTurn()).answer })],
    ["two objects", `${answerTurn()}\n${answerTurn()}`],
  ])("rejects %s", (_name, raw) => {
    expect(parseAdvisorTurn(raw).ok).toBe(false);
  });
});

describe("budget boundaries", () => {
  const limits = { ...DEFAULT_LIMITS, maxModelCalls: 2, maxEvidenceRequests: 2, maxCumulativeInputTokens: 300, maxSerializedRequestBytes: 8192 };

  it("model calls: below/equal/above", () => {
    const b = new Budget(limits, 200, 100, { inputPerMTok: null, outputPerMTok: null });
    expect(b.reserveModelCall("x", 10).ok).toBe(true);
    expect(b.reserveModelCall("x", 10).ok).toBe(true);
    const third = b.reserveModelCall("x", 10);
    expect(third.ok).toBe(false);
    expect(b.limitsHit.has("maxModelCalls")).toBe(true);
  });

  it("per-call tokens: equal admitted, above rejected", () => {
    const b = new Budget(limits, 200, 100, { inputPerMTok: null, outputPerMTok: null });
    expect(b.checkModelCall("x", 200).ok).toBe(true);
    expect(b.checkModelCall("x", 201)).toMatchObject({ ok: false, limit: "maxInputTokens" });
  });

  it("cumulative tokens count every attempt", () => {
    const b = new Budget({ ...limits, maxModelCalls: 5 }, 200, 100, { inputPerMTok: null, outputPerMTok: null });
    expect(b.reserveModelCall("x", 150).ok).toBe(true);
    expect(b.reserveModelCall("x", 150).ok).toBe(true); // exactly 300
    expect(b.reserveModelCall("x", 1)).toMatchObject({ ok: false, limit: "maxCumulativeInputTokens" });
  });

  it("serialized bytes are exact for the constructed payload", () => {
    const b = new Budget(limits, 1_000_000, 100, { inputPerMTok: null, outputPerMTok: null });
    expect(b.checkModelCall("a".repeat(8192), 1).ok).toBe(true);
    expect(b.checkModelCall("a".repeat(8193), 1)).toMatchObject({ ok: false, limit: "maxSerializedRequestBytes" });
    expect(b.checkModelCall("é".repeat(4097), 1).ok).toBe(false); // 8194 UTF-8 bytes
  });

  it("evidence allowance honors the recheck reserve", () => {
    const b = new Budget(limits, 200, 100, { inputPerMTok: null, outputPerMTok: null });
    expect(b.reserveEvidence(1)).toBe(true);
    expect(b.reserveEvidence(1)).toBe(false);
    expect(b.reserveEvidence(0)).toBe(true);
    expect(b.reserveEvidence(0)).toBe(false);
  });

  it("cost cap: unknown prices block; known prices reserve input + maximum output", () => {
    const capped = { ...limits, maxCostUsd: 0.01 };
    expect(new Budget(capped, 200, 100, { inputPerMTok: null, outputPerMTok: null }).checkModelCall("x", 10)).toMatchObject({ ok: false, limit: "maxCostUsd" });
    const b = new Budget({ ...capped, maxModelCalls: 10, maxCumulativeInputTokens: 100_000 }, 10_000, 1000, { inputPerMTok: 1, outputPerMTok: 4 });
    // each call reserves 1000*1e-6 + 1000*4e-6 = 0.005
    expect(b.reserveModelCall("x", 1000).ok).toBe(true);
    expect(b.reserveModelCall("x", 1000).ok).toBe(true);
    expect(b.reserveModelCall("x", 1000)).toMatchObject({ ok: false, limit: "maxCostUsd" });
  });

  it("model capacity lowers limits, never raises them", () => {
    const r = effectiveTokenLimits(DEFAULT_LIMITS, { contextWindow: 8000, maxTokens: 512 });
    expect(r).toMatchObject({ outputTokens: 512, perCallInputTokens: 8000 - 512 - 512 });
    expect(effectiveTokenLimits(DEFAULT_LIMITS, { contextWindow: 2000, maxTokens: 512 })).toHaveProperty("error");
    expect(effectiveTokenLimits(DEFAULT_LIMITS, { contextWindow: 1_000_000, maxTokens: 100_000 })).toMatchObject({ outputTokens: 1200, perCallInputTokens: 16000 });
  });

  it("estimator is conservative relative to bytes", () => {
    expect(estimateTokens("a".repeat(300))).toBe(116);
  });
});

describe("/wai-advisor argument parsing", () => {
  it("parses flags, repeats --file and supports --", () => {
    expect(parseAdvisorArgs('--file "src/a b.ts" --file=src/c.ts why?')).toEqual({ ok: true, question: "why?", quick: false, files: ["src/a b.ts", "src/c.ts"] });
    expect(parseAdvisorArgs("--quick Map or Record?")).toEqual({ ok: true, question: "Map or Record?", quick: true, files: [] });
    expect(parseAdvisorArgs("-- --quick is a flag?")).toEqual({ ok: true, question: "--quick is a flag?", quick: false, files: [] });
  });
  it("rejects --quick with --file, unknown flags and empty questions", () => {
    expect(parseAdvisorArgs("--quick --file a.ts q").ok).toBe(false);
    expect(parseAdvisorArgs("--deep q").ok).toBe(false);
    expect(parseAdvisorArgs("--quick").ok).toBe(false);
  });
});
