/**
 * WAI Advisor (Whatley AI Advisor) — standalone Pi extension.
 *
 * Registers /wai-advisor, /wai-advisor-model, /wai-advisor-status, /wai-advisor-history,
 * /wai-advisor-result, /wai-advisor-cancel and the wai_advisor / wai_advisor_result
 * tools. No model calls happen on load, session start or per turn.
 */
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { AdvisorController, projectKeyOf } from "./core/controller.ts";
import { canonicalRoot } from "./evidence/path-policy.ts";
import { registerCommands } from "./integration/commands.ts";
import { OUTPUT_ENTRY } from "./integration/output.ts";
import { registerTools } from "./integration/tools.ts";
import type { ModelAdapter } from "./model/adapter.ts";
import { type PiModelLike, type PiModelRegistryLike, RETRY_VERIFIED_APIS } from "./model/pi-runtime.ts";
import { RequestStore } from "./storage/request-store.ts";

export interface WaiAdvisorOptions {
  /** Defaults to <agentDir>/settings.json. */
  globalSettingsPath?: string;
  /** Test hook: extra APIs with verified single-attempt behavior (e.g. a scripted provider). */
  trustedApis?: readonly string[];
  /** Test hook: replace the Pi runtime model adapter. */
  adapterFactory?: (registry: PiModelRegistryLike, model: PiModelLike, effort: string | undefined) => ModelAdapter;
}

export function createWaiAdvisorExtension(options: WaiAdvisorOptions = {}) {
  return function waiAdvisor(pi: ExtensionAPI): void {
    const globalSettingsPath = options.globalSettingsPath ?? join(getAgentDir(), "settings.json");
    const trustedApis = [...RETRY_VERIFIED_APIS, ...(options.trustedApis ?? [])];
    const controller = new AdvisorController({ globalSettingsPath, trustedApis, adapterFactory: options.adapterFactory });

    registerCommands(pi, { controller, globalSettingsPath, trustedApis });
    registerTools(pi, { controller });

    pi.registerEntryRenderer<{ text?: string }>(OUTPUT_ENTRY, (entry) => new Text(typeof entry.data?.text === "string" ? entry.data.text : "", 1, 0));

    pi.on("session_start", async (_event, ctx) => {
      // Mark consultations interrupted by a previous crash/exit as failed. Never resumes paid work.
      if (!ctx.isProjectTrusted()) return;
      try {
        const root = canonicalRoot(ctx.cwd);
        new RequestStore(root.lexical).markInterrupted(projectKeyOf(root), (id) => controller.isActiveRequest(id));
      } catch {
        /* no runtime directory yet */
      }
    });
    pi.on("session_shutdown", async () => {
      controller.invalidateAll("session_changed");
    });
    pi.on("session_tree", async () => {
      controller.invalidateAll("session_changed");
    });
  };
}

export default createWaiAdvisorExtension();
