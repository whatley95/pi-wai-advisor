import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ConsultOutcome, ConsultResponse } from "../../src/core/controller.ts";
import { projectKeyOf } from "../../src/core/controller.ts";
import { canonicalRoot } from "../../src/evidence/path-policy.ts";
import { compactReturn, returnSize, STANDING_LIMIT } from "../../src/integration/compact-output.ts";
import { RequestStore, StoreError } from "../../src/storage/request-store.ts";
import { defaultSection, harness, project, writeSettings } from "../helpers/harness.ts";
import { realHost } from "../helpers/hosts.ts";
import { answerTurn, evidenceIdFor, evidenceTurn, ScriptedModel } from "../helpers/scripted-model.ts";

function ok(res: ConsultResponse): ConsultOutcome {
  if (res.kind !== "result") throw new Error(`Expected a result, got: ${res.message}`);
  return res;
}

const REPO = "app/src/main/java/com/example/history/HistoryRepository.kt";
const read = (startLine = 1, endLine = 30, path = REPO) => ({ tool: "read_file", path, startLine, endLine });
const withLimits = (limits: Record<string, unknown>, extra: Record<string, unknown> = {}) => defaultSection({ limits, ...extra });

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  let started!: () => void;
  const begun = new Promise<void>((r) => (started = r));
  return { open, opened, started, begun };
}

/** A step that blocks until aborted, then (optionally later) resolves like a provider ignoring abort. */
function hangingStep(onStart?: () => void, lateMs = 0) {
  return (req: { signal: AbortSignal }) =>
    new Promise<string>((resolve) => {
      onStart?.();
      req.signal.addEventListener("abort", () => setTimeout(() => resolve(answerTurn()), lateMs), { once: true });
    });
}

