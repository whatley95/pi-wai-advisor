/**
 * Read-only evidence broker. Capabilities: read_file, search_code, list_files.
 * There is no command/write/diff capability and no fallback path: every source
 * access is a permission-checked host tool call (see native-tools.ts).
 *
 * Policy is applied to scopes, every search hit and listing entry, and every read,
 * before and after the host call. Allowance is reserved before dispatch.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Capability, EvidenceRequest, SuppliedEvidence } from "../contracts.ts";
import type { Budget } from "../core/budget.ts";
import { type EvidenceLedger, type LedgerEntry, type NewEvidence, type SearchHit, sha256, utf8Bytes } from "./ledger.ts";
import { type HostToolName, type NativeToolHost } from "./native-tools.ts";
import { checkContainment, checkPolicyPath, classifyPath, normalizeRelativePath, type ProjectRoot, searchExcludeGlob } from "./path-policy.ts";
import { redactSecrets } from "./redact.ts";

export interface BrokerLimits {
  maxReadChars: number;
  maxEvidenceBytes: number;
  maxLinesPerRead: number;
  maxSearchHits: number;
  maxListEntries: number;
  maxHitChars: number;
}

export const DEFAULT_BROKER_LIMITS: Omit<BrokerLimits, "maxReadChars" | "maxEvidenceBytes"> = {
  maxLinesPerRead: 400,
  maxSearchHits: 40,
  maxListEntries: 150,
  maxHitChars: 240,
};

/** Internal listing request; `pattern` is used only by controller discovery, never by the model. */
export type BrokerRequest = EvidenceRequest | { tool: "list_files"; path?: string; cursor?: string; pattern?: string };

export type BrokerResult =
  | { kind: "evidence"; entry: LedgerEntry; reused: boolean; request: BrokerRequest }
  | { kind: "skipped"; request: BrokerRequest; reason: string };

export type ProgressFn = (message: string) => void;

export class AbortedError extends Error {
  constructor(message = "Consultation cancelled.") {
    super(message);
    this.name = "AbortedError";
  }
}

function describe(request: BrokerRequest): string {
  switch (request.tool) {
    case "read_file":
      return `read ${request.path}:${request.startLine}-${request.endLine}`;
    case "search_code":
      return `search "${request.query}"${request.path ? ` in ${request.path}` : ""}`;
    case "list_files":
      return `list ${request.path || "."}`;
    case "native_diff":
      return "native diff";
  }
}

function errorEvidence(kind: NewEvidence["kind"], code: string, message: string, extra: Partial<NewEvidence> = {}): NewEvidence {
  return { kind, provenance: "host_observed", truncated: false, error: { code, message: message.slice(0, 300) }, text: "", ...extra };
}

/** Pi 1.3.0 read/grep/find/ls trailing notices (anything else is real content). */
const HOST_NOTICE = /^(Showing lines \d+-\d+ of \d+|\d+ more lines in file\.|\d+ (matches|results|entries) limit reached|[\d.]+\s*[KMG]?B limit reached|Some lines truncated)/;

/** Strip Pi's trailing "[...]" notice block from read/grep/find/ls output. */
function splitNotice(text: string): { body: string; notice: string | null } {
  const match = /\n\n\[([^\n]*)\]$/.exec(text);
  if (!match || !HOST_NOTICE.test(match[1] ?? "")) return { body: text, notice: null };
  return { body: text.slice(0, match.index), notice: match[1] ?? null };
}

