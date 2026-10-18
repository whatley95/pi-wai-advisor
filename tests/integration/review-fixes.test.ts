/**
 * Regression tests for the independent whole-change review findings (H1–H2, M1–M7, L1–L8).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/config.ts";
import { Budget } from "../../src/core/budget.ts";
import type { ConsultOutcome, ConsultResponse } from "../../src/core/controller.ts";
import { EvidenceBroker } from "../../src/evidence/broker.ts";
import { EvidenceLedger } from "../../src/evidence/ledger.ts";
import { snapshotCapabilities } from "../../src/evidence/native-tools.ts";
import { canonicalRoot, classifyPath } from "../../src/evidence/path-policy.ts";
import { redactSecrets } from "../../src/evidence/redact.ts";
import { compactReturn } from "../../src/integration/compact-output.ts";
import { RequestStore, StoreError } from "../../src/storage/request-store.ts";
import { defaultSection, harness, project, registry, tempDir } from "../helpers/harness.ts";
import { realHost } from "../helpers/hosts.ts";
import { answerTurn, evidenceIdFor, evidenceTurn, ScriptedModel } from "../helpers/scripted-model.ts";

function ok(res: ConsultResponse): ConsultOutcome {
  if (res.kind !== "result") throw new Error(`Expected a result, got: ${res.message}`);
  return res;
}

function brokerFor(root: string, limits: Partial<typeof DEFAULT_LIMITS> = {}) {
  const host = realHost(root);
  const merged = { ...DEFAULT_LIMITS, maxEvidenceRequests: 20, ...limits };
  const budget = new Budget(merged, 16000, 1200, { inputPerMTok: null, outputPerMTok: null });
  const ledger = new EvidenceLedger();
  const broker = new EvidenceBroker(host, canonicalRoot(root), ledger, budget, snapshotCapabilities(host), new AbortController().signal, { maxReadChars: merged.maxReadChars, maxEvidenceBytes: merged.maxEvidenceBytes });
  return { host, broker, ledger };
}

const REPO = "app/src/main/java/com/example/history/HistoryRepository.kt";

describe("H1: host-side search exclusions", () => {
  it("the host never matches inside excluded files, including case variants", async () => {
    const root = project("kotlin-android");
    for (const [path, content] of [
      [".ENV.local", "needle-xyz"],
      ["config/secrets.yml", "needle-xyz"],
      ["keys/server.PEM", "needle-xyz"],
      ["node_modules/pkg/index.js", "needle-xyz"],
      [".git/config", "needle-xyz"],
      ["app/src/main/java/com/acme/build/Builder.java", "class Builder { /* needle-xyz */ }"],
    ] as const) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const { broker } = brokerFor(root);
    const [r] = await broker.executeBatch([{ tool: "search_code", query: "needle-xyz", literal: true }]);
    if (r?.kind !== "evidence") throw new Error("expected evidence");
    expect(r.entry.hits?.map((h) => h.path)).toEqual(["app/src/main/java/com/acme/build/Builder.java"]);
    expect(r.entry.record.label).not.toMatch(/withheld/); // nothing reached the broker to withhold
  });

  it("L2: ambiguous generated names are source under src/, still excluded elsewhere", () => {
    expect(classifyPath("app/src/main/java/com/acme/build/Builder.java")).toBeNull();
    expect(classifyPath("modules/target/src/x.ts")?.code).toBe("generated_path");
    expect(classifyPath("web/dist/app.js")?.code).toBe("generated_path");
    expect(classifyPath("app/src/node_modules/x.js")?.code).toBe("generated_path");
  });
});