describe("budgets and retry accounting", () => {
  it("final call must answer; an evidence request on it yields a local partial", async () => {
    const root = project("kotlin-android");
    const model = new ScriptedModel([evidenceTurn(read()), evidenceTurn(read(1, 10))]);
    const h = harness(root, realHost(root), model, withLimits({ maxModelCalls: 2 }));
    const res = ok(await h.controller.consult(h.ctx(), { question: "Is the history cache safe?" }));
    expect(model.callCount).toBe(2);
    expect(model.requests[1]?.user).toMatch(/THIS IS YOUR FINAL CALL/);
    expect(res.result.state).toBe("partial");
    expect(res.result.answer).toBeNull();
    expect(res.result.limitsHit).toContain("maxModelCalls");
    expect(res.compact.text).toMatch(/No advisor conclusion/);
  });

  it("transient retries and malformed-envelope repairs consume model calls", async () => {
    const root = project("kotlin-android");
    const model = new ScriptedModel([{ ok: false, error: "HTTP 529 overloaded", transient: true, usage: null }, "this is not json", answerTurn()]);
    const h = harness(root, realHost(root), model);
    const res = ok(await h.controller.consult(h.ctx(), { question: "Is the history cache safe?" }));
    expect(res.result.usage.modelCalls).toBe(3);
    expect(res.result.usage.actualInputTokens).toBeNull(); // one attempt reported no usage: unknown, not zero
    expect(res.result.usage.costUsd).toBeNull();
    expect(res.result.warnings.join(" ")).toMatch(/retried \(counted\)/);
    expect(res.result.warnings.join(" ")).toMatch(/repair attempt/);
  });

  it("does not retry when only the reserved final call remains, and fails after two malformed replies", async () => {
    const root = project("kotlin-android");
    const model = new ScriptedModel(["nope", "still nope"]);
    const h = harness(root, realHost(root), model);
    const res = ok(await h.controller.consult(h.ctx(), { question: "q?" }));
    expect(res.result.state).toBe("failed");
    expect(model.callCount).toBe(2);
  });

  it("evidence allowance (including discovery and rechecks) is never exceeded", async () => {
    const root = project("kotlin-android");
    const host = realHost(root);
    const model = new ScriptedModel([
      evidenceTurn(read(1, 5), read(6, 10), read(11, 15)),
      (req) => answerTurn({ basis: "source_backed", citations: [{ evidenceId: evidenceIdFor(req.user, REPO), claim: "x", startLine: 1, endLine: 2, support: "direct_observation" }] }),
    ]);
    const h = harness(root, host, model, withLimits({ maxEvidenceRequests: 3 }));
    const res = ok(await h.controller.consult(h.ctx(), { question: "Is HistoryRepository safe?" }));
    expect(res.result.usage.evidenceRequests).toBeLessThanOrEqual(3);
    expect(host.calls.length).toBeLessThanOrEqual(3);
    expect(res.result.state).toBe("partial"); // requested evidence was skipped
    expect(res.result.limitsHit).toContain("maxEvidenceRequests");
  });

  it("insufficient recheck capacity marks the answer stale/unconfirmed instead of overspending", async () => {
    const root = project("kotlin-android");
    const host = realHost(root);
    const model = new ScriptedModel([
      evidenceTurn(read(1, 12)),
      (req) =>
        answerTurn({
          basis: "source_backed",
          citations: [
            { evidenceId: "E1", claim: "manifest", support: "direct_observation" },
            { evidenceId: "E2", claim: "hit", support: "direct_observation" },
            { evidenceId: evidenceIdFor(req.user, REPO), claim: "code", startLine: 9, endLine: 9, support: "direct_observation" },
          ],
        }),
    ]);
    const h = harness(root, host, model, withLimits({ maxEvidenceRequests: 4 }));
    const res = ok(await h.controller.consult(h.ctx(), { question: "Why does HistoryScreen leak data?" }));
    expect(res.result.usage.evidenceRequests).toBe(4);
    expect(res.result.state).toBe("stale");
    expect(res.result.freshness.unavailableEvidenceIds.length).toBeGreaterThan(0);
  });

  it("cumulative input limit stops before an unaffordable call with a local partial result", async () => {
    const root = project("kotlin-android");
    const model = new ScriptedModel([evidenceTurn(read(1, 30))]);
    const h = harness(root, realHost(root), model, withLimits({ maxCumulativeInputTokens: 3200, maxInputTokens: 3000 }));
    const res = ok(await h.controller.consult(h.ctx(), { question: "Is HistoryRepository safe?" }));
    expect(model.callCount).toBe(1);
    expect(res.result.limitsHit).toContain("maxCumulativeInputTokens");
    expect(res.result.state).toBe("partial");
  });

  it("omits older evidence text to fit the per-call budget and says so", async () => {
    const root = project("spring-react");
    const files = ["CustomerController", "CustomerService", "Customer"].map((n) => `backend/src/main/java/com/example/customer/${n}.java`);
    const model = new ScriptedModel([evidenceTurn(...files.map((f) => read(1, 60, f))), () => answerTurn()]);
    const h = harness(root, realHost(root), model, withLimits({ maxInputTokens: 2600, maxCumulativeInputTokens: 20000 }));
    const res = ok(await h.controller.consult(h.ctx(), { question: "How is a customer saved?" }));
    expect(model.requests[1]?.user).toMatch(/text omitted to fit the context budget/);
    expect(res.result.warnings.join(" ")).toMatch(/Evidence text omitted/);
  });

  it("cost cap with unknown prices blocks before any tool or model call", async () => {
    const root = project("kotlin-android");
    const host = realHost(root);
    const model = new ScriptedModel([], { pricing: { inputPerMTok: null, outputPerMTok: null } });
    const h = harness(root, host, model, withLimits({ maxCostUsd: 1 }));
    const res = await h.controller.consult(h.ctx(), { question: "q?" });
    expect(res.kind).toBe("rejected");
    expect(host.calls).toHaveLength(0);
    expect(model.callCount).toBe(0);
  });

  it("quick mode: no source tools, one attempt, no hidden retry, seeds rejected", async () => {
    const root = project("kotlin-android");
    const host = realHost(root);
    const model = new ScriptedModel([
      (req) => {
        expect(req.system).toMatch(/No source tools are available/);
        expect(req.system).not.toContain('"tool":"read_file"');
        return answerTurn({ recommendation: "Use a Map for dynamic keys; a Record type for a fixed key set." });
      },
    ]);
    const h = harness(root, host, model);
    const res = ok(await h.controller.consult(h.ctx(), { question: "Map or Record for fixed cache keys?", mode: "quick" }));
    expect(res.result.state).toBe("completed");
    expect(host.calls).toHaveLength(0);
    expect(res.compact.text).toMatch(/Quick mode: no project source was inspected/);
    const seeded = await h.controller.consult(h.ctx(), { question: "q", mode: "quick", seedPaths: [REPO] });
    expect(seeded.kind).toBe("rejected");

    const flaky = new ScriptedModel([{ ok: false, error: "HTTP 503", transient: true, usage: null }]);
    h.setModel(flaky);
    const failed = ok(await h.controller.consult(h.ctx(), { question: "q?", mode: "quick" }));
    expect(failed.result.state).toBe("failed");
    expect(flaky.callCount).toBe(1);
  });
});

