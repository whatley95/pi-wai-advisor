/**
 * /wai-advisor-model: human-only model/effort selection, independent of the main
 * agent's model. Shows the source-sharing boundary and records consent for the
 * exact provider/model. Changes apply to the next consultation only.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadAdvisorConfig, updateSettingsSection } from "../config.ts";
import { checkModelCompatibility, isAuthConfigured, type PiModelLike, type PiModelRegistryLike, supportedThinkingLevels } from "../model/pi-runtime.ts";
import { show } from "./output.ts";

export interface PickerDeps {
  globalSettingsPath: string;
  trustedApis: readonly string[];
}


export async function runModelPicker(pi: ExtensionAPI, ctx: ExtensionCommandContext, deps: PickerDeps): Promise<void> {
  if (!ctx.hasUI) {
    show(pi, ctx, `/wai-advisor-model is interactive only. In non-interactive use, set "pi-wai-advisor": {"model": {...}, "sourceSharingConsent": {...}} in ${deps.globalSettingsPath}.`, "error");
    return;
  }
  const registry = ctx.modelRegistry as unknown as PiModelRegistryLike;
  const current = loadAdvisorConfig({ globalSettingsPath: deps.globalSettingsPath, projectSettingsPath: null, projectTrusted: false });
  const action = await ctx.ui.select(
    `WAI Advisor model — current: ${current.model ? `${current.model.provider}/${current.model.id}${current.model.effort ? ` (${current.model.effort})` : ""}` : "none"}${current.enabled ? "" : " [disabled]"}`,
    ["Select or change model", current.enabled ? "Disable advisor" : "Enable advisor", "Cancel"],
  );
  if (!action || action === "Cancel") return;
  if (action === "Disable advisor" || action === "Enable advisor") {
    const enabled = action === "Enable advisor";
    updateSettingsSection(deps.globalSettingsPath, { enabled });
    show(pi, ctx, `WAI Advisor ${enabled ? "enabled" : "disabled"}. Applies to the next consultation.`);
    return;
  }

  const candidates = registry.getAll().filter((m) => !m.type || m.type === "chat");
  const authCache = new Map<string, boolean>();
  const usable: PiModelLike[] = [];
  let hidden = 0;
  for (const model of candidates) {
    if (!(await isAuthConfigured(registry, model.provider, authCache))) continue; // unauthenticated: not offered
    if (checkModelCompatibility(registry, model, undefined, deps.trustedApis, true).ok) usable.push(model);
    else hidden++;
  }
  if (!usable.length) {
    show(pi, ctx, `No compatible authenticated models are available${hidden ? ` (${hidden} hidden: unsupported API/retry control or missing auth)` : ""}. Log in to a provider in Pi first.`, "warning");
    return;
  }
  const labels = usable.map((m) => `${m.provider}/${m.id}${m.name && m.name !== m.id ? ` — ${m.name}` : ""}`);
  const picked = await ctx.ui.select(`Advisor model (independent of the main agent)${hidden ? ` — ${hidden} incompatible hidden` : ""}`, labels);
  if (!picked) return;
  const model = usable[labels.indexOf(picked)];
  if (!model) return;

  let effort: string | undefined;
  const levels = supportedThinkingLevels(model);
  if (model.reasoning && levels.length > 1) {
    // Omitting the level means "off" in Pi's runtime, so every choice is explicit.
    const choice = await ctx.ui.select(`Reasoning level for ${model.provider}/${model.id}`, levels);
    if (!choice) return;
    effort = choice === "off" ? undefined : choice;
  }
  const compat = checkModelCompatibility(registry, model, effort, deps.trustedApis, true);
  if (!compat.ok) {
    show(pi, ctx, `Cannot select ${model.provider}/${model.id}: ${compat.reason}`, "error");
    return;
  }

  const confirmed = await ctx.ui.confirm(
    "Confirm source-sharing boundary",
    `Each WAI Advisor consultation sends your question, constraints, caller-supplied snippets and the project source excerpts, file paths and search results it reads to ${model.provider}/${model.id}. ` +
      "The advisor reads only permitted, non-sensitive project files through Pi's tools and never edits files or runs commands, but secret detection is best-effort and the provider's own data-retention policy applies. " +
      "Project read access and sending code to this provider are separate decisions. Allow this provider for WAI Advisor?",
  );
  if (!confirmed) {
    show(pi, ctx, "Model selection cancelled; nothing was saved.");
    return;
  }
  updateSettingsSection(deps.globalSettingsPath, {
    model: { provider: model.provider, id: model.id, ...(effort ? { effort } : {}) },
    sourceSharingConsent: { provider: model.provider, id: model.id, confirmedAt: new Date().toISOString() },
    enabled: true,
  });
  const after = loadAdvisorConfig({ globalSettingsPath: deps.globalSettingsPath, projectSettingsPath: `${ctx.cwd}/.pi/settings.json`, projectTrusted: ctx.isProjectTrusted() });
  const override = after.modelSource === "project" && after.model ? ` Note: this project's .pi/settings.json overrides the model with ${after.model.provider}/${after.model.id}.` : "";
  const limitOverrides = after.projectOverrides.length ? ` Project settings override: ${after.projectOverrides.join(", ")}.` : "";
  show(pi, ctx, `WAI Advisor model set to ${model.provider}/${model.id}${effort ? ` (${effort})` : ""}. Applies to the next consultation; a running one keeps its snapshot.${override}${limitOverrides}`);
}
