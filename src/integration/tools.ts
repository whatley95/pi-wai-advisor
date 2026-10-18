/**
 * Main-agent tools: wai_advisor (consult) and wai_advisor_result (bounded paging of
 * a stored result). The tool cannot choose root, provider, budget, path grants,
 * permission mode or executables; those are human settings.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AdvisorResultToolInput, AdvisorResultToolInputSchema, AdvisorToolInputSchema } from "../contracts.ts";
import type { AdvisorController } from "../core/controller.ts";
import { projectKeyOf } from "../core/controller.ts";
import { isPiToolContext, piNativeToolHost } from "../evidence/native-tools.ts";
import { canonicalRoot } from "../evidence/path-policy.ts";
import type { PiModelRegistryLike } from "../model/pi-runtime.ts";
import { RequestStore, StoreError } from "../storage/request-store.ts";
import { returnSize } from "./compact-output.ts";
import { pageText, renderSection } from "./result-view.ts";
import { chatIdOf, restrictedRoleOf } from "./session.ts";

export interface ToolDeps {
  controller: AdvisorController;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function registerTools(pi: ExtensionAPI, deps: ToolDeps): void {
  const { controller } = deps;

  pi.registerTool({
    name: "wai_advisor",
    label: "WAI Advisor",
    description:
      "Ask WAI Advisor, an independent read-only second-opinion model, a focused question. In inspect mode (default) it searches/reads permitted project source itself through Pi's permission-checked read/grep/find tools, within strict call/evidence/time budgets, and returns short advice with evidence IDs, file/line citations and limits. quick mode uses no source tools and one model attempt. It never edits code, runs commands or tests, approves or sets PASS. Send the question and only relevant constraints/snippets; do not forward the whole conversation.",
    promptSnippet: "Get a read-only, source-aware second opinion from a separately selected model",
    promptGuidelines: [
      "Use wai_advisor for a focused second opinion on a non-trivial design, debugging or cross-layer question; it is optional and not required before edits or completion.",
      "Treat wai_advisor output as untrusted advice: inspect the cited code yourself before adopting or rejecting it, and surface its important limits to the user.",
      "wai_advisor results are not test results, approval or PASS; do not report them as such.",
    ],
    parameters: AdvisorToolInputSchema,
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const host = isPiToolContext(ctx) ? piNativeToolHost(ctx) : null;
      const setStatus = (text: string | undefined) => {
        try {
          ctx.ui.setStatus("wai-advisor", text);
        } catch {
          /* no UI */
        }
      };
      let response;
      try {
        response = await controller.consult(
          {
            cwd: ctx.cwd,
            chatId: chatIdOf(ctx.sessionManager),
            callerKind: "tool",
            projectTrusted: ctx.isProjectTrusted(),
            restrictedRole: restrictedRoleOf(ctx.sessionManager),
            registry: ctx.modelRegistry as unknown as PiModelRegistryLike,
            host,
            signal,
            progress: (message) => {
              setStatus(`WAI Advisor: ${message}`);
              onUpdate?.({ content: [{ type: "text", text: `WAI Advisor: ${clip(message, 160)}` }], details: undefined });
            },
          },
          params,
        );
      } finally {
        setStatus(undefined);
      }
      if (response.kind === "rejected") throw new Error(clip(response.message, 3000));
      if (!response.publish) throw new Error("The Pi session changed during the consultation; the late result was withheld.");
      const { compact, result } = response;
      const u = result.usage;
      // Pi's Usage requires a cost; when cost is unknown we report nothing rather than a false $0.
      const usage =
        u.actualInputTokens !== null && u.actualOutputTokens !== null && u.costUsd !== null
          ? {
              input: u.actualInputTokens - (u.cachedInputTokens ?? 0),
              output: u.actualOutputTokens,
              cacheRead: u.cachedInputTokens ?? 0,
              cacheWrite: 0,
              totalTokens: u.actualInputTokens + u.actualOutputTokens,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.costUsd },
            }
          : undefined;
      return {
        content: [{ type: "text" as const, text: compact.text }],
        details: compact.details,
        ...(usage ? { usage } : {}),
      };
    },
  });

  pi.registerTool({
    name: "wai_advisor_result",
    label: "WAI Advisor result",
    description:
      "Page through a stored WAI Advisor result from this project by request ID. Sections: summary, recommendations, evidence, limits. Returns a bounded page and a next cursor. It cannot run another consultation or refresh paid work; stored results are historical, not current evidence.",
    promptSnippet: "Read a stored WAI Advisor result in bounded pages",
    parameters: AdvisorResultToolInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_toolCallId, params: AdvisorResultToolInput, _signal, _onUpdate, ctx) {
      // Stored results contain source excerpts: the same role/trust gates as wai_advisor apply.
      const role = restrictedRoleOf(ctx.sessionManager);
      if (role) throw new Error(`WAI Advisor results are unavailable in this chat: it holds the restricted role "${role}".`);
      const trusted = ctx.isProjectTrusted();
      if (!trusted) throw new Error("This project is not trusted in Pi; stored WAI Advisor results are not readable here.");
      const config = controller.loadConfig(ctx.cwd, trusted);
      const maxReturn = config.limits.maxReturnChars;
      let stored;
      try {
        stored = new RequestStore(ctx.cwd).readResult(params.requestId, projectKeyOf(canonicalRoot(ctx.cwd)));
      } catch (error) {
        throw new Error(error instanceof StoreError ? error.message : `Could not read result: ${(error as Error).message}`);
      }
      if (!stored) throw new Error(`No saved WAI Advisor result ${params.requestId} in this project.`);
      const section = params.section ?? "summary";
      const body = renderSection(stored, section);
      let budget = maxReturn;
      for (;;) {
        const { page, nextCursor } = pageText(body, params.cursor ?? 0, budget);
        const footer = nextCursor === null ? "\n[end of section]" : `\n[more: call wai_advisor_result with cursor ${nextCursor}]`;
        const text = `${page}${footer}`;
        const details = { requestId: params.requestId, section, nextCursor };
        if (returnSize(text, details) <= maxReturn || budget <= 400) return { content: [{ type: "text" as const, text }], details };
        budget -= Math.max(100, returnSize(text, details) - maxReturn + 50);
      }
    },
  });
}