describe("freshness", () => {
  it("cited range changed before publication → stale", async () => {
    const root = project("kotlin-android");
    const model = new ScriptedModel([
      evidenceTurn(read(1, 20)),
      (req) => {
        const file = join(root, REPO);
        writeFileSync(file, readFileSync(file, "utf8").replace('getOrPut("recent")', 'getOrPut("recent-$accountId")'));
        return answerTurn({ basis: "source_backed", citations: [{ evidenceId: evidenceIdFor(req.user, REPO), claim: "x", startLine: 10, endLine: 10, support: "direct_observation" }] });
      },
    ]);
    const h = harness(root, realHost(root), model);
    const res = ok(await h.controller.consult(h.ctx(), { question: "Is HistoryRepository safe?" }));
    expect(res.result.state).toBe("stale");
    expect(res.result.freshness.changedEvidenceIds).toHaveLength(1);
    expect(res.compact.text).toMatch(/Stale: cited evidence changed/);
  });

  it("changes outside the cited (returned) range are not claimed as detected", async () => {
    const root = project("kotlin-android");
    const model = new ScriptedModel([
      evidenceTurn(read(1, 12)),
      (req) => {
        const file = join(root, REPO);
        writeFileSync(file, readFileSync(file, "utf8").replace("fun clear()", "fun clearAll()")); // line 15
        return answerTurn({ basis: "source_backed", citations: [{ evidenceId: evidenceIdFor(req.user, REPO), claim: "x", startLine: 10, endLine: 10, support: "direct_observation" }] });
      },
    ]);
    const h = harness(root, realHost(root), model);
    const res = ok(await h.controller.consult(h.ctx(), { question: "Is HistoryRepository safe?" }));
    expect(res.result.state).toBe("completed");
    expect(res.result.freshness.scope).toBe("cited_ranges_and_captured_diff");
  });

  it("denied recheck → unconfirmed/stale, never a silent local reread", async () => {
    const root = project("kotlin-android");
    let reads = 0;
    const host = realHost(root, { deny: (c) => (c.name === "read" && ++reads > 1 ? "denied" : null) });
    const model = new ScriptedModel([
      evidenceTurn(read(1, 12)),
      (req) => answerTurn({ basis: "source_backed", citations: [{ evidenceId: evidenceIdFor(req.user, REPO), claim: "x", startLine: 10, endLine: 10, support: "direct_observation" }] }),
    ]);
    const h = harness(root, host, model);
    const res = ok(await h.controller.consult(h.ctx(), { question: "Is HistoryRepository safe?" }));
    expect(res.result.state).toBe("stale");
    expect(res.result.freshness.unavailableEvidenceIds).toHaveLength(1);
  });
});

