/**
 * A NativeToolHost backed by Pi's REAL built-in read/grep/find/ls tools (1.3.0),
 * so tests exercise actual host output formats. Denials emulate a permission hook
 * (Pi's executeTool returns isError for blocked calls).
 */
import { createFindTool, createGrepTool, createLsTool, createReadTool } from "@earendil-works/pi-coding-agent";
import type { HostToolName, HostToolOutcome, NativeToolHost } from "../../src/evidence/native-tools.ts";

export interface HostCall {
  name: HostToolName;
  args: Record<string, unknown>;
}

export interface RealHostOptions {
  tools?: HostToolName[];
  /** Return a blocked/denied outcome (like a tool_call hook) for matching calls. */
  deny?: (call: HostCall) => string | null;
  /** Throw from execute for matching calls. */
  throwOn?: (call: HostCall) => boolean;
  /** Called before each execution (e.g. to mutate files or revoke tools). */
  before?: (call: HostCall, host: RealHost) => void | Promise<void>;
}

export interface RealHost extends NativeToolHost {
  calls: HostCall[];
  available: Set<string>;
}

export function realHost(root: string, options: RealHostOptions = {}): RealHost {
  const tools = {
    read: createReadTool(root),
    grep: createGrepTool(root),
    find: createFindTool(root),
    ls: createLsTool(root),
  };
  const host: RealHost = {
    cwd: root,
    calls: [],
    available: new Set(options.tools ?? ["read", "grep", "find", "ls"]),
    callableToolNames: () => [...host.available],
    async execute(name, args, signal): Promise<HostToolOutcome> {
      const call = { name, args };
      host.calls.push(call);
      await options.before?.(call, host);
      if (!host.available.has(name)) return { text: `Tool ${name} not found`, isError: true };
      const denied = options.deny?.(call);
      if (denied) return { text: denied, isError: true };
      if (options.throwOn?.(call)) throw new Error(`host ${name} exploded`);
      try {
        const result = await tools[name].execute(`test-${host.calls.length}`, args as never, signal);
        const content = result.content as Array<{ type: string; text?: string }>;
        if (content.some((c) => c.type !== "text")) return { text: "", isError: true, invalid: `Host ${name} returned non-text content.` };
        return { text: content.map((c) => c.text ?? "").join("\n"), isError: false };
      } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  };
  return host;
}
