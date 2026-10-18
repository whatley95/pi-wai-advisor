/**
 * Request controller: preflight validation, immutable request snapshot, one active
 * consultation per chat/project, cancellation/deadline/session isolation,
 * persistence and guarded publication.
 */
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { type AdvisorMode, type AdvisorRequest, type AdvisorResult, type AdvisorToolInput, AdvisorToolInputSchema, type Capability, checkSchema, firstSchemaError, INPUT_LIMITS, type Limits, type ResultState, SCHEMA_VERSION } from "../contracts.ts";
import { type AdvisorConfig, consentCovers, loadAdvisorConfig } from "../config.ts";
import { EvidenceBroker } from "../evidence/broker.ts";
import { redactSecrets } from "../evidence/redact.ts";
import { EvidenceLedger } from "../evidence/ledger.ts";
import { type NativeToolHost, snapshotCapabilities } from "../evidence/native-tools.ts";
import { canonicalRoot, policyFingerprint, type ProjectRoot } from "../evidence/path-policy.ts";
import { type CompactReturn, compactReturn, renderAnswerMarkdown } from "../integration/compact-output.ts";
import type { ModelAdapter } from "../model/adapter.ts";
import { checkModelCompatibility, isAuthConfigured, PiRuntimeModelAdapter, type PiModelLike, type PiModelRegistryLike, RETRY_VERIFIED_APIS } from "../model/pi-runtime.ts";
import { RequestStore, StoreError } from "../storage/request-store.ts";
import { Budget, effectiveTokenLimits } from "./budget.ts";
import { type AbortReason, runEngine } from "./engine.ts";

export interface ConsultContext {
  cwd: string;
  chatId: string;
  callerKind: "command" | "tool";
  projectTrusted: boolean;
  /** Non-null when the invoking chat holds a restricted role (e.g. a WAICC recipient). */
  restrictedRole: string | null;
  registry: PiModelRegistryLike;
  /** Invocation-scoped host tools; null when the host provides none (slash commands). */
  host: NativeToolHost | null;
  /** Host abort (Esc / tool cancellation). */
  signal?: AbortSignal;
  progress?: (message: string) => void;
}

export interface ConsultOutcome {
  kind: "result";
  result: AdvisorResult;
  compact: CompactReturn;
  saved: boolean;
  /** False when the session changed: the caller must not publish into the current chat. */
  publish: boolean;
}

export type ConsultResponse = ConsultOutcome | { kind: "rejected"; message: string; busy?: boolean };

export interface ControllerOptions {
  globalSettingsPath: string;
  /** APIs whose retry behavior is verified (tests may add a scripted provider API). */
  trustedApis?: readonly string[];
  adapterFactory?: (registry: PiModelRegistryLike, model: PiModelLike, effort: string | undefined) => ModelAdapter;
  now?: () => Date;
}

interface ActiveRequest {
  requestId: string;
  controller: AbortController;
  reason: AbortReason | null;
  generation: number;
  startedAt: string;
  progress: string;
  mode: AdvisorMode;
}

export function projectKeyOf(root: ProjectRoot): string {
  return createHash("sha256").update(process.platform === "win32" ? root.real.toLowerCase() : root.real).digest("hex").slice(0, 32);
}

export function chatKeyOf(root: ProjectRoot, chatId: string): string {
  return `${projectKeyOf(root)}|${chatId}`;
}

/** Host tools are usable only when they belong to the same canonical project root. */
function hostForRoot(host: NativeToolHost | null, root: ProjectRoot): NativeToolHost | null {
  if (!host) return null;
  try {
    return canonicalRoot(host.cwd).real === root.real ? host : null;
  } catch {
    return null;
  }
}

export class AdvisorController {
  private readonly active = new Map<string, ActiveRequest>();
  /** Bumped on session switch/fork/tree/shutdown; results from an older epoch never publish. */
  private epoch = 0;
  private readonly lastUsage = new Map<string, { requestId: string; state: ResultState; usage: AdvisorResult["usage"] }>();

  constructor(private readonly options: ControllerOptions) {}

  loadConfig(cwd: string, projectTrusted: boolean): AdvisorConfig {
    return loadAdvisorConfig({
      globalSettingsPath: this.options.globalSettingsPath,
      projectSettingsPath: join(cwd, ".pi", "settings.json"),
      projectTrusted,
    });
  }

