/**
 * Versioned WAI Advisor contracts: TypeScript types plus runtime TypeBox schemas.
 *
 * Every value that crosses a trust boundary (tool input, model turn, persisted
 * artifact) is validated against these schemas. Unknown properties are rejected.
 */
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

export const SCHEMA_VERSION = 1 as const;

export const MODES = ["inspect", "quick"] as const;
export type AdvisorMode = (typeof MODES)[number];

export const CAPABILITIES = ["read_file", "search_code", "list_files", "native_diff"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const RESULT_STATES = ["completed", "partial", "blocked", "stale", "cancelled", "failed"] as const;
export type ResultState = (typeof RESULT_STATES)[number];

// ---------------------------------------------------------------------------
// Tool input (main agent -> wai_advisor)
// ---------------------------------------------------------------------------

export const INPUT_LIMITS = {
  questionChars: 8000,
  constraints: 20,
  constraintChars: 1000,
  seedPaths: 12,
  seedPathChars: 512,
  suppliedEvidence: 8,
  suppliedEvidenceTotalChars: 16000,
  suppliedLabelChars: 200,
} as const;

export const SuppliedEvidenceSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: INPUT_LIMITS.suppliedLabelChars }),
    text: Type.String({ minLength: 1, maxLength: INPUT_LIMITS.suppliedEvidenceTotalChars }),
    sourceKind: Type.Union([Type.Literal("caller_snippet"), Type.Literal("caller_log"), Type.Literal("caller_diff")]),
  },
  { additionalProperties: false },
);
export type SuppliedEvidence = Static<typeof SuppliedEvidenceSchema>;

