/**
 * Human slash commands. They execute directly (no main-agent inference) and show
 * results to the human without injecting them into the next model turn.
 *
 * Pi 1.3.0 gives command handlers no permission-checked tool API (`executeTool`
 * exists only in tool contexts), so /wai-advisor inspect mode reports "blocked"
 * rather than reading files through any other path. Quick mode works everywhere.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { HARD_MAXIMA } from "../config.ts";
import type { AdvisorToolInput } from "../contracts.ts";
import type { AdvisorController } from "../core/controller.ts";
import { projectKeyOf } from "../core/controller.ts";
import { canonicalRoot } from "../evidence/path-policy.ts";
import { checkModelCompatibility, isAuthConfigured, type PiModelRegistryLike } from "../model/pi-runtime.ts";
import { RequestStore, RUNTIME_DIR, StoreError } from "../storage/request-store.ts";
import { parseAdvisorArgs } from "./args.ts";
import { runModelPicker } from "./model-picker.ts";
import { show } from "./output.ts";
import { pageText, renderSection } from "./result-view.ts";
import { chatIdOf, restrictedRoleOf } from "./session.ts";

export interface CommandDeps {
  controller: AdvisorController;
  globalSettingsPath: string;
  trustedApis: readonly string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function setStatus(ctx: ExtensionCommandContext, text: string | undefined): void {
  try {
    ctx.ui.setStatus("wai-advisor", text);
  } catch {
    /* stale */
  }
}

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  const { controller } = deps;

  pi.registerCommand("wai-advisor", {
    description: "Ask WAI Advisor for a read-only second opinion: [--quick] [--file \"path\"]... [--] <question>",
    handler: async (args, ctx) => {
      const parsed = parseAdvisorArgs(args);
      if (!parsed.ok) {
        show(pi, ctx, parsed.error, "error");
        return;
      }
      const input: AdvisorToolInput = {
        question: parsed.question,
        ...(parsed.quick ? { mode: "quick" as const } : {}),
        ...(parsed.files.length ? { seedPaths: parsed.files, mode: "inspect" as const } : {}),
      };
      const chatId = chatIdOf(ctx.sessionManager);
      const run = async () => {
        setStatus(ctx, "WAI Advisor: starting");
        let response;
        try {
          response = await controller.consult(
            {
              cwd: ctx.cwd,
              chatId,
              callerKind: "command",
              projectTrusted: ctx.isProjectTrusted(),
              restrictedRole: restrictedRoleOf(ctx.sessionManager),
              registry: ctx.modelRegistry as unknown as PiModelRegistryLike,
              host: null,
              progress: (message) => setStatus(ctx, `WAI Advisor: ${message}`),
            },
            input,
          );
        } catch (error) {
          show(pi, ctx, `WAI Advisor failed: ${(error as Error).message}`, "error");
          return;
        } finally {
          setStatus(ctx, undefined);
        }
        if (response.kind === "rejected") {
          show(pi, ctx, response.message, response.busy ? "warning" : "error");
          return;
        }
        if (!response.publish) return; // session changed: never publish into the replacement chat
        const level = response.result.state === "completed" ? "info" : response.result.state === "failed" ? "error" : "warning";
        show(pi, ctx, response.compact.text, level, { envelope: response.compact.envelope });
      };
      // Interactive/RPC: run in the background so /wai-advisor-cancel and the editor stay usable.
      // Print/JSON: await, otherwise the process would exit before the result.
      if (ctx.mode === "tui" || ctx.mode === "rpc") void run();
      else await run();
    },
  });

  pi.registerCommand("wai-advisor-model", {
    description: "Choose WAI Advisor's model and reasoning level (independent of the main agent), or enable/disable it",
    handler: async (_args, ctx) => {
      try {
        await runModelPicker(pi, ctx, deps);
      } catch (error) {
        show(pi, ctx, `Model selection failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("wai-advisor-status", {
    description: "Show WAI Advisor model, limits, capabilities, active request and usage",
    handler: async (_args, ctx) => {
      const trusted = ctx.isProjectTrusted();
      const config = controller.loadConfig(ctx.cwd, trusted);
      const registry = ctx.modelRegistry as unknown as PiModelRegistryLike;
      const lines = ["WAI Advisor status"];
      lines.push(`- Enabled: ${config.enabled ? "yes" : "no"}; default mode: ${config.defaultMode}; project trusted: ${trusted ? "yes" : "no"}`);
      if (config.model) {
        const model = registry.find(config.model.provider, config.model.id);
        const compat = model
          ? checkModelCompatibility(registry, model, config.model.effort, deps.trustedApis, await isAuthConfigured(registry, model.provider))
          : { ok: false as const, reason: "not available in this Pi runtime" };
        const consent = config.consent && config.consent.provider === config.model.provider && config.consent.id === config.model.id;
        lines.push(
          `- Model: ${config.model.provider}/${config.model.id}${config.model.effort ? ` (reasoning ${config.model.effort})` : " (reasoning off)"} from ${config.modelSource} settings; ${compat.ok ? "compatible and authenticated" : `NOT usable: ${compat.reason}`}; source-sharing consent: ${consent ? `confirmed ${config.consent?.confirmedAt}` : "MISSING (run /wai-advisor-model)"}`,
        );
        if (model) lines.push(`- Model capacity: context ${model.contextWindow || "unknown"} tokens, max output ${model.maxTokens || "unknown"}`);
      } else lines.push("- Model: none selected (a human selects one with /wai-advisor-model)");
      const l = config.limits;
      lines.push(
        `- Limits (inspect): calls ${l.maxModelCalls}, evidence ${l.maxEvidenceRequests}, input/call ${l.maxInputTokens} est. tokens, cumulative ${l.maxCumulativeInputTokens}, output ${l.maxOutputTokens}, payload ${l.maxSerializedRequestBytes} B, evidence ${l.maxEvidenceBytes} B, read page ${l.maxReadChars} chars, wall ${l.maxWallTimeMs} ms, return ${l.maxReturnChars} chars, cost cap ${l.maxCostUsd === null ? "none" : `$${l.maxCostUsd}`}. Quick mode: 1 call, 0 evidence. Hard maxima cap settings (e.g. calls ≤ ${HARD_MAXIMA.maxModelCalls}).`,
      );
      if (config.projectOverrides.length) lines.push(`- Project overrides: ${config.projectOverrides.join(", ")}`);
      const active = new Set(pi.getActiveTools());
      const hostTools = ["read", "grep", "find", "ls"].filter((t) => active.has(t));
      const discovery = active.has("grep") || active.has("find") || active.has("ls");
      lines.push(
        `- Capabilities: the wai_advisor tool uses Pi's permission-checked host tools (active now: ${hostTools.join(", ") || "none"}). Slash commands get no such API in Pi 1.3.0, so /wai-advisor inspect is blocked; use --quick or ask the main agent to call wai_advisor. native_diff: not available.`,
      );
      if (!discovery)
        lines.push(`- Discovery tools are inactive (Pi's default active tools are read/bash/edit/write), so the tool can only read seed paths. To let it search, a human can add "defaultTools": ["+grep", "+find", "+ls"] to Pi settings or start Pi with --tools. The advisor never enables tools itself.`);
      lines.push(`- wai_advisor tool active for the main agent: ${active.has("wai_advisor") ? "yes" : "no (e.g. restricted by another extension)"}`);
      const role = restrictedRoleOf(ctx.sessionManager);
      if (role) lines.push(`- Restricted role in this chat: ${role} — consultations are refused here.`);
      const chatId = chatIdOf(ctx.sessionManager);
      const running = controller.activeFor(ctx.cwd, chatId);
      lines.push(`- Active request: ${running ? `${running.requestId} (${running.mode}, ${running.progress}, since ${running.startedAt})` : "none"}`);
      const last = controller.lastUsageFor(ctx.cwd, chatId);
      if (last) {
        const u = last.usage;
        lines.push(`- Last consultation ${last.requestId} [${last.state}]: ${u.modelCalls} call(s), ${u.evidenceRequests} evidence request(s), ~${u.estimatedInputTokens} est. input tokens, reported in/out ${u.actualInputTokens ?? "unknown"}/${u.actualOutputTokens ?? "unknown"}, cost ${u.costUsd === null ? "unknown" : `$${u.costUsd} (estimated)`}`);
      }
      lines.push(`- Records: ${RUNTIME_DIR.replaceAll("\\", "/")}/ (private; questions/excerpts can be sensitive)`);
      if (config.errors.length) lines.push(`- Configuration errors:\n  - ${config.errors.join("\n  - ")}`);
      show(pi, ctx, lines.join("\n"), config.errors.length ? "warning" : "info");
    },
  });

  pi.registerCommand("wai-advisor-history", {
    description: "List recent WAI Advisor requests in this project (metadata only): [count]",
    handler: async (args, ctx) => {
      const count = Math.min(50, Math.max(1, Number.parseInt(args.trim() || "10", 10) || 10));
      const history = new RequestStore(ctx.cwd).readHistory().slice(0, count);
      if (!history.length) {
        show(pi, ctx, "No WAI Advisor history in this project.");
        return;
      }
      show(
        pi,
        ctx,
        [`WAI Advisor history (latest ${history.length}; historical metadata, not current evidence):`, ...history.map((h) => `- ${h.requestId} ${h.createdAt} [${h.state}] ${h.mode}/${h.caller} ${h.model} — ${h.questionPreview}`)].join("\n"),
      );
    },
  });

  pi.registerCommand("wai-advisor-result", {
    description: "Show a saved WAI Advisor result: <request-id> [--full | --section summary|recommendations|evidence|limits]",
    handler: async (args, ctx) => {
      const [id, ...rest] = args.trim().split(/\s+/);
      if (!id || !UUID.test(id)) {
        show(pi, ctx, "Usage: /wai-advisor-result <request-id> [--full | --section summary|recommendations|evidence|limits]", "error");
        return;
      }
      const role = restrictedRoleOf(ctx.sessionManager);
      if (role || !ctx.isProjectTrusted()) {
        show(pi, ctx, role ? `WAI Advisor results are unavailable in this chat (restricted role: ${role}).` : "This project is not trusted in Pi; stored results are not readable here.", "error");
        return;
      }
      const full = rest.includes("--full");
      const sectionArg = rest[rest.indexOf("--section") + 1];
      const section = rest.includes("--section") && ["summary", "recommendations", "evidence", "limits"].includes(sectionArg ?? "") ? (sectionArg as "summary") : "summary";
      try {
        const store = new RequestStore(ctx.cwd);
        const stored = store.readResult(id, projectKeyOf(canonicalRoot(ctx.cwd)));
        if (!stored) {
          show(pi, ctx, `No saved result ${id} in this project.`, "warning");
          return;
        }
        const body = renderSection(stored, full ? "full" : section);
        const { page } = pageText(body, 0, 60_000);
        const paths = `Artifacts: ${store.relativePath(id, "result.json")}, ${store.relativePath(id, "ANSWER.md")}, ${store.relativePath(id, "evidence-index.json")}`;
        show(pi, ctx, `${full ? "(Full detailed result — displayed to you only; not added to the model context.)\n" : ""}${page}\n${paths}`);
      } catch (error) {
        show(pi, ctx, error instanceof StoreError ? error.message : `Could not read result: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("wai-advisor-cancel", {
    description: "Cancel the active WAI Advisor request in this chat",
    handler: async (_args, ctx) => {
      const cancelled = controller.cancel(ctx.cwd, chatIdOf(ctx.sessionManager));
      show(pi, ctx, cancelled ? `Cancellation requested for ${cancelled}. Remote cancellation is best effort; incurred usage is still recorded.` : "No active WAI Advisor request in this chat.");
    },
  });
}
