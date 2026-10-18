/**
 * Test harness: temp copies of fixtures, a temp global settings file with a selected
 * model + consent, a structural model registry and a controller wired to a
 * scripted model. No real provider, settings or network is touched.
 */
import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AdvisorController, type ConsultContext } from "../../src/core/controller.ts";
import type { NativeToolHost } from "../../src/evidence/native-tools.ts";
import type { ModelAdapter } from "../../src/model/adapter.ts";
import type { PiModelLike, PiModelRegistryLike } from "../../src/model/pi-runtime.ts";

export const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export function tempDir(prefix = "wai-advisor-"): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

/** Copy a fixture into a fresh temp project root. */
export function project(fixture: string): string {
  const root = tempDir(`wai-${fixture}-`);
  cpSync(join(FIXTURES, fixture), root, { recursive: true });
  return root;
}

export const SCRIPTED_MODEL: PiModelLike = {
  id: "advisor-1",
  name: "Scripted advisor",
  api: "scripted-api",
  provider: "scripted",
  reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh" },
  contextWindow: 128_000,
  maxTokens: 8_000,
  input: ["text"],
  cost: { input: 1, output: 5 },
};

export function registry(models: PiModelLike[] = [SCRIPTED_MODEL], authed = true): PiModelRegistryLike {
  return {
    getAll: () => models,
    getAvailable: () => (authed ? models : []),
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: () => authed,
    streamSimple: () => {
      throw new Error("registry.streamSimple must not be called when a scripted adapter is injected");
    },
  };
}

export function writeSettings(path: string, section: Record<string, unknown>): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ theme: "dark", "other-extension": { keep: true }, "pi-wai-advisor": section }, null, 2));
}

export function defaultSection(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: { provider: "scripted", id: "advisor-1" },
    sourceSharingConsent: { provider: "scripted", id: "advisor-1", confirmedAt: "2026-10-17T00:00:00.000Z" },
    ...extra,
  };
}

export interface Harness {
  controller: AdvisorController;
  settingsPath: string;
  ctx(overrides?: Partial<ConsultContext>): ConsultContext;
  setModel(model: ModelAdapter): void;
}

export function harness(root: string, host: NativeToolHost | null, model: ModelAdapter, section: Record<string, unknown> = defaultSection()): Harness {
  const agentDir = tempDir("wai-agent-");
  const settingsPath = join(agentDir, "settings.json");
  writeSettings(settingsPath, section);
  let current = model;
  const controller = new AdvisorController({
    globalSettingsPath: settingsPath,
    trustedApis: ["scripted-api"],
    adapterFactory: () => current,
  });
  return {
    controller,
    settingsPath,
    setModel: (m) => {
      current = m;
    },
    ctx: (overrides = {}) => ({
      cwd: root,
      chatId: "chat-1",
      callerKind: "tool",
      projectTrusted: true,
      restrictedRole: null,
      registry: registry(),
      host,
      ...overrides,
    }),
  };
}
