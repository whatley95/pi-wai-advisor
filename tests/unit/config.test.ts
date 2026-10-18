import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, HARD_MAXIMA, loadAdvisorConfig, updateSettingsSection, validateLimits } from "../../src/config.ts";
import { tempDir } from "../helpers/harness.ts";

function files(global: unknown, project?: unknown) {
  const dir = tempDir();
  const g = join(dir, "global.json");
  const p = join(dir, "project.json");
  writeFileSync(g, JSON.stringify(global));
  if (project !== undefined) writeFileSync(p, JSON.stringify(project));
  return { g, p };
}

describe("configuration", () => {
  it("uses documented defaults", () => {
    const { g } = files({});
    const c = loadAdvisorConfig({ globalSettingsPath: g, projectSettingsPath: null, projectTrusted: true });
    expect(c.limits).toEqual(DEFAULT_LIMITS);
    expect(c.defaultMode).toBe("inspect");
    expect(c.errors).toEqual([]);
    expect(c.model).toBeNull();
  });

  it("applies defaults < global < trusted project (lowering only) and reports project overrides", () => {
    const { g, p } = files({ "pi-wai-advisor": { limits: { maxModelCalls: 3, maxReadChars: 4000 } } }, { "pi-wai-advisor": { limits: { maxModelCalls: 2 } } });
    const trusted = loadAdvisorConfig({ globalSettingsPath: g, projectSettingsPath: p, projectTrusted: true });
    expect(trusted.limits.maxModelCalls).toBe(2);
    expect(trusted.limits.maxReadChars).toBe(4000);
    expect(trusted.projectOverrides).toEqual(["maxModelCalls"]);
    expect(trusted.errors).toEqual([]);
    const untrusted = loadAdvisorConfig({ globalSettingsPath: g, projectSettingsPath: p, projectTrusted: false });
    expect(untrusted.limits.maxModelCalls).toBe(3);
  });

  it("a repository cannot raise limits or remove/raise the human's cost cap", () => {
    const { g, p } = files({ "pi-wai-advisor": { limits: { maxCostUsd: 0.5 } } }, { "pi-wai-advisor": { limits: { maxModelCalls: 12, maxCostUsd: null } } });
    const c = loadAdvisorConfig({ globalSettingsPath: g, projectSettingsPath: p, projectTrusted: true });
    expect(c.limits.maxModelCalls).toBe(4);
    expect(c.limits.maxCostUsd).toBe(0.5);
    expect(c.errors.some((e) => e.includes("may only lower limits"))).toBe(true);
    expect(c.errors.some((e) => e.includes("maxCostUsd may only add or lower"))).toBe(true);
    const { g: g2, p: p2 } = files({}, { "pi-wai-advisor": { limits: { maxCostUsd: 0.1 } } });
    expect(loadAdvisorConfig({ globalSettingsPath: g2, projectSettingsPath: p2, projectTrusted: true }).limits.maxCostUsd).toBe(0.1);
  });

  it("rejects values above hard maxima instead of clamping", () => {
    const { g } = files({ "pi-wai-advisor": { limits: { maxModelCalls: HARD_MAXIMA.maxModelCalls + 1 } } });
    const c = loadAdvisorConfig({ globalSettingsPath: g, projectSettingsPath: null, projectTrusted: true });
    expect(c.errors.join(" ")).toMatch(/maxModelCalls=13 exceeds/);
  });

  it("rejects impossible limit combinations and unknown keys", () => {
    expect(validateLimits({ ...DEFAULT_LIMITS, maxEvidenceBytes: 100, maxReadChars: 6000 })[0]).toMatch(/maxEvidenceBytes/);
    expect(validateLimits({ ...DEFAULT_LIMITS, maxReturnChars: 10 })[0]).toMatch(/maxReturnChars/);
    const { g } = files({ "pi-wai-advisor": { limits: { maxBananas: 3, maxModelCalls: -1 } } });
    const c = loadAdvisorConfig({ globalSettingsPath: g, projectSettingsPath: null, projectTrusted: true });
    expect(c.errors.some((e) => e.includes("maxBananas"))).toBe(true);
    expect(c.errors.some((e) => e.includes("non-negative integer"))).toBe(true);
  });

  it("rejects reserved v1 features rather than enabling them", () => {
    const { g } = files({ "pi-wai-advisor": { autoConsult: true, storeRawTranscripts: true, integrations: { waicc: true } } });
    const c = loadAdvisorConfig({ globalSettingsPath: g, projectSettingsPath: null, projectTrusted: true });
    expect(c.errors).toHaveLength(3);
  });

  it("never takes source-sharing consent from project settings", () => {
    const consent = { provider: "evil", id: "m", confirmedAt: "x" };
    const { g, p } = files({}, { "pi-wai-advisor": { model: { provider: "evil", id: "m" }, sourceSharingConsent: consent } });
    const c = loadAdvisorConfig({ globalSettingsPath: g, projectSettingsPath: p, projectTrusted: true });
    expect(c.model).toEqual({ provider: "evil", id: "m" });
    expect(c.modelSource).toBe("project");
    expect(c.consent).toBeNull();
  });

  it("writes only its own section, preserving unrelated keys, and honors Pi's lock", () => {
    const dir = tempDir();
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ theme: "dark", packages: ["a"], "pi-wai-advisor": { defaultMode: "quick" } }));
    updateSettingsSection(path, { model: { provider: "p", id: "m" } });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.theme).toBe("dark");
    expect(saved.packages).toEqual(["a"]);
    expect(saved["pi-wai-advisor"]).toEqual({ defaultMode: "quick", model: { provider: "p", id: "m" } });
    mkdirSync(`${path}.lock`);
    expect(() => updateSettingsSection(path, { enabled: false })).toThrow(/locked/);
  });

  it("refuses to overwrite a malformed settings file", () => {
    const dir = tempDir();
    const path = join(dir, "settings.json");
    writeFileSync(path, "{ not json");
    expect(() => updateSettingsSection(path, { enabled: true })).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});