describe("cancellation, deadlines, concurrency and session isolation", () => {
  it("manual cancel stops the request; no further model or tool calls; late usage recorded", async () => {
    const root = project("kotlin-android");
    const host = realHost(root);
    const g = gate();
    const model = new ScriptedModel([hangingStep(g.started, 30)]);
    const h = harness(root, host, model);
    const pending = h.controller.consult(h.ctx(), { question: "q?" });
    await g.begun;
    const callsBefore = host.calls.length;
    expect(h.controller.cancel(root, "chat-1")).not.toBeNull();
    const res = ok(await pending);
    expect(res.result.state).toBe("cancelled");
    expect(res.result.answer).toBeNull();
    expect(model.callCount).toBe(1);
    expect(host.calls.length).toBe(callsBefore);
    await new Promise((r) => setTimeout(r, 80));
    const events = readFileSync(join(root, ".pi", "pi-wai-advisor", "requests", res.result.requestId, "events.jsonl"), "utf8");
    expect(events).toMatch(/late_completion/);
  });

  it("host abort signal (Esc / tool cancellation) cancels", async () => {
    const root = project("kotlin-android");
    const g = gate();
    const abort = new AbortController();
    const h = harness(root, realHost(root), new ScriptedModel([hangingStep(g.started)]));
    const pending = h.controller.consult(h.ctx({ signal: abort.signal }), { question: "q?" });
    await g.begun;
    abort.abort();
    expect(ok(await pending).result.state).toBe("cancelled");
  });

  it("the local deadline finishes the request even if the provider ignores abort", async () => {
    const root = project("kotlin-android");
    const h = harness(root, realHost(root), new ScriptedModel([hangingStep(undefined, 5000)]), withLimits({ maxWallTimeMs: 1200 }));
    const started = Date.now();
    const res = ok(await h.controller.consult(h.ctx(), { question: "Why does HistoryScreen leak?" }));
    expect(Date.now() - started).toBeLessThan(4000);
    expect(res.result.limitsHit).toContain("maxWallTimeMs");
    expect(["partial", "failed"]).toContain(res.result.state);
  });

  it("a second request in the same chat reports busy (no implicit cancel); other chats proceed", async () => {
    const root = project("kotlin-android");
    const g = gate();
    const model = new ScriptedModel([
      (req) =>
        new Promise<string>((resolve) => {
          g.started();
          void g.opened.then(() => resolve(answerTurn()));
          req.signal.addEventListener("abort", () => resolve(answerTurn()));
        }),
      answerTurn({ recommendation: "other chat" }),
    ]);
    const h = harness(root, realHost(root), model);
    const first = h.controller.consult(h.ctx(), { question: "q1?" });
    await g.begun;
    const busy = await h.controller.consult(h.ctx(), { question: "q2?" });
    expect(busy).toMatchObject({ kind: "rejected", busy: true });
    const other = ok(await h.controller.consult(h.ctx({ chatId: "chat-2" }), { question: "q3?", mode: "quick" }));
    expect(other.result.answer?.recommendation).toBe("other chat");
    g.open();
    expect(ok(await first).result.state).toBe("completed");
  });

  it("settings/model changes apply to the next request, not the running one", async () => {
    const root = project("kotlin-android");
    const g = gate();
    let settingsPath = "";
    const model = new ScriptedModel([
      (req) => {
        writeSettings(settingsPath, defaultSection({ defaultMode: "quick", limits: { maxModelCalls: 1 } }));
        return evidenceTurn(read(1, 12));
      },
      () => answerTurn(),
      () => answerTurn({ recommendation: "next" }),
    ]);
    const h = harness(root, realHost(root), model);
    settingsPath = h.settingsPath;
    const first = ok(await h.controller.consult(h.ctx(), { question: "Is HistoryRepository safe?" }));
    expect(first.result.usage.modelCalls).toBe(2); // snapshot kept maxModelCalls=4
    const second = ok(await h.controller.consult(h.ctx(), { question: "q?" }));
    expect(second.result.usage.evidenceRequests).toBe(0); // now quick by default
    void g;
  });

  it("session switch: the late result is never published into the replacement session", async () => {
    const root = project("kotlin-android");
    const g = gate();
    const h = harness(root, realHost(root), new ScriptedModel([hangingStep(g.started), answerTurn()]));
    const pending = h.controller.consult(h.ctx(), { question: "q?" });
    await g.begun;
    h.controller.invalidateAll("session_changed");
    const res = ok(await pending);
    expect(res.publish).toBe(false);
    expect(res.result.state).toBe("cancelled");
    expect(res.result.answer).toBeNull();
    // A fresh consultation after the switch works normally.
    const next = ok(await h.controller.consult(h.ctx({ chatId: "chat-new" }), { question: "q?", mode: "quick" }));
    expect(next.publish).toBe(true);
  });
});

