/**
 * Host-native tool access. The only source-access path in v1.
 *
 * Calls go through Pi's `ctx.executeTool()`, which applies argument validation and
 * every extension's `tool_call`/`tool_result` hooks exactly like model-issued calls.
 * A missing, inactive, blocked or failing host tool is reported as an error; there is
 * deliberately no local filesystem, shell, MCP or child-process fallback.
 */
import type { Capability } from "../contracts.ts";

/** Host tool names (Pi 1.3.0 built-ins) backing each broker capability. */
export const HOST_TOOLS = {
  read_file: ["read"],
  search_code: ["grep"],
  list_files: ["find", "ls"],
} as const;

export type HostToolName = "read" | "grep" | "find" | "ls";

export interface HostToolOutcome {
  /** Joined text content when the tool returned only text blocks. */
  text: string;
  isError: boolean;
  /** Set when the outcome could not be interpreted (non-text content, malformed). */
  invalid?: string;
}

/** Abstract invocation-scoped host tool access (injected; faked in unit tests). */
export interface NativeToolHost {
  readonly cwd: string;
  /** Live: re-evaluated on every call so later revocation is honored. */
  callableToolNames(): readonly string[];
  execute(name: HostToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<HostToolOutcome>;
}

/** Capabilities that can actually be called right now. `native_diff` has no Pi 1.3.0 host tool. */
export function snapshotCapabilities(host: NativeToolHost | null): Capability[] {
  if (!host) return [];
  const names = new Set(host.callableToolNames());
  const caps: Capability[] = [];
  if (HOST_TOOLS.read_file.some((n) => names.has(n))) caps.push("read_file");
  if (HOST_TOOLS.search_code.some((n) => names.has(n))) caps.push("search_code");
  if (HOST_TOOLS.list_files.some((n) => names.has(n))) caps.push("list_files");
  return caps;
}

interface PiToolCallOutcome {
  isError?: boolean;
  result?: { content?: Array<{ type?: string; text?: unknown }> };
}

interface PiToolContextLike {
  cwd: string;
  readonly tools: readonly { name: string }[];
  executeTool(name: string, args: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export function isPiToolContext(ctx: unknown): ctx is PiToolContextLike {
  const c = ctx as Partial<PiToolContextLike> | undefined;
  return !!c && typeof c.cwd === "string" && typeof c.executeTool === "function" && "tools" in c;
}

/** Adapter over Pi's ExtensionToolContext (available to tools, not to slash commands). */
export function piNativeToolHost(ctx: PiToolContextLike): NativeToolHost {
  return {
    cwd: ctx.cwd,
    callableToolNames: () => {
      try {
        return (ctx.tools ?? []).map((tool) => tool?.name).filter((name): name is string => typeof name === "string");
      } catch {
        return [];
      }
    },
    async execute(name, args, signal) {
      signal.throwIfAborted();
      const outcome = (await ctx.executeTool(name, args, { signal })) as PiToolCallOutcome;
      signal.throwIfAborted();
      const content = outcome?.result?.content;
      if (!Array.isArray(content)) return { text: "", isError: true, invalid: `Host ${name} returned no content.` };
      if (content.some((block) => block?.type !== "text" || typeof block.text !== "string"))
        return { text: "", isError: true, invalid: `Host ${name} returned non-text content.` };
      return { text: content.map((block) => block.text as string).join("\n"), isError: outcome.isError === true };
    },
  };
}