describe("H2: citations to evidence omitted from the answering call", () => {
  it("are rejected, the result is partial and the omission is visible to the main agent", async () => {
    const root = project("spring-react");
    const controller = "backend/src/main/java/com/example/customer/CustomerController.java";
    const files = ["CustomerService", "Customer"].map((n) => `backend/src/main/java/com/example/customer/${n}.java`);
    const model = new ScriptedModel([
      evidenceTurn({ tool: "read_file", path: controller, startLine: 1, endLine: 60 }, ...files.map((path) => ({ tool: "read_file", path, startLine: 1, endLine: 60 }))),
      (req) => {
        // Evidence whose header is still visible but whose text was omitted from this call.
        const omitted = /\[(E\d+)\] [^\n]*\n\(text omitted to fit the context budget/.exec(req.user);
        if (!omitted) throw new Error(`no omitted evidence in prompt:\n${req.user.slice(0, 2000)}`);
        return answerTurn({ basis: "source_backed", citations: [{ evidenceId: omitted[1] as string, claim: "unseen content", support: "direct_observation" }] });
      },
    ]);
    const h = harness(root, realHost(root), model, defaultSection({ limits: { maxInputTokens: 2600, maxCumulativeInputTokens: 20000 } }));
    const res = ok(await h.controller.consult(h.ctx(), { question: "How is a customer saved?" }));
    expect(res.result.answer?.citations).toHaveLength(0);
    expect(res.result.state).toBe("partial");
    expect(res.result.warnings.join(" ")).toMatch(/omitted from the answering call/);
    expect(res.compact.text).toMatch(/Context: some evidence text did not fit/);
  });
});

describe("M1: deadline during freshness rechecks", () => {
  it("keeps the validated answer and marks it stale/unconfirmed", async () => {
    const root = project("kotlin-android");
    let reads = 0;
    const host = realHost(root, {
      before: async (call) => {
        if (call.name === "read" && ++reads === 2) await new Promise((r) => setTimeout(r, 5000)); // the recheck hangs
      },
    });
    const model = new ScriptedModel([
      evidenceTurn({ tool: "read_file", path: REPO, startLine: 1, endLine: 12 }),
      (req) => answerTurn({ recommendation: "Key the cache by account.", basis: "source_backed", citations: [{ evidenceId: evidenceIdFor(req.user, REPO), claim: "x", startLine: 10, endLine: 10, support: "direct_observation" }] }),
    ]);
    const h = harness(root, host, model, defaultSection({ limits: { maxWallTimeMs: 1500 } }));
    const res = ok(await h.controller.consult(h.ctx(), { question: "Is HistoryRepository safe?" }));
    expect(res.result.state).toBe("stale");
    expect(res.result.answer?.recommendation).toBe("Key the cache by account.");
    expect(res.result.freshness.unavailableEvidenceIds).toHaveLength(1);
    expect(res.result.limitsHit).toContain("maxWallTimeMs");
  });
});

describe("M3: caller-supplied secrets are not persisted", () => {
  it("redacts supplied evidence before writing request.json", async () => {
    const root = project("python-svc");
    const h = harness(root, realHost(root), new ScriptedModel([answerTurn()]));
    const res = ok(
      await h.controller.consult(h.ctx(), {
        question: "What failed?",
        mode: "quick",
        suppliedEvidence: [{ label: "log", text: 'ERROR auth failed api_key="sk-live-abcdefghijklmnopqrstuvwxyz123456"', sourceKind: "caller_log" }],
      }),
    );
    const dir = join(root, ".pi", "pi-wai-advisor", "requests", res.result.requestId);
    for (const file of readdirSync(dir)) expect(readFileSync(join(dir, file), "utf8"), file).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });
});

describe("M4: busy slot and epoch are claimed before any await", () => {
  it("concurrent consultations in one chat get busy even while auth resolves asynchronously", async () => {
    const root = project("kotlin-android");
    const reg = registry();
    reg.hasConfiguredAuth = () => false;
    reg.getProviderAuth = () => new Promise((r) => setTimeout(() => r({ auth: {} }), 50));
    const h = harness(root, realHost(root), new ScriptedModel([answerTurn()]));
    const [a, b] = await Promise.all([
      h.controller.consult(h.ctx({ registry: reg }), { question: "q1?", mode: "quick" }),
      h.controller.consult(h.ctx({ registry: reg }), { question: "q2?", mode: "quick" }),
    ]);
    expect(ok(a).result.state).toBe("completed");
    expect(b).toMatchObject({ kind: "rejected", busy: true });
  });

  it("a session change during preflight prevents the consultation from starting", async () => {
    const root = project("kotlin-android");
    const reg = registry();
    reg.hasConfiguredAuth = () => false;
    reg.getProviderAuth = () => new Promise((r) => setTimeout(() => r({ auth: {} }), 50));
    const model = new ScriptedModel([]);
    const h = harness(root, realHost(root), model);
    const pending = h.controller.consult(h.ctx({ registry: reg }), { question: "q?", mode: "quick" });
    h.controller.invalidateAll("session_changed");
    expect((await pending).kind).toBe("rejected");
    expect(model.callCount).toBe(0);
  });
});

describe("M5: hung host calls are bounded by the deadline", () => {
  it("a host tool that never returns cannot hold the consultation past maxWallTimeMs", async () => {
    const root = project("kotlin-android");
    const host = realHost(root, { before: () => new Promise(() => {}) }); // e.g. a pending permission prompt
    const h = harness(root, host, new ScriptedModel([]), defaultSection({ limits: { maxWallTimeMs: 1200 } }));
    const started = Date.now();
    const res = ok(await h.controller.consult(h.ctx(), { question: "Why does HistoryScreen leak?" }));
    expect(Date.now() - started).toBeLessThan(4000);
    expect(res.result.limitsHit).toContain("maxWallTimeMs");
  });
});

describe("low-severity fixes", () => {
  it("L1: whole private-key blocks and bare key bodies are redacted, line count preserved", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvuNMoSfm76oqFvAp8Gy0iz5sxjZmSnXyCdPEovGhLa0VzMaQ8s+CLOyS56YyCFGeJZ";
    const pem = ["-----BEGIN PRIVATE KEY-----", body.slice(0, 64), body.slice(64, 128), "-----END PRIVATE KEY-----"].join("\n");
    const { text } = redactSecrets(`a\n${pem}\nb`);
    expect(text).not.toContain(body.slice(0, 40));
    expect(text.split("\n")).toHaveLength(6);
    expect(redactSecrets(body.slice(0, 64)).text).toBe("[REDACTED]");
  });

  it("L3: the return bound holds for escape-heavy content", () => {
    const nasty = '"\\\n'.repeat(3000);
    const result = {
      schemaVersion: 1 as const,
      requestId: "8f0430a1-9962-4c44-8912-e70ce923e821",
      projectKey: "k",
      state: "partial" as const,
      answer: { recommendation: nasty, rationale: "", basis: "general_reasoning" as const, citations: [], verificationSuggestions: [], missingEvidence: [nasty], risks: [], humanDecisions: [{ question: nasty, recommendation: nasty, impact: "" }] },
      authority: "none" as const,
      deliveryVerified: false as const,
      model: { provider: "p", id: "m" },
      evidenceIds: [],
      freshness: { scope: "not_checked" as const, checkedAt: null, changedEvidenceIds: [], unavailableEvidenceIds: [] },
      usage: { modelCalls: 1, evidenceRequests: 0, estimatedInputTokens: 0, actualInputTokens: null, actualOutputTokens: null, cachedInputTokens: null, costUsd: null, costBasis: "unknown" as const },
      limitsHit: [],
      warnings: [`Partial: ${nasty}`],
      startedAt: "",
      completedAt: "",
    };
    for (const max of [600, 1000, 4000]) {
      const out = compactReturn({ result, request: { requestId: result.requestId, mode: "quick" }, ledger: null, resultPath: '.pi/"x"\\result.json', audience: "tool" }, max);
      expect(out.size).toBeLessThanOrEqual(max);
    }
  });

  it("L4: approval language in advice is surfaced in the compact output", async () => {
    const root = project("python-svc");
    const h = harness(root, realHost(root), new ScriptedModel([answerTurn({ recommendation: "Approved, ready to merge." })]));
    const res = ok(await h.controller.consult(h.ctx(), { question: "ok?", mode: "quick" }));
    expect(res.compact.text).toMatch(/Advice text uses pass\/approval language/);
  });

  it("L5: different searches with identical (empty) output get distinct evidence IDs", async () => {
    const { broker } = brokerFor(project("python-svc"));
    const [a, b] = await broker.executeBatch([
      { tool: "search_code", query: "zzz-not-here-1", literal: true },
      { tool: "search_code", query: "zzz-not-here-2", literal: true },
    ]);
    if (a?.kind !== "evidence" || b?.kind !== "evidence") throw new Error("expected evidence");
    expect(a.entry.record.id).not.toBe(b.entry.record.id);
    expect(b.reused).toBe(false);
  });

  it("L6: a search page trimmed to the evidence budget is not falsely stale", async () => {
    const root = project("python-svc");
    writeFileSync(join(root, "app", "many.py"), Array.from({ length: 40 }, (_, i) => `# marker line ${i} ${"x".repeat(40)}`).join("\n"));
    const { broker } = brokerFor(root, { maxEvidenceBytes: 700, maxReadChars: 600 });
    const [r] = await broker.executeBatch([{ tool: "search_code", query: "marker line", literal: true }]);
    if (r?.kind !== "evidence") throw new Error("expected evidence");
    expect(await broker.recheck(r.entry)).toBe("same");
  });

  it("L7: a symlinked .pi is refused before anything is created outside the root", () => {
    const root = tempDir();
    const outside = tempDir("wai-outside-");
    symlinkSync(outside, join(root, ".pi"), "junction");
    const store = new RequestStore(root);
    const request = { requestId: "11111111-2222-4333-8444-555555555555", createdAt: "x" } as never;
    expect(() => store.saveRequest(request)).toThrow(StoreError);
    expect(existsSync(join(outside, "pi-wai-advisor"))).toBe(false);
  });

  it("L8: a final bracketed source line is not mistaken for a host notice", async () => {
    const root = project("python-svc");
    writeFileSync(join(root, "app", "list.py"), "values = [\n    1,\n\n[2]");
    const { broker } = brokerFor(root);
    const [r] = await broker.executeBatch([{ tool: "read_file", path: "app/list.py", startLine: 1, endLine: 10 }]);
    if (r?.kind !== "evidence") throw new Error("expected evidence");
    expect(r.entry.lines?.at(-1)).toBe("[2]");
  });
});
