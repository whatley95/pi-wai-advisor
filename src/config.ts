/**
 * Settings: built-in defaults < global settings < project settings (project only when trusted),
 * constrained by hard implementation maxima. Tool input can never raise any value.
 *
 * Namespace: "pi-wai-advisor" in Pi's settings.json files.
 */
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AdvisorMode, Limits } from "./contracts.ts";

export const SETTINGS_KEY = "pi-wai-advisor";

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxModelCalls: 4,
  maxEvidenceRequests: 8,
  maxInputTokens: 16000,
  maxCumulativeInputTokens: 48000,
  maxOutputTokens: 1200,
  maxSerializedRequestBytes: 98304,
  maxEvidenceBytes: 32768,
  maxReadChars: 6000,
  maxWallTimeMs: 90000,
  maxReturnChars: 4000,
  maxCostUsd: null,
});

/** Hard safety maxima; settings above these are rejected, never silently clamped upward. */
export const HARD_MAXIMA: Readonly<Omit<Limits, "maxCostUsd">> = Object.freeze({
  maxModelCalls: 12,
  maxEvidenceRequests: 40,
  maxInputTokens: 200_000,
  maxCumulativeInputTokens: 600_000,
  maxOutputTokens: 32_000,
  maxSerializedRequestBytes: 1_048_576,
  maxEvidenceBytes: 524_288,
  maxReadChars: 50_000,
  maxWallTimeMs: 600_000,
  maxReturnChars: 12_000,
});

/** Minimums below which a consultation cannot work at all ("impossible limits fail locally"). */
export const HARD_MINIMA: Readonly<Omit<Limits, "maxCostUsd" | "maxEvidenceRequests" | "maxEvidenceBytes">> = Object.freeze({
  maxModelCalls: 1,
  maxInputTokens: 1500,
  maxCumulativeInputTokens: 1500,
  maxOutputTokens: 256,
  maxSerializedRequestBytes: 8192,
  maxReadChars: 200,
  maxWallTimeMs: 1000,
  maxReturnChars: 600,
});

export interface ModelSelection {
  provider: string;
  id: string;
  effort?: string;
}

export interface SourceSharingConsent {
  provider: string;
  id: string;
  confirmedAt: string;
}

export interface AdvisorConfig {
  enabled: boolean;
  model: ModelSelection | null;
  /** Where the effective model came from (project overrides are reported). */
  modelSource: "global" | "project" | null;
  consent: SourceSharingConsent | null;
  defaultMode: AdvisorMode;
  limits: Limits;
  /** Limit names whose effective value came from project settings. */
  projectOverrides: string[];
  errors: string[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readSettingsFile(path: string | null): { section: Json | null; error?: string } {
  if (!path) return { section: null };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { section: null };
    return { section: null, error: `Cannot read ${path}: ${(error as Error).message}` };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) return { section: null, error: `${path} is not a JSON object.` };
    const section = parsed[SETTINGS_KEY];
    if (section === undefined) return { section: null };
    if (!isObject(section)) return { section: null, error: `${path}: "${SETTINGS_KEY}" must be an object.` };
    return { section };
  } catch (error) {
    return { section: null, error: `${path} is not valid JSON: ${(error as Error).message}` };
  }
}

function parseModel(value: unknown, where: string, errors: string[]): ModelSelection | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || typeof value.provider !== "string" || typeof value.id !== "string" || !value.provider || !value.id) {
    errors.push(`${where}.model must be {"provider": string, "id": string, "effort"?: string}.`);
    return null;
  }
  if (value.effort !== undefined && typeof value.effort !== "string") {
    errors.push(`${where}.model.effort must be a string.`);
    return null;
  }
  return { provider: value.provider, id: value.id, ...(value.effort ? { effort: value.effort } : {}) };
}

function parseConsent(value: unknown): SourceSharingConsent | null {
  if (!isObject(value)) return null;
  if (typeof value.provider !== "string" || typeof value.id !== "string" || typeof value.confirmedAt !== "string") return null;
  return { provider: value.provider, id: value.id, confirmedAt: value.confirmedAt };
}

const LIMIT_KEYS = Object.keys(DEFAULT_LIMITS) as (keyof Limits)[];

function applyLimits(target: Limits, raw: unknown, where: string, errors: string[], touched?: Set<string>): void {
  if (raw === undefined) return;
  if (!isObject(raw)) {
    errors.push(`${where}.limits must be an object.`);
    return;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!LIMIT_KEYS.includes(key as keyof Limits)) {
      errors.push(`${where}.limits.${key} is not a known limit.`);
      continue;
    }
    if (key === "maxCostUsd") {
      if (value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0)) {
        target.maxCostUsd = value as number | null;
        touched?.add(key);
      } else errors.push(`${where}.limits.maxCostUsd must be null or a non-negative number.`);
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      errors.push(`${where}.limits.${key} must be a non-negative integer.`);
      continue;
    }
    (target as unknown as Record<string, number>)[key] = value;
    touched?.add(key);
  }
}