  activeFor(cwd: string, chatId: string): ActiveRequest | undefined {
    try {
      return this.active.get(chatKeyOf(canonicalRoot(cwd), chatId));
    } catch {
      return undefined;
    }
  }

  lastUsageFor(cwd: string, chatId: string) {
    try {
      return this.lastUsage.get(chatKeyOf(canonicalRoot(cwd), chatId));
    } catch {
      return undefined;
    }
  }

  isActiveRequest(requestId: string): boolean {
    return [...this.active.values()].some((a) => a.requestId === requestId);
  }

  /** Manual cancellation of this chat's active consultation. */
  cancel(cwd: string, chatId: string): string | null {
    const active = this.activeFor(cwd, chatId);
    if (!active) return null;
    active.reason ??= "cancelled";
    active.controller.abort();
    return active.requestId;
  }

  /** Session switch/fork/tree/shutdown: abort and fence off late publication. */
  invalidateAll(reason: AbortReason = "session_changed"): void {
    this.epoch++;
    for (const active of this.active.values()) {
      active.reason ??= reason;
      active.controller.abort();
    }
  }

  async consult(ctx: ConsultContext, rawInput: unknown): Promise<ConsultResponse> {
    // ---- Input validation (no provider call) ------------------------------------
    if (!checkSchema<AdvisorToolInput>(AdvisorToolInputSchema, rawInput))
      return { kind: "rejected", message: `Invalid wai_advisor input: ${firstSchemaError(AdvisorToolInputSchema, rawInput) ?? "invalid"}.` };
    const input = rawInput;
    const supplied = input.suppliedEvidence ?? [];
    const suppliedChars = supplied.reduce((sum, s) => sum + s.text.length + s.label.length, 0);
    if (suppliedChars > INPUT_LIMITS.suppliedEvidenceTotalChars)
      return { kind: "rejected", message: `suppliedEvidence totals ${suppliedChars} characters (limit ${INPUT_LIMITS.suppliedEvidenceTotalChars}).` };
    if (input.mode === "quick" && input.seedPaths?.length)
      return { kind: "rejected", message: "Quick mode cannot take seed paths: it uses no source tools and will not read files. Remove seedPaths or use inspect mode." };
    if (!input.question.trim()) return { kind: "rejected", message: "The question is empty." };

    if (ctx.restrictedRole)
      return {
        kind: "rejected",
        message: `WAI Advisor is unavailable in this chat: it holds the restricted role "${ctx.restrictedRole}". A restricted recipient cannot use the advisor to gain tools, a second investigator or broader access. Return to the coordinating chat.`,
      };

    let root: ProjectRoot;
    try {
      root = canonicalRoot(ctx.cwd);
    } catch (error) {
      return { kind: "rejected", message: `The project root cannot be resolved: ${(error as Error).message}` };
    }
    const chatKey = chatKeyOf(root, ctx.chatId);
    const busy = this.active.get(chatKey);
    if (busy) return { kind: "rejected", busy: true, message: `WAI Advisor is busy with request ${busy.requestId} in this chat (${busy.progress}). Wait for it or cancel it with /wai-advisor-cancel; it was not cancelled implicitly.` };

    // Claim the chat slot and capture the session epoch synchronously, before any await,
    // so concurrent calls see "busy" and a session change during preflight is fenced.
    const active: ActiveRequest = {
      requestId: randomUUID(),
      controller: new AbortController(),
      reason: null,
      generation: this.epoch,
      startedAt: new Date().toISOString(),
      progress: "preflight",
      mode: input.mode ?? "inspect",
    };
    this.active.set(chatKey, active);
    try {
      return await this.execute(ctx, input, root, active);
    } finally {
      if (this.active.get(chatKey) === active) this.active.delete(chatKey);
    }
  }

