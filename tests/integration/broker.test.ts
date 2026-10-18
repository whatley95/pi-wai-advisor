import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/config.ts";
import { Budget } from "../../src/core/budget.ts";
import { EvidenceBroker } from "../../src/evidence/broker.ts";
import { EvidenceLedger } from "../../src/evidence/ledger.ts";
import { snapshotCapabilities } from "../../src/evidence/native-tools.ts";
import { canonicalRoot } from "../../src/evidence/path-policy.ts";
import { project } from "../helpers/harness.ts";
import { type RealHostOptions, realHost } from "../helpers/hosts.ts";

function setup(fixture = "kotlin-android", limits: Partial<typeof DEFAULT_LIMITS> = {}, hostOptions: RealHostOptions = {}) {
  const root = project(fixture);
  const host = realHost(root, hostOptions);
  const merged = { ...DEFAULT_LIMITS, maxEvidenceRequests: 20, ...limits };
  const budget = new Budget(merged, 16000, 1200, { inputPerMTok: null, outputPerMTok: null });
  const ledger = new EvidenceLedger();
  const broker = new EvidenceBroker(host, canonicalRoot(root), ledger, budget, snapshotCapabilities(host), new AbortController().signal, {
    maxReadChars: merged.maxReadChars,
    maxEvidenceBytes: merged.maxEvidenceBytes,
  });
  return { root, host, budget, ledger, broker };
}

const REPO = "app/src/main/java/com/example/history/HistoryRepository.kt";