describe("persistence and bounded output", () => {
  it("persists atomically under .pi/pi-wai-advisor without transcripts and supports explicit lookup", async () => {
    const root = project("kotlin-android");
    const model = new ScriptedModel([
      evidenceTurn(read(1, 12)),
      (req) => answerTurn({ basis: "source_backed", citations: [{ evidenceId: evidenceIdFor(req.user, REPO), claim: "x", startLine: 10, endLine: 10, support: "direct_observation" }] }),
    ]);
    const h = harness(root, realHost(root), model);
    const res = ok(await h.controller.consult(h.ctx(), { question: "Is HistoryRepository safe?" }));
    expect(res.saved).toBe(true);
    const dir = join(root, ".pi", "pi-wai-advisor", "requests", res.result.requestId);
    for (const f of ["request.json", "result.json", "ANSWER.md", "evidence-index.json", "events.jsonl"]) expect(readFileSync(join(dir, f), "utf8").length, f).toBeGreaterThan(0);
    const all = ["request.json", "result.json", "ANSWER.md", "evidence-index.json"].map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    expect(all).not.toContain("You are WAI Advisor"); // no provider transcript / system prompt
    const store = new RequestStore(root);
    expect(store.readHistory()[0]?.requestId).toBe(res.result.requestId);
    const key = projectKeyOf(canonicalRoot(root));
    expect(store.readResult(res.result.requestId, key)?.result.state).toBe("completed");
    expect(() => store.readResult(res.result.requestId, "other-project")).toThrow(StoreError);
    writeFileSync(join(dir, "result.json"), "{corrupt");
    expect(() => store.readResult(res.result.requestId, key)).toThrow(/corrupt/);
  });

  it("storage failure is reported, never claimed as saved", async () => {
    const root = project("kotlin-android");
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(join(root, ".pi", "pi-wai-advisor"), "not a directory");
    const h = harness(root, realHost(root), new ScriptedModel([answerTurn()]));
    const res = ok(await h.controller.consult(h.ctx(), { question: "q?", mode: "quick" }));
    expect(res.saved).toBe(false);
    expect(res.compact.envelope.resultPath).toBeNull();
    expect(res.compact.text).toMatch(/NOT saved/);
  });

  it("marks interrupted requests failed on restart without resuming paid work", async () => {
    const root = project("kotlin-android");
    const h = harness(root, realHost(root), new ScriptedModel([answerTurn()]));
    const done = ok(await h.controller.consult(h.ctx(), { question: "q?", mode: "quick" }));
    const store = new RequestStore(root);
    const request = store.readRequest(done.result.requestId);
    if (!request) throw new Error("missing request");
    const orphanId = "11111111-2222-4333-8444-555555555555";
    const dir = join(root, ".pi", "pi-wai-advisor", "requests", orphanId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "request.json"), JSON.stringify({ ...request, requestId: orphanId }));
    writeFileSync(join(dir, "running.json"), JSON.stringify({ pid: 999999, host: "elsewhere" }));
    const key = projectKeyOf(canonicalRoot(root));
    expect(store.markInterrupted(key, () => false)).toEqual([orphanId]);
    const stored = store.readResult(orphanId, key);
    expect(stored?.result.state).toBe("failed");
    expect(stored?.result.warnings[0]).toMatch(/Interrupted/);
    expect(stored?.result.usage.modelCalls).toBe(0);
  });

  it("previousRequestId imports only a bounded, historical-labelled summary", async () => {
    const root = project("kotlin-android");
    const model = new ScriptedModel([
      answerTurn({ recommendation: "first advice" }),
      (req) => {
        expect(req.user).toMatch(/<historical_advice>\nHISTORICAL advice from request/);
        expect(req.user).toContain("first advice");
        return answerTurn();
      },
    ]);
    const h = harness(root, realHost(root), model);
    const first = ok(await h.controller.consult(h.ctx(), { question: "q?", mode: "quick" }));
    ok(await h.controller.consult(h.ctx(), { question: "follow-up?", mode: "quick", previousRequestId: first.result.requestId }));
  });

  it("keeps every return channel within maxReturnChars, surfacing at most 3 decisions", async () => {
    const root = project("kotlin-android");
    const huge = answerTurn({
      recommendation: "R".repeat(2000),
      rationale: "x".repeat(4000),
      missingEvidence: Array.from({ length: 12 }, (_, i) => `missing item ${i} ${"m".repeat(500)}`),
      humanDecisions: Array.from({ length: 10 }, (_, i) => ({ question: `decision ${i}?`, recommendation: "r".repeat(500), impact: "i" })),
    });
    for (const maxReturnChars of [4000, 1200, 600]) {
      const h = harness(root, realHost(root), new ScriptedModel([huge]), withLimits({ maxReturnChars }));
      const res = ok(await h.controller.consult(h.ctx({ chatId: `c${maxReturnChars}` }), { question: "q?", mode: "quick" }));
      expect(res.compact.size).toBeLessThanOrEqual(maxReturnChars);
      expect(returnSize(res.compact.text, res.compact.details)).toBe(res.compact.size);
      expect(JSON.stringify(res.compact.details).length).toBeLessThan(250); // no archive hidden in details
      expect(res.compact.text).toContain(res.result.requestId);
      if (maxReturnChars >= 1200) {
        expect(res.compact.text).toContain(STANDING_LIMIT);
        expect(res.compact.text).toMatch(/Human decisions needed: 10 \(3 shown; 7 more in the detailed result\)/);
      }
    }
  });

  it("compactReturn degrades gracefully at the minimum size", () => {
    const result = {
      schemaVersion: 1 as const,
      requestId: "8f0430a1-9962-4c44-8912-e70ce923e821",
      projectKey: "k",
      state: "stale" as const,
      answer: null,
      authority: "none" as const,
      deliveryVerified: false as const,
      model: { provider: "p", id: "m" },
      evidenceIds: [],
      freshness: { scope: "not_checked" as const, checkedAt: null, changedEvidenceIds: [], unavailableEvidenceIds: [] },
      usage: { modelCalls: 0, evidenceRequests: 0, estimatedInputTokens: 0, actualInputTokens: null, actualOutputTokens: null, cachedInputTokens: null, costUsd: null, costBasis: "unknown" as const },
      limitsHit: [],
      warnings: ["Stale: cited evidence changed before publication (E1)." + "z".repeat(3000)],
      startedAt: "",
      completedAt: "",
    };
    const out = compactReturn({ result, request: { requestId: result.requestId, mode: "inspect" }, ledger: null, resultPath: ".pi/x/result.json", audience: "tool" }, 600);
    expect(out.size).toBeLessThanOrEqual(600);
    expect(out.text).toMatch(/\[stale\]/);
  });
});