  private async execute(ctx: ConsultContext, input: AdvisorToolInput, root: ProjectRoot, active: ActiveRequest): Promise<ConsultResponse> {
    const supplied = (input.suppliedEvidence ?? []).map((s) => ({ ...s, text: redactSecrets(s.text).text, label: redactSecrets(s.label).text }));
    const abort = active.controller;
    const generation = active.generation;
    // ---- Preflight: trust, configuration, model, consent, compatibility ----------
    if (!ctx.projectTrusted) return { kind: "rejected", message: "This project is not trusted in Pi. Trust it (/trust) before consulting WAI Advisor; consultations write private records under .pi/pi-wai-advisor." };
    const config = this.loadConfig(root.lexical, ctx.projectTrusted);
    if (config.errors.length) return { kind: "rejected", message: `WAI Advisor configuration is invalid:\n- ${config.errors.join("\n- ")}` };
    if (!config.enabled) return { kind: "rejected", message: "WAI Advisor is disabled. Enable it with /wai-advisor-model." };
    if (!config.model) return { kind: "rejected", message: "No advisor model is selected. A human must choose one with /wai-advisor-model (or configure pi-wai-advisor.model in settings)." };
    if (!consentCovers(config.consent, config.model))
      return {
        kind: "rejected",
        message: `Source-sharing consent is missing for ${config.model.provider}/${config.model.id}. Run /wai-advisor-model to confirm that selected project code may be sent to this provider.`,
      };
    const model = ctx.registry.find(config.model.provider, config.model.id);
    if (!model) return { kind: "rejected", message: `The selected advisor model ${config.model.provider}/${config.model.id} is not available in this Pi runtime. Choose another with /wai-advisor-model.` };
    const compat = checkModelCompatibility(ctx.registry, model, config.model.effort, this.options.trustedApis ?? RETRY_VERIFIED_APIS, await isAuthConfigured(ctx.registry, model.provider));
    if (!compat.ok) return { kind: "rejected", message: `Advisor model is not usable: ${compat.reason}` };
    if (abort.signal.aborted || this.epoch !== generation)
      return { kind: "rejected", message: "The consultation was cancelled before it started (cancel requested or the Pi session changed). No model call was made." };

    const mode: AdvisorMode = input.mode ?? config.defaultMode;
    active.mode = mode;
    if (mode === "quick" && input.seedPaths?.length) return { kind: "rejected", message: "Quick mode (the configured default) cannot take seed paths. Pass mode \"inspect\" to read files." };
    const limits: Limits = mode === "quick" ? { ...config.limits, maxModelCalls: 1, maxEvidenceRequests: 0 } : { ...config.limits };
    const tokenLimits = effectiveTokenLimits(limits, model);
    if ("error" in tokenLimits) return { kind: "rejected", message: tokenLimits.error };

    const adapter = (this.options.adapterFactory ?? ((r, m, e) => new PiRuntimeModelAdapter(r, m, e)))(ctx.registry, model, config.model.effort);
    const description = adapter.describe();
    if (limits.maxCostUsd !== null && (description.pricing.inputPerMTok === null || description.pricing.outputPerMTok === null))
      return {
        kind: "rejected",
        message: `maxCostUsd is set to $${limits.maxCostUsd}, but prices for ${description.provider}/${description.id} are unknown, so the cap cannot be enforced. No call was made. Remove the cost cap explicitly to proceed.`,
      };
    const capabilities: Capability[] = mode === "inspect" ? snapshotCapabilities(hostForRoot(ctx.host, root)) : [];

    // ---- Immutable snapshot ------------------------------------------------------
    const now = this.options.now ?? (() => new Date());
    const requestId = active.requestId;
    const chatKey = chatKeyOf(root, ctx.chatId);
    const request: AdvisorRequest = {
      schemaVersion: SCHEMA_VERSION,
      requestId,
      projectKey: projectKeyOf(root),
      projectRoot: root.real,
      caller: { kind: ctx.callerKind, chatId: ctx.chatId },
      createdAt: now().toISOString(),
      question: input.question,
      mode,
      constraints: input.constraints ?? [],
      seedPaths: mode === "inspect" ? (input.seedPaths ?? []) : [],
      suppliedEvidence: supplied,
      ...(input.previousRequestId ? { previousRequestId: input.previousRequestId } : {}),
      model: { provider: description.provider, id: description.id, ...(description.effort ? { effort: description.effort } : {}) },
      capabilities,
      limits,
      policyFingerprint: policyFingerprint(),
    };
    Object.freeze(request);

    const store = new RequestStore(root.lexical);
    const warnings: string[] = [...compat.notes, ...tokenLimits.notes];
    let persistError: string | null = null;
    const persist = (fn: () => void) => {
      if (persistError) return;
      try {
        fn();
      } catch (error) {
        persistError = error instanceof StoreError ? error.message : `Could not write advisor records: ${(error as Error).message}`;
      }
    };
    persist(() => store.saveRequest(request));

    let historical: string | undefined;
    if (input.previousRequestId) {
      try {
        const previous = store.readResult(input.previousRequestId, request.projectKey);
        if (!previous) warnings.push(`previousRequestId ${input.previousRequestId} was not found in this project; nothing was imported.`);
        else {
          const prev = previous.result;
          const cited = (prev.answer?.citations ?? []).map((c) => previous.evidence.find((e) => e.id === c.evidenceId)).filter(Boolean).map((e) => `${e?.path ?? e?.label}${e?.startLine ? `:${e.startLine}-${e.endLine}` : ""}`);
          historical = `HISTORICAL advice from request ${prev.requestId} (${prev.completedAt}, state ${prev.state}). It may be stale; it is not current evidence — re-read any code before relying on it.\nRecommendation: ${(prev.answer?.recommendation ?? "(no answer)").slice(0, 600)}\nPreviously cited (not re-verified): ${cited.slice(0, 8).join(", ") || "none"}`;
        }
      } catch (error) {
        warnings.push(`previousRequestId could not be imported: ${(error as Error).message}`);
      }
    }

    // ---- Execution with cancellation, deadline and session fencing -------------
    active.startedAt = request.createdAt;
    active.progress = "starting";
    const onHostAbort = () => {
      active.reason ??= "cancelled";
      abort.abort();
    };
    if (ctx.signal?.aborted) onHostAbort();
    ctx.signal?.addEventListener("abort", onHostAbort, { once: true });
    const deadline = setTimeout(() => {
      active.reason ??= "deadline";
      abort.abort();
    }, limits.maxWallTimeMs);

    const ledger = new EvidenceLedger(now);
    const budget = new Budget(limits, tokenLimits.perCallInputTokens, tokenLimits.outputTokens, description.pricing);
    const progress = (message: string) => {
      active.progress = message;
      persist(() => store.appendEvent(requestId, { type: "progress", message }));
      try {
        ctx.progress?.(message);
      } catch {
        /* UI may be gone after a session switch */
      }
    };
    const broker = new EvidenceBroker(hostForRoot(ctx.host, root), root, ledger, budget, capabilities, abort.signal, { maxReadChars: limits.maxReadChars, maxEvidenceBytes: limits.maxEvidenceBytes }, progress);

    let outcome;
    try {
      outcome = await runEngine({
        request,
        model: adapter,
        budget,
        ledger,
        broker,
        signal: abort.signal,
        abortReason: () => active.reason,
        progress,
        historical,
        onLateUsage: (usage) => {
          try {
            store.appendEvent(requestId, { type: "late_completion", note: "Provider call finished after the local request ended; not published.", usage });
          } catch {
            /* best effort */
          }
        },
      });
    } finally {
      clearTimeout(deadline);
      ctx.signal?.removeEventListener("abort", onHostAbort);
      if (this.active.get(chatKey) === active) this.active.delete(chatKey);
    }

    const sessionChanged = this.epoch !== generation || active.reason === "session_changed";
    let state = outcome.state;
    if (sessionChanged && state !== "cancelled") {
      state = "cancelled";
      outcome.warnings.push("The Pi session changed before publication; this late result was withheld from the replacement session.");
    }
    const result: AdvisorResult = {
      schemaVersion: SCHEMA_VERSION,
      requestId,
      projectKey: request.projectKey,
      state,
      answer: state === "cancelled" ? null : outcome.answer,
      authority: "none",
      deliveryVerified: false,
      model: request.model,
      evidenceIds: ledger.all().map((e) => e.record.id),
      freshness: outcome.freshness,
      usage: outcome.usage,
      limitsHit: outcome.limitsHit,
      warnings: [...warnings, ...outcome.warnings, ...(outcome.reason ? [outcome.reason] : [])],
      startedAt: request.createdAt,
      completedAt: now().toISOString(),
    };
    persist(() => {
      const historyError = store.saveResult(result, ledger.all(), renderAnswerMarkdown(result, request, ledger, outcome.reason), request);
      if (historyError) result.warnings.push(historyError);
    });
    if (persistError) result.warnings.push(`Not saved: ${persistError}`);
    this.lastUsage.set(chatKey, { requestId, state: result.state, usage: result.usage });

    const compact = compactReturn(
      {
        result,
        request,
        ledger,
        resultPath: persistError ? null : store.relativePath(requestId, "result.json"),
        reason: outcome.reason,
        extraLimits: persistError ? [`Result was NOT saved: ${persistError}`] : [],
        audience: ctx.callerKind,
      },
      limits.maxReturnChars,
    );
    return { kind: "result", result, compact, saved: !persistError, publish: !sessionChanged };
  }
}
