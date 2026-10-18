/**
 * Private runtime store: <project>/.pi/pi-wai-advisor/
 *   requests/<id>/{request.json, running.json, evidence-index.json, events.jsonl, result.json, ANSWER.md}
 *   history.json
 *
 * Writes are atomic (temp + rename) and confined to this directory, whose real path
 * must stay inside the project root. No provider transcripts, credentials or whole
 * source files are stored; evidence is kept as references, hashes and bounded,
 * already-redacted excerpts. Questions and excerpts can still be sensitive.
 */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AdvisorRequest, AdvisorResult, EvidenceRecord } from "../contracts.ts";
import type { LedgerEntry } from "../evidence/ledger.ts";

export const RUNTIME_DIR = join(".pi", "pi-wai-advisor");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_HISTORY = 200;
const MAX_EVENTS = 300;
const EXCERPT_CHARS = 1500;

export interface HistoryEntry {
  requestId: string;
  createdAt: string;
  completedAt?: string;
  state: string;
  mode: string;
  caller: string;
  questionPreview: string;
  model: string;
}

export class StoreError extends Error {}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class RequestStore {
  private readonly base: string;
  private eventCounts = new Map<string, number>();

  constructor(private readonly projectRoot: string) {
    this.base = resolve(projectRoot, RUNTIME_DIR);
  }

  /** Project-relative display path of a request artifact. */
  relativePath(requestId: string, file: string): string {
    return [".pi", "pi-wai-advisor", "requests", requestId, file].join("/");
  }

  /** Create `path` one segment at a time below the root, refusing links before creating anything. */
  private ensureDir(path: string): void {
    const rel = relative(resolve(this.projectRoot), resolve(path));
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new StoreError("Advisor runtime directory is outside the project root.");
    let current = resolve(this.projectRoot);
    for (const segment of rel.split(sep)) {
      current = join(current, segment);
      let stat;
      try {
        stat = lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        mkdirSync(current);
        continue;
      }
      if (stat.isSymbolicLink()) throw new StoreError(`${relative(this.projectRoot, current)} is a symbolic link/junction; refusing to write advisor records through it.`);
      if (!stat.isDirectory()) throw new StoreError(`${relative(this.projectRoot, current)} is not a directory; refusing to write advisor records.`);
    }
    const rootReal = realpathSync.native(this.projectRoot);
    const realRel = relative(rootReal, realpathSync.native(path));
    if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new StoreError("Advisor runtime directory resolves outside the project root; refusing to write.");
  }

  private requestDir(requestId: string, create = false): string {
    if (!UUID.test(requestId)) throw new StoreError("Invalid request ID.");
    const dir = join(this.base, "requests", requestId);
    if (create) {
      this.ensureDir(this.base);
      this.ensureDir(join(this.base, "requests"));
      this.ensureDir(dir);
    }
    return dir;
  }

  private writeAtomic(path: string, content: string): void {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  }

  saveRequest(request: AdvisorRequest): void {
    const dir = this.requestDir(request.requestId, true);
    this.writeAtomic(join(dir, "request.json"), `${JSON.stringify(request, null, 2)}\n`);
    this.writeAtomic(join(dir, "running.json"), `${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: request.createdAt })}\n`);
  }

  appendEvent(requestId: string, event: Record<string, unknown>): void {
    const count = this.eventCounts.get(requestId) ?? 0;
    if (count >= MAX_EVENTS) return;
    this.eventCounts.set(requestId, count + 1);
    const dir = this.requestDir(requestId);
    if (!existsSync(dir)) return;
    appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
  }