describe("broker bounds and file handling", () => {
  it("binary content and over-long lines are not source evidence", async () => {
    const { root, broker } = setup();
    writeFileSync(join(root, "blob"), Buffer.from([0x41, 0x00, 0x42, 0x0a]));
    writeFileSync(join(root, "minified.js"), `${"x".repeat(60_000)}\n`);
    const [bin, long] = await broker.executeBatch([
      { tool: "read_file", path: "blob", startLine: 1, endLine: 5 },
      { tool: "read_file", path: "minified.js", startLine: 1, endLine: 5 },
    ]);
    expect(bin?.kind === "evidence" && bin.entry.record.error?.code).toBe("binary_file");
    expect(long?.kind === "evidence" && long.entry.record.error?.code).toBe("line_too_long");
  });

  it("caps oversize ranges by lines and characters with continuation metadata", async () => {
    const { root, broker } = setup("kotlin-android", { maxReadChars: 2000, maxEvidenceBytes: 32768 });
    writeFileSync(join(root, "Big.kt"), Array.from({ length: 5000 }, (_, i) => `val line${i + 1} = ${i + 1}`).join("\n"));
    const [r] = await broker.executeBatch([{ tool: "read_file", path: "Big.kt", startLine: 100, endLine: 4000 }]);
    if (r?.kind !== "evidence") throw new Error("expected evidence");
    const rec = r.entry.record;
    expect(rec.startLine).toBe(100);
    expect(rec.truncated).toBe(true);
    expect(rec.endLine).toBeLessThan(400);
    expect(rec.continuation?.nextStartLine).toBe((rec.endLine as number) + 1);
    expect(r.entry.lines?.[0]).toBe("val line100 = 100"); // stable line numbers
    expect(r.entry.text.length).toBeLessThanOrEqual(2000);
  });

  it("search: no matches, pagination cursor and per-hit policy filtering", async () => {
    const { root, broker } = setup();
    writeFileSync(join(root, "Many.kt"), Array.from({ length: 120 }, (_, i) => `// marker ${i}`).join("\n"));
    const [none, page1] = await broker.executeBatch([
      { tool: "search_code", query: "definitely-not-present-xyz", literal: true },
      { tool: "search_code", query: "marker", literal: true },
    ]);
    if (none?.kind !== "evidence" || page1?.kind !== "evidence") throw new Error("expected evidence");
    expect(none.entry.hits).toEqual([]);
    expect(page1.entry.record.truncated).toBe(true);
    const cursor = page1.entry.record.continuation?.cursor;
    expect(cursor).toBe("40");
    const [page2] = await broker.executeBatch([{ tool: "search_code", query: "marker", literal: true, cursor }]);
    if (page2?.kind !== "evidence") throw new Error("expected evidence");
    expect(page2.entry.hits?.[0]?.line).toBeGreaterThan(page1.entry.hits?.at(-1)?.line ?? 0);
  });

  it("listing excludes VCS/generated/sensitive entries and reports withheld counts", async () => {
    const { root, broker } = setup();
    writeFileSync(join(root, ".env"), "SECRET=1");
    const [list] = await broker.executeBatch([{ tool: "list_files" }]);
    if (list?.kind !== "evidence") throw new Error("expected evidence");
    expect(list.entry.paths).toContain(REPO);
    expect(list.entry.paths?.some((p) => p.includes(".env"))).toBe(false);
    expect(list.entry.record.label).toMatch(/withheld/);
  });

  it("repeated unchanged reads re-check the host and still consume allowance, reusing the ID", async () => {
    const { broker, budget, host } = setup();
    const req = { tool: "read_file" as const, path: REPO, startLine: 1, endLine: 10 };
    const [a] = await broker.executeBatch([req]);
    const [b] = await broker.executeBatch([req]);
    if (a?.kind !== "evidence" || b?.kind !== "evidence") throw new Error("expected evidence");
    expect(b.reused).toBe(true);
    expect(b.entry.record.id).toBe(a.entry.record.id);
    expect(budget.evidenceRequests).toBe(2);
    expect(host.calls.filter((c) => c.name === "read")).toHaveLength(2);
  });

  it("parallel reads reserve allowance before dispatch, never exceed it, and run at most two at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { broker, budget, host } = setup("kotlin-android", { maxEvidenceRequests: 2 }, {
      before: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
      },
    });
    const results = await broker.executeBatch([
      { tool: "read_file", path: REPO, startLine: 1, endLine: 3 },
      { tool: "read_file", path: REPO, startLine: 4, endLine: 6 },
      { tool: "read_file", path: REPO, startLine: 7, endLine: 9 },
    ]);
    expect(results.map((r) => r.kind)).toEqual(["evidence", "evidence", "skipped"]);
    expect(budget.evidenceRequests).toBe(2);
    expect(host.calls).toHaveLength(2);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    // Deterministic IDs in request order.
    expect(results.slice(0, 2).map((r) => (r.kind === "evidence" ? r.entry.record.id : ""))).toEqual(["E1", "E2"]);
  });

  it("host error text never forwards absolute local paths", async () => {
    let root = "";
    const s = setup("kotlin-android", {}, { deny: () => `Path not found: ${join(root, "missing", "X.kt")} (also C:\\Users\\someone\\secret.txt and /home/someone/x)` });
    root = s.root;
    const [r] = await s.broker.executeBatch([{ tool: "read_file", path: "missing/X.kt", startLine: 1, endLine: 2 }]);
    if (r?.kind !== "evidence") throw new Error("expected evidence");
    const message = r.entry.record.error?.message ?? "";
    expect(message).toContain("<project>");
    expect(message).not.toContain(s.root);
    expect(message).not.toMatch(/C:\\Users|\/home\/someone/);
  });

  it("retained evidence bytes are bounded; overflow is truncated or refused, never silently kept", async () => {
    const { broker, ledger, budget } = setup("spring-react", { maxEvidenceBytes: 900, maxReadChars: 800 });
    const files = ["CustomerController", "CustomerService", "Customer"].map((n) => `backend/src/main/java/com/example/customer/${n}.java`);
    await broker.executeBatch(files.map((path) => ({ tool: "read_file" as const, path, startLine: 1, endLine: 60 })));
    expect(ledger.retainedBytes()).toBeLessThanOrEqual(900);
    expect(budget.limitsHit.has("maxEvidenceBytes")).toBe(true);
  });
});