/** Validate a complete limit set; returns problems (empty when usable). */
export function validateLimits(limits: Limits): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(HARD_MAXIMA) as (keyof typeof HARD_MAXIMA)[]) {
    if (limits[key] > HARD_MAXIMA[key]) problems.push(`${key}=${limits[key]} exceeds the hard maximum ${HARD_MAXIMA[key]}.`);
  }
  for (const key of Object.keys(HARD_MINIMA) as (keyof typeof HARD_MINIMA)[]) {
    if (limits[key] < HARD_MINIMA[key]) problems.push(`${key}=${limits[key]} is below the workable minimum ${HARD_MINIMA[key]}.`);
  }
  if (limits.maxEvidenceRequests > 0 && limits.maxEvidenceBytes < limits.maxReadChars) {
    problems.push(`maxEvidenceBytes (${limits.maxEvidenceBytes}) must be at least maxReadChars (${limits.maxReadChars}) when evidence requests are allowed.`);
  }
  if (limits.maxCostUsd !== null && !(limits.maxCostUsd >= 0)) problems.push("maxCostUsd must be null or >= 0.");
  return problems;
}

export interface LoadConfigOptions {
  globalSettingsPath: string | null;
  projectSettingsPath: string | null;
  projectTrusted: boolean;
}

export function loadAdvisorConfig(options: LoadConfigOptions): AdvisorConfig {
  const errors: string[] = [];
  const global = readSettingsFile(options.globalSettingsPath);
  if (global.error) errors.push(global.error);
  const project = options.projectTrusted ? readSettingsFile(options.projectSettingsPath) : { section: null };
  if ("error" in project && project.error) errors.push(project.error);

  const limits: Limits = { ...DEFAULT_LIMITS };
  const projectOverrides = new Set<string>();
  let defaultMode: AdvisorMode = "inspect";
  let enabled = true;

  for (const [where, section] of [
    ["global", global.section],
    ["project", project.section],
  ] as const) {
    if (!section) continue;
    // v1 reserved features must be rejected rather than silently enabled or ignored.
    if (section.autoConsult === true) errors.push(`${where}: autoConsult=true is reserved future behavior and is not supported in v1.`);
    if (section.storeRawTranscripts === true)
      errors.push(`${where}: storeRawTranscripts=true is reserved future behavior and is not supported in v1.`);
    if (isObject(section.integrations) && Object.values(section.integrations).some((v) => v === true))
      errors.push(`${where}: integrations are optional later-phase adapters and are not implemented in v1.`);
    if (section.defaultMode !== undefined) {
      if (section.defaultMode === "inspect" || section.defaultMode === "quick") defaultMode = section.defaultMode;
      else errors.push(`${where}.defaultMode must be "inspect" or "quick".`);
    }
    if (section.enabled !== undefined) {
      if (typeof section.enabled === "boolean") enabled = where === "project" ? enabled && section.enabled : section.enabled;
      else errors.push(`${where}.enabled must be boolean.`);
    }
    if (where === "global") applyLimits(limits, section.limits, where, errors);
    else {
      // A repository may tighten limits but never raise them or drop the human's cost cap.
      const proposed: Limits = { ...limits };
      const touched = new Set<string>();
      applyLimits(proposed, section.limits, where, errors, touched);
      for (const key of touched as Set<keyof Limits>) {
        if (key === "maxCostUsd") {
          const next = proposed.maxCostUsd;
          if (limits.maxCostUsd !== null && (next === null || next > limits.maxCostUsd)) {
            errors.push(`project.limits.maxCostUsd may only add or lower a cost cap (global cap $${limits.maxCostUsd}); only a human can raise or remove it in global settings.`);
            continue;
          }
          limits.maxCostUsd = next;
        } else {
          if (proposed[key] > limits[key]) {
            errors.push(`project.limits.${key}=${proposed[key]} would raise the limit above ${limits[key]}; project settings may only lower limits.`);
            continue;
          }
          (limits as unknown as Record<string, number>)[key] = proposed[key];
        }
        projectOverrides.add(key);
      }
    }
  }

  const globalModel = parseModel(global.section?.model, "global", errors);
  const projectModel = parseModel(project.section?.model, "project", errors);
  // Consent is a human action recorded by the picker in global settings only;
  // a repository cannot grant itself source-sharing consent.
  const consent = parseConsent(global.section?.sourceSharingConsent);

  errors.push(...validateLimits(limits));
  return {
    enabled,
    model: projectModel ?? globalModel,
    modelSource: projectModel ? "project" : globalModel ? "global" : null,
    consent,
    defaultMode,
    limits,
    projectOverrides: [...projectOverrides],
    errors,
  };
}

export function consentCovers(consent: SourceSharingConsent | null, model: ModelSelection | null): boolean {
  return !!consent && !!model && consent.provider === model.provider && consent.id === model.id;
}

// ---------------------------------------------------------------------------
// Writing (human picker only). Uses the same `<file>.lock` directory convention as
// Pi's settings manager (proper-lockfile) and preserves every unrelated key.
// ---------------------------------------------------------------------------

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withSettingsLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() > deadline) {
        let age = "unknown";
        try {
          age = `${Math.round((Date.now() - statSync(lock).mtimeMs) / 1000)}s`;
        } catch {
          /* lock vanished */
        }
        throw new Error(`Settings file is locked by another writer (${lock}, age ${age}). Try again.`);
      }
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* already released */
    }
  }
}

/** Merge `patch` into the "pi-wai-advisor" section; `undefined` values delete keys. */
export function updateSettingsSection(path: string, patch: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  withSettingsLock(path, () => {
    let root: Json = {};
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!isObject(parsed)) throw new Error(`${path} is not a JSON object; refusing to overwrite it.`);
      root = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const section: Json = isObject(root[SETTINGS_KEY]) ? { ...(root[SETTINGS_KEY] as Json) } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete section[key];
      else section[key] = value;
    }
    root[SETTINGS_KEY] = section;
    const tmp = `${path}.wai-advisor-${process.pid}-${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  });
}