  /** Persist the result; returns a history-index error (the result itself is saved) or null. */
  saveResult(result: AdvisorResult, evidence: readonly LedgerEntry[], answerMarkdown: string, request: AdvisorRequest): string | null {
    const dir = this.requestDir(result.requestId, true);
    const index = evidence.map((entry) => ({
      ...entry.record,
      excerpt: entry.text.length > EXCERPT_CHARS ? `${entry.text.slice(0, EXCERPT_CHARS)}\n…[excerpt truncated; ${entry.text.length} chars retained in-request]` : entry.text,
    }));
    this.writeAtomic(join(dir, "evidence-index.json"), `${JSON.stringify(index, null, 2)}\n`);
    this.writeAtomic(join(dir, "ANSWER.md"), answerMarkdown);
    this.writeAtomic(join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    try {
      unlinkSync(join(dir, "running.json"));
    } catch {
      /* already absent */
    }
    try {
      this.updateHistory({
        requestId: result.requestId,
        createdAt: request.createdAt,
        completedAt: result.completedAt,
        state: result.state,
        mode: request.mode,
        caller: request.caller.kind,
        questionPreview: request.question.replace(/\s+/g, " ").slice(0, 120),
        model: `${request.model.provider}/${request.model.id}${request.model.effort ? `:${request.model.effort}` : ""}`,
      });
      return null;
    } catch (error) {
      return `The result was saved, but history.json could not be updated: ${(error as Error).message}`;
    }
  }

  private withLock<T>(fn: () => T): T {
    const lock = join(this.base, "history.lock");
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lock).mtimeMs > 30_000) {
            rmdirSync(lock);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) throw new StoreError("History is locked by another writer.");
        sleepSync(25);
      }
    }
    try {
      return fn();
    } finally {
      try {
        rmdirSync(lock);
      } catch {
        /* released */
      }
    }
  }

  private updateHistory(entry: HistoryEntry): void {
    this.ensureDir(this.base);
    this.withLock(() => {
      const history = this.readHistory().filter((h) => h.requestId !== entry.requestId);
      history.unshift(entry);
      this.writeAtomic(join(this.base, "history.json"), `${JSON.stringify(history.slice(0, MAX_HISTORY), null, 2)}\n`);
    });
  }

  readHistory(): HistoryEntry[] {
    try {
      const parsed = JSON.parse(readFileSync(join(this.base, "history.json"), "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed.filter((h) => h && typeof h === "object" && typeof (h as HistoryEntry).requestId === "string") as HistoryEntry[]) : [];
    } catch {
      return [];
    }
  }

  readRequest(requestId: string): AdvisorRequest | null {
    try {
      return JSON.parse(readFileSync(join(this.requestDir(requestId), "request.json"), "utf8")) as AdvisorRequest;
    } catch {
      return null;
    }
  }

  /** Explicit, same-project lookup. Returns null when missing; throws StoreError when corrupt. */
  readResult(requestId: string, projectKey: string): { result: AdvisorResult; answer: string; evidence: Array<EvidenceRecord & { excerpt?: string }> } | null {
    const dir = this.requestDir(requestId);
    if (!existsSync(join(dir, "result.json"))) return null;
    let result: AdvisorResult;
    try {
      result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as AdvisorResult;
    } catch {
      throw new StoreError(`Stored result ${requestId} is corrupt and cannot be read.`);
    }
    if (result.projectKey !== projectKey || result.requestId !== requestId) throw new StoreError("Stored result belongs to a different project or request.");
    let answer = "";
    let evidence: Array<EvidenceRecord & { excerpt?: string }> = [];
    try {
      answer = readFileSync(join(dir, "ANSWER.md"), "utf8");
    } catch {
      /* optional */
    }
    try {
      const parsed = JSON.parse(readFileSync(join(dir, "evidence-index.json"), "utf8")) as unknown;
      if (Array.isArray(parsed)) evidence = parsed as typeof evidence;
    } catch {
      /* optional */
    }
    return { result, answer, evidence };
  }

  /**
   * Mark requests that never finished (no result.json, writer process gone) as failed
   * with an interruption reason. Never resumes or restarts paid work.
   */
  markInterrupted(projectKey: string, isActive: (requestId: string) => boolean): string[] {
    const marked: string[] = [];
    const dir = join(this.base, "requests");
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return marked;
    }
    for (const name of names) {
      if (!UUID.test(name) || isActive(name)) continue;
      const reqDir = join(dir, name);
      if (existsSync(join(reqDir, "result.json"))) continue;
      try {
        const running = JSON.parse(readFileSync(join(reqDir, "running.json"), "utf8")) as { pid?: number; host?: string };
        // Same host and a live writer (including this process, whose previous runtime may still
        // be finishing after /new or /reload): not interrupted.
        if (running.host === hostname() && typeof running.pid === "number" && (running.pid === process.pid || pidAlive(running.pid))) continue;
      } catch {
        /* no marker: treat as interrupted */
      }
      const request = this.readRequest(name);
      if (!request) continue;
      const now = new Date().toISOString();
      const result: AdvisorResult = {
        schemaVersion: 1,
        requestId: name,
        projectKey,
        state: "failed",
        answer: null,
        authority: "none",
        deliveryVerified: false,
        model: request.model,
        evidenceIds: [],
        freshness: { scope: "not_checked", checkedAt: null, changedEvidenceIds: [], unavailableEvidenceIds: [] },
        usage: { modelCalls: 0, evidenceRequests: 0, estimatedInputTokens: 0, actualInputTokens: null, actualOutputTokens: null, cachedInputTokens: null, costUsd: null, costBasis: "unknown" },
        limitsHit: [],
        warnings: ["Interrupted: Pi stopped before this consultation finished. It was not resumed; any provider usage already incurred is unknown. Re-run explicitly if still needed."],
        startedAt: request.createdAt,
        completedAt: now,
      };
      try {
        this.saveResult(result, [], `# WAI Advisor — ${name}\n\nState: **failed** (interrupted). Not resumed.\n`, request);
        marked.push(name);
      } catch {
        /* leave untouched */
      }
    }
    return marked;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
