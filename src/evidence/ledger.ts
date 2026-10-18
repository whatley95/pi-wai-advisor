/**
 * Immutable per-request evidence ledger. IDs (E1, E2, ...) are minted here, never
 * by the model. Retained text is exactly what was hashed and shown to the model.
 */
import { createHash } from "node:crypto";
import type { EvidenceKind, EvidenceRecord } from "../contracts.ts";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface LedgerEntry {
  record: EvidenceRecord;
  /** Retained, policy-filtered, redacted text (absent for failures). */
  text: string;
  /** For source ranges: the retained lines, index 0 = record.startLine. */
  lines?: string[];
  /** For search hits: the retained hits. */
  hits?: SearchHit[];
  /** For manifests: the retained paths. */
  paths?: string[];
  /** Request descriptor used for freshness rechecks. */
  request?: { tool: "read_file"; path: string; startLine: number; endLine: number } | { tool: "search_code"; query: string; path: string; cursor?: string } | { tool: "list_files"; path: string; cursor?: string; pattern?: string };
}

export type NewEvidence = Omit<EvidenceRecord, "id" | "digest" | "observedAt" | "bytes" | "hashScope"> & {
  text: string;
  lines?: string[];
  hits?: SearchHit[];
  paths?: string[];
  request?: LedgerEntry["request"];
};

export class EvidenceLedger {
  private readonly entries: LedgerEntry[] = [];
  private readonly byId = new Map<string, LedgerEntry>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  add(evidence: NewEvidence): LedgerEntry {
    const id = `E${this.entries.length + 1}`;
    const { text, lines, hits, paths, request, ...meta } = evidence;
    const record: EvidenceRecord = {
      ...meta,
      id,
      observedAt: this.now().toISOString(),
      digest: sha256(text),
      hashScope: meta.kind === "source_range" ? "returned_range" : "returned_payload",
      bytes: meta.error ? 0 : utf8Bytes(text),
    };
    const entry: LedgerEntry = { record: Object.freeze(record) as EvidenceRecord, text, lines, hits, paths, request };
    this.entries.push(entry);
    this.byId.set(id, entry);
    return entry;
  }

  get(id: string): LedgerEntry | undefined {
    return this.byId.get(id);
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  /** Successful host-observed source ranges for the same path/range and digest (dedupe). */
  findIdentical(kind: EvidenceKind, digest: string, path?: string, startLine?: number, endLine?: number, label?: string): LedgerEntry | undefined {
    return this.entries.find(
      (e) =>
        !e.record.error &&
        e.record.kind === kind &&
        e.record.digest === digest &&
        e.record.path === path &&
        // Different searches/listings with equal output (e.g. no hits) are distinct evidence.
        (kind === "source_range" || e.record.label === label) &&
        e.record.startLine === startLine &&
        e.record.endLine === endLine,
    );
  }

  retainedBytes(): number {
    return this.entries.reduce((sum, e) => sum + e.record.bytes, 0);
  }

  records(): EvidenceRecord[] {
    return this.entries.map((e) => e.record);
  }
}