/** Resolve with the promise, or reject as soon as the signal aborts (late results are ignored). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AbortedError());
  return new Promise((resolve, reject) => {
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

export class EvidenceBroker {
  private readonly limits: BrokerLimits;

  constructor(
    private readonly host: NativeToolHost | null,
    private readonly root: ProjectRoot,
    private readonly ledger: EvidenceLedger,
    private readonly budget: Budget,
    private readonly capabilities: readonly Capability[],
    private readonly signal: AbortSignal,
    limits: Partial<BrokerLimits> & Pick<BrokerLimits, "maxReadChars" | "maxEvidenceBytes">,
    private readonly progress: ProgressFn = () => {},
  ) {
    this.limits = { ...DEFAULT_BROKER_LIMITS, ...limits };
  }

  hasCapability(capability: Capability): boolean {
    return this.capabilities.includes(capability);
  }

  /** Caller-supplied evidence: labelled caller_supplied, redacted, bounded; no allowance used. */
  addSupplied(items: readonly SuppliedEvidence[]): LedgerEntry[] {
    const added: LedgerEntry[] = [];
    for (const item of items) {
      const { text, redactions } = redactSecrets(item.text);
      const room = this.limits.maxEvidenceBytes - this.ledger.retainedBytes();
      const bounded = utf8Bytes(text) > room ? Buffer.from(text, "utf8").subarray(0, Math.max(0, room)).toString("utf8") : text;
      added.push(
        this.ledger.add({
          kind: item.sourceKind,
          provenance: "caller_supplied",
          truncated: bounded.length < text.length,
          label: item.label.slice(0, 200),
          text: bounded,
          ...(redactions ? { redactions } : {}),
          ...(bounded.length === 0 ? { error: { code: "evidence_budget_exhausted", message: "No evidence byte allowance remained for this supplied item." } } : {}),
        }),
      );
    }
    return added;
  }

  /**
   * Execute up to N requests with at most two concurrent host calls. Allowance is
   * reserved for each request before dispatch; IDs are minted in request order.
   */
  async executeBatch(requests: readonly BrokerRequest[], keepInReserve = 0): Promise<BrokerResult[]> {
    const reserved: Array<{ request: BrokerRequest; ok: boolean; reason?: string }> = requests.map((request) => {
      if (request.tool === "native_diff") return { request, ok: false, reason: "native_diff is not available in this host session." };
      if (this.signal.aborted) return { request, ok: false, reason: "cancelled" };
      const ok = this.budget.reserveEvidence(keepInReserve);
      return ok ? { request, ok } : { request, ok, reason: this.budget.expired() ? "The wall-time deadline passed." : "No evidence-request allowance remains." };
    });
    const pending: Array<NewEvidence | null> = new Array(requests.length).fill(null);
    const queue = reserved.map((r, index) => ({ ...r, index })).filter((r) => r.ok);
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        this.progress(`${describe(next.request)} (evidence ${this.budget.evidenceRequests}/${this.budget.limits.maxEvidenceRequests})`);
        pending[next.index] = await this.run(next.request);
      }
    };
    await Promise.all([worker(), worker()]);
    if (this.signal.aborted) throw new AbortedError();
    return reserved.map((r, index) => {
      if (!r.ok) return { kind: "skipped", request: r.request, reason: r.reason ?? "skipped" };
      return this.commit(r.request, pending[index] as NewEvidence);
    });
  }

  /** Re-run the request behind an entry (freshness recheck); consumes allowance. */
  async recheck(entry: LedgerEntry): Promise<"same" | "changed" | "unavailable"> {
    if (!entry.request || entry.record.error || entry.record.provenance !== "host_observed") return "unavailable";
    if (!this.budget.reserveEvidence(0)) return "unavailable";
    const request: BrokerRequest =
      entry.request.tool === "read_file"
        ? { ...entry.request, startLine: entry.record.startLine ?? entry.request.startLine, endLine: entry.record.endLine ?? entry.request.endLine }
        : entry.request.tool === "search_code"
          ? { tool: "search_code", query: entry.request.query, path: entry.request.path || undefined, literal: true, cursor: entry.request.cursor }
          : { ...entry.request };
    this.progress(`recheck ${entry.record.id}`);
    const fresh = await this.run(request, true);
    if (this.signal.aborted) throw new AbortedError();
    if (fresh.error) return "unavailable";
    if (entry.record.kind === "source_range" && (fresh.startLine !== entry.record.startLine || fresh.endLine !== entry.record.endLine)) return "changed";
    // A page trimmed to fit the evidence budget is compared on its retained prefix only.
    if (entry.hits && fresh.hits) return sha256(fresh.hits.slice(0, entry.hits.length).map(renderHit).join("\n")) === entry.record.digest ? "same" : "changed";
    if (entry.paths && fresh.paths) return sha256(fresh.paths.slice(0, entry.paths.length).join("\n")) === entry.record.digest ? "same" : "changed";
    return sha256(fresh.text) === entry.record.digest ? "same" : "changed";
  }

  private commit(request: BrokerRequest, evidence: NewEvidence): BrokerResult {
    // Identical unchanged result: reuse the earlier ID, do not retain bytes twice.
    if (!evidence.error) {
      const same = this.ledger.findIdentical(evidence.kind, sha256(evidence.text), evidence.path, evidence.startLine, evidence.endLine, evidence.label);
      if (same) return { kind: "evidence", entry: same, reused: true, request };
    }
    const room = this.limits.maxEvidenceBytes - this.ledger.retainedBytes();
    if (!evidence.error && utf8Bytes(evidence.text) > room) {
      const shrunk = this.shrinkToFit(evidence, room);
      if (!shrunk) {
        this.budget.limitsHit.add("maxEvidenceBytes");
        return {
          kind: "evidence",
          entry: this.ledger.add(errorEvidence(evidence.kind, "evidence_budget_exhausted", "The retained-evidence byte allowance is exhausted; this result was not retained.", { path: evidence.path, label: evidence.label, request: evidence.request })),
          reused: false,
          request,
        };
      }
      this.budget.limitsHit.add("maxEvidenceBytes");
      evidence = shrunk;
    }
    return { kind: "evidence", entry: this.ledger.add(evidence), reused: false, request };
  }

  /** Keep whole leading lines/hits/paths that fit `room` bytes. */
  private shrinkToFit(evidence: NewEvidence, room: number): NewEvidence | null {
    const fit = <T>(items: T[], render: (item: T) => string): number => {
      let bytes = 0;
      let count = 0;
      for (const item of items) {
        const size = utf8Bytes(render(item)) + 1;
        if (bytes + size > room) break;
        bytes += size;
        count++;
      }
      return count;
    };
    if (evidence.lines) {
      const keep = fit(evidence.lines, (l) => l);
      if (keep === 0) return null;
      const lines = evidence.lines.slice(0, keep);
      const endLine = (evidence.startLine ?? 1) + keep - 1;
      return { ...evidence, lines, text: lines.join("\n"), endLine, truncated: true, continuation: { nextStartLine: endLine + 1 } };
    }
    if (evidence.hits) {
      const keep = fit(evidence.hits, renderHit);
      if (keep === 0) return null;
      const hits = evidence.hits.slice(0, keep);
      return { ...evidence, hits, text: hits.map(renderHit).join("\n"), truncated: true };
    }
    if (evidence.paths) {
      const keep = fit(evidence.paths, (p) => p);
      if (keep === 0) return null;
      const paths = evidence.paths.slice(0, keep);
      return { ...evidence, paths, text: paths.join("\n"), truncated: true };
    }
    return null;
  }

  private callable(name: HostToolName): boolean {
    return !!this.host && this.host.callableToolNames().includes(name);
  }

  /** Host error text can embed absolute local paths (and the user name); never forward them. */
  private sanitize(message: string): string {
    let out = message;
    for (const [path, label] of [
      [this.root.real, "<project>"],
      [this.root.lexical, "<project>"],
      [homedir(), "<home>"],
    ] as const) {
      for (const variant of new Set([path, path.replaceAll("\\", "/"), path.replaceAll("/", "\\")])) {
        if (variant) out = out.split(variant).join(label);
      }
    }
    return out.replace(/\b[A-Za-z]:[\\/][^\s'"]*/g, "<path>").replace(/(^|\s)\/(?:home|Users|root|tmp|var|private)\/[^\s'"]*/g, "$1<path>");
  }

  private async call(name: HostToolName, args: Record<string, unknown>): Promise<{ text: string; error?: string }> {
    if (!this.host || !this.callable(name)) return { text: "", error: `Host tool '${name}' is not callable in this session (missing, inactive or revoked).` };
    try {
      // Raced against cancellation/deadline: a hung host call (e.g. a permission prompt) cannot hold the request open.
      const outcome = await raceAbort(this.host.execute(name, args, this.signal), this.signal);
      if (outcome.invalid) return { text: "", error: outcome.invalid };
      if (outcome.isError) return { text: "", error: this.sanitize(outcome.text) || `Host ${name} failed without a message.` };
      return { text: outcome.text };
    } catch (error) {
      if (this.signal.aborted || error instanceof AbortedError) throw new AbortedError();
      return { text: "", error: this.sanitize(error instanceof Error ? error.message : String(error)) };
    }
  }

  private async run(request: BrokerRequest, recheck = false): Promise<NewEvidence> {
    switch (request.tool) {
      case "read_file":
        return this.read(request.path, request.startLine, request.endLine);
      case "search_code":
        return this.search(request.query, request.path ?? "", request.cursor);
      case "list_files":
        return this.list(request.path ?? "", request.cursor, "pattern" in request ? request.pattern : undefined, recheck);
      case "native_diff":
        return errorEvidence("native_diff", "capability_unavailable", "native_diff is not available.");
    }
  }

  private async read(rawPath: string, startLine: number, endLine: number): Promise<NewEvidence> {
    const lexical = normalizeRelativePath(rawPath);
    const path = lexical.ok ? lexical.path : undefined;
    const base = { path, label: path ?? "(invalid path)" };
    if (!this.hasCapability("read_file")) return errorEvidence("source_range", "capability_unavailable", "read_file is not available in this session.", base);
    const policy = checkPolicyPath(rawPath);
    if (!policy.ok) return errorEvidence("source_range", policy.code, policy.message, base);
    const before = checkContainment(this.root, policy.path);
    if (!before.ok) return errorEvidence("source_range", before.code, before.message, base);
    if (endLine < startLine) return errorEvidence("source_range", "invalid_range", "endLine is before startLine.", base);
    const span = Math.min(endLine - startLine + 1, this.limits.maxLinesPerRead);
    const request = { tool: "read_file" as const, path: policy.path, startLine, endLine: startLine + span - 1 };

    const result = await this.call("read", { path: policy.path, offset: startLine, limit: span });
    if (result.error) return errorEvidence("source_range", "host_error", result.error, { ...base, request });
    const after = checkContainment(this.root, policy.path);
    if (!after.ok) return errorEvidence("source_range", after.code, `${after.message} (changed during access)`, { ...base, request });

    if (result.text.startsWith("Read image file [")) return errorEvidence("source_range", "binary_file", "Image/binary content is not source evidence.", { ...base, request });
    if (/^\[Line \d+ is .* exceeds .* limit/.test(result.text)) return errorEvidence("source_range", "line_too_long", "The line is too long for the host reader.", { ...base, request });
    const { body, notice } = splitNotice(result.text);
    if (body.includes("\u0000")) return errorEvidence("source_range", "binary_file", "Binary content is not source evidence.", { ...base, request });

    let returned = body.split("\n").map((line) => line.replace(/\r$/, ""));
    const shown = notice ? /^Showing lines (\d+)-(\d+) of (\d+)/.exec(notice) : null;
    const more = notice ? /^(\d+) more lines in file/.exec(notice) : null;
    let truncated = !!shown && Number(shown[2]) < request.endLine;
    if (returned.length > span) returned = returned.slice(0, span);

    // Character page bound at line boundaries; a single oversized line is cut and flagged.
    const kept: string[] = [];
    let chars = 0;
    for (const line of returned) {
      if (chars + line.length + 1 > this.limits.maxReadChars) {
        if (kept.length === 0) kept.push(`${line.slice(0, this.limits.maxReadChars - 40)} …[line truncated]`);
        truncated = true;
        break;
      }
      kept.push(line);
      chars += line.length + 1;
    }
    const redacted = redactSecrets(kept.join("\n"), policy.path);
    const lines = redacted.text.split("\n");
    const last = startLine + lines.length - 1;
    const hasMore = truncated || !!more || (!!shown && Number(shown[2]) < Number(shown[3]));
    return {
      kind: "source_range",
      provenance: "host_observed",
      path: policy.path,
      startLine,
      endLine: last,
      truncated,
      ...(hasMore ? { continuation: { nextStartLine: last + 1 } } : {}),
      ...(redacted.redactions ? { redactions: redacted.redactions } : {}),
      label: `${policy.path}:${startLine}-${last}`,
      text: lines.join("\n"),
      lines,
      request,
    };
  }

  private scopeCheck(raw: string): { ok: true; path: string; isDir: boolean } | { ok: false; code: string; message: string } {
    const policy = checkPolicyPath(raw, true);
    if (!policy.ok) return policy;
    const contained = checkContainment(this.root, policy.path || ".");
    if (!contained.ok) return contained;
    let isDir = true;
    try {
      isDir = statSync(resolve(this.root.lexical, policy.path || ".")).isDirectory();
    } catch {
      /* host reports missing paths */
    }
    return { ok: true, path: policy.path, isDir };
  }

  /** Project-relative path for a host result entry, or null when policy excludes it. */
  private admit(scope: string, scopeIsDir: boolean, rel: string): string | null {
    const joined = scopeIsDir ? (scope ? `${scope}/${rel}` : rel) : scope;
    const lexical = normalizeRelativePath(joined.replace(/\/$/, ""));
    if (!lexical.ok) return null;
    if (classifyPath(lexical.path)) return null;
    if (!checkContainment(this.root, lexical.path).ok) return null;
    return lexical.path;
  }

  private async search(query: string, rawScope: string, cursor?: string): Promise<NewEvidence> {
    const label = `"${query}" in ${rawScope || "."}`;
    if (!this.hasCapability("search_code")) return errorEvidence("search_hits", "capability_unavailable", "search_code is not available in this session.", { label });
    if (query.length < 2 || query.length > 200 || /[\r\n]/.test(query)) return errorEvidence("search_hits", "invalid_query", "Query must be 2-200 characters on one line.", { label });
    const scope = this.scopeCheck(rawScope);
    if (!scope.ok) return errorEvidence("search_hits", scope.code, scope.message, { label });
    const skip = cursor && /^\d{1,4}$/.test(cursor) ? Number(cursor) : 0;
    const request = { tool: "search_code" as const, query, path: scope.path, ...(cursor ? { cursor } : {}) };
    const hostLimit = Math.min(400, skip + this.limits.maxSearchHits * 2);
    // Policy exclusions are enforced host-side so excluded files are never opened; if the host
    // cannot apply them the search fails closed (no broad search without exclusions).
    const result = await this.call("grep", { pattern: query, path: scope.path || ".", literal: true, ignoreCase: true, limit: hostLimit, glob: searchExcludeGlob() });
    if (result.error) return errorEvidence("search_hits", "host_error", result.error, { label, request });

    const { body, notice } = splitNotice(result.text);
    const hostTruncated = !!notice && /limit reached|truncated/i.test(notice);
    const all: SearchHit[] = [];
    let withheld = 0;
    if (body.trim() !== "No matches found") {
      for (const raw of body.split("\n")) {
        const match = /^(.+?):(\d+): ?(.*)$/.exec(raw);
        if (!match) continue;
        const path = this.admit(scope.path, scope.isDir, match[1] as string);
        if (!path) {
          withheld++;
          continue;
        }
        const text = redactSecrets((match[3] as string).replace(/\r$/, ""), path).text;
        all.push({ path, line: Number(match[2]), text: text.length > this.limits.maxHitChars ? `${text.slice(0, this.limits.maxHitChars)}…` : text });
      }
    }
    const page: SearchHit[] = [];
    let chars = 0;
    for (const hit of all.slice(skip, skip + this.limits.maxSearchHits)) {
      const size = renderHit(hit).length + 1;
      if (chars + size > this.limits.maxReadChars) break;
      page.push(hit);
      chars += size;
    }
    const consumed = skip + page.length;
    const truncated = hostTruncated || consumed < all.length;
    const notes = [withheld ? `${withheld} hit(s) in policy-excluded paths withheld` : "", hostTruncated ? "host search limit reached" : ""].filter(Boolean);
    return {
      kind: "search_hits",
      provenance: "host_observed",
      truncated,
      ...(truncated ? { continuation: { cursor: String(consumed) } } : {}),
      label: notes.length ? `${label} (${notes.join("; ")})` : label,
      text: page.map(renderHit).join("\n"),
      hits: page,
      request,
    };
  }

  private async list(rawScope: string, cursor?: string, pattern?: string, _recheck = false): Promise<NewEvidence> {
    const label = `${pattern ? `${pattern.length > 40 ? "build/module manifests" : pattern} under ` : ""}${rawScope || "."}`;
    if (!this.hasCapability("list_files")) return errorEvidence("file_manifest", "capability_unavailable", "list_files is not available in this session.", { label });
    const scope = this.scopeCheck(rawScope);
    if (!scope.ok) return errorEvidence("file_manifest", scope.code, scope.message, { label });
    const skip = cursor && /^\d{1,4}$/.test(cursor) ? Number(cursor) : 0;
    const request = { tool: "list_files" as const, path: scope.path, ...(cursor ? { cursor } : {}), ...(pattern ? { pattern } : {}) };
    const useFind = this.callable("find");
    if (!useFind && pattern) return errorEvidence("file_manifest", "capability_unavailable", "Pattern listing needs the host find tool.", { label, request });
    const result = useFind
      ? await this.call("find", { pattern: pattern ?? "*", path: scope.path || ".", limit: 500 })
      : await this.call("ls", { path: scope.path || ".", limit: 500 });
    if (result.error) return errorEvidence("file_manifest", "host_error", result.error, { label, request });
    const { body, notice } = splitNotice(result.text);
    const hostTruncated = !!notice && /limit reached/i.test(notice);
    const all: string[] = [];
    let withheld = 0;
    const empty = body.trim() === "No files found matching pattern" || body.trim() === "(empty directory)";
    if (!empty) {
      for (const raw of body.split("\n")) {
        const entry = raw.replace(/\r$/, "").trim();
        if (!entry) continue;
        const isDir = entry.endsWith("/");
        const path = this.admit(scope.path, true, entry.replace(/\/$/, ""));
        if (!path) {
          withheld++;
          continue;
        }
        all.push(isDir ? `${path}/` : path);
      }
    }
    all.sort();
    const page: string[] = [];
    let chars = 0;
    for (const path of all.slice(skip, skip + this.limits.maxListEntries)) {
      if (chars + path.length + 1 > this.limits.maxReadChars) break;
      page.push(path);
      chars += path.length + 1;
    }
    const consumed = skip + page.length;
    const truncated = hostTruncated || consumed < all.length;
    const notes = [withheld ? `${withheld} excluded entr${withheld === 1 ? "y" : "ies"} withheld` : "", hostTruncated ? "host listing limit reached; coverage incomplete" : "", useFind ? "" : "non-recursive (ls)"].filter(Boolean);
    return {
      kind: "file_manifest",
      provenance: "host_observed",
      truncated,
      ...(truncated ? { continuation: { cursor: String(consumed) } } : {}),
      path: scope.path || undefined,
      label: notes.length ? `${label} (${notes.join("; ")})` : label,
      text: page.join("\n"),
      paths: page,
      request,
    };
  }
}

export function renderHit(hit: SearchHit): string {
  return `${hit.path}:${hit.line}: ${hit.text}`;
}