export const AdvisorToolInputSchema = Type.Object(
  {
    question: Type.String({
      minLength: 1,
      maxLength: INPUT_LIMITS.questionChars,
      description: "The focused question for the advisor (max 8000 characters).",
    }),
    mode: Type.Optional(
      Type.Union([Type.Literal("inspect"), Type.Literal("quick")], {
        description: "inspect (default) lets the advisor read/search permitted project source; quick uses no source tools and one model attempt.",
      }),
    ),
    constraints: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: INPUT_LIMITS.constraintChars }), {
        maxItems: INPUT_LIMITS.constraints,
        description: "Explicit constraints the advice must respect.",
      }),
    ),
    seedPaths: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: INPUT_LIMITS.seedPathChars }), {
        maxItems: INPUT_LIMITS.seedPaths,
        description: "Project-relative files to start from (inspect only). A seed, not a ceiling.",
      }),
    ),
    suppliedEvidence: Type.Optional(
      Type.Array(SuppliedEvidenceSchema, {
        maxItems: INPUT_LIMITS.suppliedEvidence,
        description: "Caller-supplied snippets/logs/diffs. Labelled caller-supplied, never independently captured.",
      }),
    ),
    previousRequestId: Type.Optional(
      Type.String({
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        description: "Explicit continuity: imports only a bounded summary of that earlier result, labelled historical.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type AdvisorToolInput = Static<typeof AdvisorToolInputSchema>;

export const ResultSectionSchema = Type.Union([
  Type.Literal("summary"),
  Type.Literal("recommendations"),
  Type.Literal("evidence"),
  Type.Literal("limits"),
]);
export type ResultSection = Static<typeof ResultSectionSchema>;

export const AdvisorResultToolInputSchema = Type.Object(
  {
    requestId: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
    section: Type.Optional(ResultSectionSchema),
    cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000_000, description: "Character offset from a previous page." })),
  },
  { additionalProperties: false },
);
export type AdvisorResultToolInput = Static<typeof AdvisorResultToolInputSchema>;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const LimitsSchema = Type.Object(
  {
    maxModelCalls: Type.Integer({ minimum: 1 }),
    maxEvidenceRequests: Type.Integer({ minimum: 0 }),
    maxInputTokens: Type.Integer({ minimum: 1 }),
    maxCumulativeInputTokens: Type.Integer({ minimum: 1 }),
    maxOutputTokens: Type.Integer({ minimum: 1 }),
    maxSerializedRequestBytes: Type.Integer({ minimum: 1 }),
    maxEvidenceBytes: Type.Integer({ minimum: 0 }),
    maxReadChars: Type.Integer({ minimum: 1 }),
    maxWallTimeMs: Type.Integer({ minimum: 1 }),
    maxReturnChars: Type.Integer({ minimum: 1 }),
    maxCostUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type Limits = Static<typeof LimitsSchema>;

// ---------------------------------------------------------------------------
// Model turn protocol (advisor model -> controller)
// ---------------------------------------------------------------------------

export const MAX_REQUESTS_PER_TURN = 3;

const RelPath = Type.String({ minLength: 1, maxLength: 512 });

export const EvidenceRequestSchema = Type.Union([
  Type.Object(
    {
      tool: Type.Literal("read_file"),
      path: RelPath,
      startLine: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
      endLine: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      tool: Type.Literal("search_code"),
      query: Type.String({ minLength: 2, maxLength: 200 }),
      path: Type.Optional(RelPath),
      literal: Type.Literal(true),
      cursor: Type.Optional(Type.String({ maxLength: 64 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      tool: Type.Literal("list_files"),
      path: Type.Optional(RelPath),
      cursor: Type.Optional(Type.String({ maxLength: 64 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      tool: Type.Literal("native_diff"),
      paths: Type.Optional(Type.Array(RelPath, { maxItems: 12 })),
    },
    { additionalProperties: false },
  ),
]);
export type EvidenceRequest = Static<typeof EvidenceRequestSchema>;

const ShortText = (max: number) => Type.String({ maxLength: max });

export const CitationSchema = Type.Object(
  {
    evidenceId: Type.String({ pattern: "^E[1-9][0-9]{0,4}$" }),
    claim: ShortText(600),
    startLine: Type.Optional(Type.Integer({ minimum: 1 })),
    endLine: Type.Optional(Type.Integer({ minimum: 1 })),
    support: Type.Union([Type.Literal("direct_observation"), Type.Literal("inference"), Type.Literal("caller_report")]),
  },
  { additionalProperties: false },
);
export type Citation = Static<typeof CitationSchema>;

export const HumanDecisionSchema = Type.Object(
  {
    question: ShortText(600),
    recommendation: ShortText(600),
    impact: ShortText(600),
  },
  { additionalProperties: false },
);

export const AnswerDraftSchema = Type.Object(
  {
    recommendation: Type.String({ minLength: 1, maxLength: 2000 }),
    rationale: ShortText(4000),
    basis: Type.Union([Type.Literal("source_backed"), Type.Literal("mixed"), Type.Literal("general_reasoning")]),
    citations: Type.Array(CitationSchema, { maxItems: 24 }),
    alternatives: Type.Optional(Type.Array(ShortText(600), { maxItems: 6 })),
    suggestedFix: Type.Optional(ShortText(2000)),
    verificationSuggestions: Type.Array(ShortText(600), { maxItems: 10 }),
    missingEvidence: Type.Array(ShortText(600), { maxItems: 12 }),
    risks: Type.Array(ShortText(600), { maxItems: 10 }),
    humanDecisions: Type.Array(HumanDecisionSchema, { maxItems: 10 }),
  },
  { additionalProperties: false },
);
export type AdvisorAnswerDraft = Static<typeof AnswerDraftSchema>;

export const AdvisorTurnSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("evidence"),
      requests: Type.Array(EvidenceRequestSchema, { minItems: 1, maxItems: MAX_REQUESTS_PER_TURN }),
    },
    { additionalProperties: false },
  ),
  Type.Object({ type: Type.Literal("answer"), answer: AnswerDraftSchema }, { additionalProperties: false }),
]);
export type AdvisorTurn = Static<typeof AdvisorTurnSchema>;

// ---------------------------------------------------------------------------
// Evidence ledger
// ---------------------------------------------------------------------------

export type EvidenceKind =
  | "source_range"
  | "search_hits"
  | "file_manifest"
  | "native_diff"
  | "caller_snippet"
  | "caller_log"
  | "caller_diff";

export interface EvidenceRecord {
  id: string;
  kind: EvidenceKind;
  path?: string;
  startLine?: number;
  endLine?: number;
  observedAt: string;
  digest: string;
  hashScope: "returned_range" | "returned_payload";
  fileDigest?: string;
  provenance: "host_observed" | "caller_supplied";
  truncated: boolean;
  continuation?: { cursor?: string; nextStartLine?: number };
  error?: { code: string; message: string };
  /** Short label: the request that produced it (query, scope) or the caller label. */
  label?: string;
  /** Bytes of retained text; 0 for failed requests. */
  bytes: number;
  /** Lines withheld by the redaction filter (content still counts as observed). */
  redactions?: number;
}

// ---------------------------------------------------------------------------
// Persisted request and result
// ---------------------------------------------------------------------------

export interface ModelSnapshot {
  provider: string;
  id: string;
  effort?: string;
}

export interface AdvisorRequest {
  schemaVersion: typeof SCHEMA_VERSION;
  requestId: string;
  projectKey: string;
  projectRoot: string;
  caller: { kind: "command" | "tool"; chatId: string };
  createdAt: string;
  question: string;
  mode: AdvisorMode;
  constraints: string[];
  seedPaths: string[];
  suppliedEvidence: SuppliedEvidence[];
  previousRequestId?: string;
  model: ModelSnapshot;
  capabilities: Capability[];
  limits: Limits;
  policyFingerprint: string;
}

export interface Usage {
  modelCalls: number;
  evidenceRequests: number;
  estimatedInputTokens: number;
  actualInputTokens: number | null;
  actualOutputTokens: number | null;
  cachedInputTokens: number | null;
  costUsd: number | null;
  costBasis: "reported" | "estimated" | "unknown";
}

export interface Freshness {
  scope: "cited_ranges_and_captured_diff" | "not_checked";
  checkedAt: string | null;
  changedEvidenceIds: string[];
  unavailableEvidenceIds: string[];
}

export interface AdvisorResult {
  schemaVersion: typeof SCHEMA_VERSION;
  requestId: string;
  projectKey: string;
  state: ResultState;
  answer: AdvisorAnswerDraft | null;
  authority: "none";
  deliveryVerified: false;
  model: ModelSnapshot;
  evidenceIds: string[];
  freshness: Freshness;
  usage: Usage;
  limitsHit: string[];
  warnings: string[];
  startedAt: string;
  completedAt: string;
}

/** Compact envelope returned to the main agent (counted in full against maxReturnChars). */
export interface CompactEnvelope {
  requestId: string;
  state: ResultState;
  advice: string;
  citations: Array<{ evidenceId: string; path: string; startLine?: number; endLine?: number }>;
  limits: string[];
  resultPath: string | null;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function firstSchemaError(schema: TSchema, value: unknown): string | undefined {
  for (const error of Value.Errors(schema, value)) {
    const where = (error as { instancePath?: string; path?: string }).instancePath ?? (error as { path?: string }).path ?? "";
    return `${where || "/"} ${error.message}`.trim();
  }
  return undefined;
}

export function checkSchema<T>(schema: TSchema, value: unknown): value is T {
  return Value.Check(schema, value);
}
