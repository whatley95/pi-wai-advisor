/**
 * Supported-host tests: a real Pi 1.3.0 AgentSession loads the extension from its
 * file path (jiti loader), the main agent (faux provider) calls the wai_advisor
 * tool, and nested reads run through Pi's executeTool with real tool_call hooks.
 * Both models are offline faux providers; no network or real settings are used.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type FauxProviderHandle, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionUIContext, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_ID } from "../../src/core/protocol.ts";
import { project, tempDir } from "../helpers/harness.ts";

const EXTENSION_PATH = resolve(fileURLToPath(new URL("../../src/index.ts", import.meta.url)));
const DTO = "backend/src/main/java/com/example/customer/CustomerRequest.java";
const ENTITY = "backend/src/main/java/com/example/customer/Customer.java";

type Context = { messages: Array<{ role: string; content: unknown }> };

function lastUserText(context: Context): string {
  const user = [...context.messages].reverse().find((m) => m.role === "user");
  if (!user) return "";
  return typeof user.content === "string" ? user.content : (user.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
}

function idFor(prompt: string, path: string): string {
  const m = new RegExp(`\\[(E\\d+)\\] source_range ${path.replace(/[.]/g, "\\.")}`).exec(prompt);
  if (!m) throw new Error(`no evidence for ${path}`);
  return m[1] as string;
}

interface Setup {
  session: AgentSession;
  root: string;
  agentDir: string;
  main: FauxProviderHandle;
  advisor: FauxProviderHandle;
  advisorPrompts: string[];
  blockedReads: string[];
}

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let sessions: AgentSession[] = [];

beforeEach(() => {
  sessions = [];
});
afterEach(() => {
  for (const s of sessions) s.dispose();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  vi.restoreAllMocks();
});

async function setup(options: { consent?: boolean; limits?: Record<string, unknown>; recipient?: boolean; uiContext?: ExtensionUIContext; mode?: "print" | "rpc" } = {}): Promise<Setup> {
  const root = project("spring-react");
  const agentDir = tempDir("wai-host-agent-");
  process.env.PI_CODING_AGENT_DIR = agentDir; // the file-loaded extension resolves settings here
  const main = fauxProvider({ provider: "faux-main", models: [{ id: "main-1", contextWindow: 200_000, maxTokens: 8_000 }] });
  // The advisor faux uses a retry-verified API id, as a real provider would.
  const advisor = fauxProvider({ provider: "faux-advisor", api: "openai-completions", models: [{ id: "advisor-1", contextWindow: 128_000, maxTokens: 4_000, reasoning: true }] });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      "pi-wai-advisor": {
        model: { provider: "faux-advisor", id: "advisor-1", effort: "low" },
        ...(options.consent === false ? {} : { sourceSharingConsent: { provider: "faux-advisor", id: "advisor-1", confirmedAt: "2026-10-17T00:00:00Z" } }),
        ...(options.limits ? { limits: options.limits } : {}),
      },
    }),
  );
  const blockedReads: string[] = [];
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [EXTENSION_PATH],
    extensionFactories: [
      (pi) => {
        pi.registerProvider(main.provider);
        pi.registerProvider(advisor.provider);
        // A permission extension: blocks reads of the entity file (real tool_call hook).
        pi.on("tool_call", (event) => {
          if (event.toolName === "read" && String((event.input as { path?: string }).path).endsWith("Customer.java")) {
            blockedReads.push(String((event.input as { path?: string }).path));
            return { block: true, reason: "Blocked by test permission policy" };
          }
          return undefined;
        });
        if (options.recipient) pi.on("session_start", () => pi.appendEntry("waicc-session", { role: "recipient", sessionId: "s1" }));
      },
    ],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    model: main.getModel(),
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(root),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    tools: ["read", "grep", "find", "ls", "wai_advisor", "wai_advisor_result"],
  });
  sessions.push(session);
  await session.bindExtensions({ mode: options.mode ?? "print", ...(options.uiContext ? { uiContext: options.uiContext } : {}) });
  const advisorPrompts: string[] = [];
  return { session, root, agentDir, main, advisor, advisorPrompts, blockedReads };
}

/** Print-mode command output goes to stderr (Pi reserves stdout for the assistant answer). */
function captureStderr(): string[] {
  const out: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  return out;
}

describe("real Pi host", () => {
  it("loads the extension and registers only the intended commands and tools", async () => {
    const { session } = await setup();
    const tools = session.getActiveToolNames();
    expect(tools).toEqual(expect.arrayContaining(["wai_advisor", "wai_advisor_result"]));
    const commands = session.extensionRunner.getRegisteredCommands().map((c) => c.name).filter((n) => n.startsWith("wai-advisor"));
    expect(commands.sort()).toEqual(["wai-advisor", "wai-advisor-cancel", "wai-advisor-history", "wai-advisor-model", "wai-advisor-result", "wai-advisor-status"]);
    // No model call happens on load / session start.
  });

  it("main agent → wai_advisor → nested permission-checked reads → bounded tool result", async () => {
    const s = await setup();
    s.main.setResponses([
      fauxAssistantMessage(fauxToolCall("wai_advisor", { question: "The React form posts a customer but the Spring Boot API stores no street address. Why?" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("I will verify the cited code before changing anything.")),
    ]);
    const providerOptions: Array<SimpleStreamOptions | undefined> = [];
    s.advisor.setResponses([
      (context: Context, options?: SimpleStreamOptions) => {
        providerOptions.push(options);
        s.advisorPrompts.push(lastUserText(context));
        return fauxAssistantMessage(
          JSON.stringify({
            protocol: PROTOCOL_ID,
            type: "evidence",
            requests: [
              { tool: "read_file", path: DTO, startLine: 1, endLine: 10 },
              { tool: "read_file", path: ENTITY, startLine: 1, endLine: 20 },
              { tool: "read_file", path: "backend/.env", startLine: 1, endLine: 5 },
            ],
          }),
        );
      },
      (context: Context) => {
        const prompt = lastUserText(context);
        s.advisorPrompts.push(prompt);
        return fauxAssistantMessage(
          JSON.stringify({
            protocol: PROTOCOL_ID,
            type: "answer",
            answer: {
              recommendation: "CustomerRequest binds `streetAddress`; check the client field name.",
              rationale: "DTO field observed.",
              basis: "source_backed",
              citations: [{ evidenceId: idFor(prompt, DTO), claim: "DTO field", startLine: 7, endLine: 7, support: "direct_observation" }],
              verificationSuggestions: [],
              missingEvidence: ["Customer.java was blocked by permission policy"],
              risks: [],
              humanDecisions: [],
            },
          }),
        );
      },
    ]);
    await s.session.prompt("Ask the advisor about the missing address.");

    // The real Pi adapter disables SDK retries and applies the output cap and selected effort.
    expect(providerOptions[0]).toMatchObject({ maxRetries: 0, maxTokens: 1200, reasoning: "low" });
    expect(s.advisor.state.callCount).toBe(2);
    // Nested reads ran through Pi's tool_call hook: the entity read was blocked there.
    expect(s.blockedReads).toEqual([ENTITY]);
    const second = s.advisorPrompts[1] as string;
    expect(second).toContain("String streetAddress");
    expect(second).toMatch(/ERROR host_error: Blocked by test permission policy/);
    expect(second).toMatch(/ERROR sensitive_path/); // .env denied before reaching the host
    expect(second).not.toContain("do-not-leak");

    const toolResult = s.session.messages.find((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "wai_advisor") as unknown as {
      content: Array<{ type: string; text: string }>;
      details: unknown;
      isError: boolean;
      nestedCalls?: { calls: Array<{ name: string }> };
    };
    expect(toolResult.isError).toBe(false);
    const text = toolResult.content.map((c) => c.text).join("");
    expect(JSON.stringify({ content: toolResult.content, details: toolResult.details }).length).toBeLessThanOrEqual(4000);
    expect(text).toMatch(/WAI Advisor \[partial\]/);
    expect(text).toContain(`${DTO}:7`);
    expect(toolResult.nestedCalls?.calls.map((c) => c.name)).toEqual(expect.arrayContaining(["read", "find", "grep"]));
    expect(toolResult.nestedCalls?.calls.some((c) => c.name === "bash" || c.name === "write" || c.name === "edit")).toBe(false);

    // Result persisted privately and retrievable through the bounded result tool.
    const requestId = /request ([0-9a-f-]{36})/.exec(text)?.[1] as string;
    const stored = JSON.parse(readFileSync(join(s.root, ".pi", "pi-wai-advisor", "requests", requestId, "result.json"), "utf8"));
    expect(stored.authority).toBe("none");
    expect(stored.deliveryVerified).toBe(false);
    s.main.setResponses([fauxAssistantMessage(fauxToolCall("wai_advisor_result", { requestId, section: "evidence" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("ok"))]);
    await s.session.prompt("Show the evidence section.");
    const page = s.session.messages.filter((m) => m.role === "toolResult").at(-1) as unknown as { content: Array<{ text: string }>; details: unknown; isError: boolean };
    expect(page.isError).toBe(false);
    expect(JSON.stringify({ content: page.content, details: page.details }).length).toBeLessThanOrEqual(4000);
    expect(page.content[0]?.text).toMatch(/historical record/);
  });

  it("Pi abort (Esc) propagates to the consultation: cancelled, no further model calls, persisted", async () => {
    const s = await setup();
    s.main.setResponses([fauxAssistantMessage(fauxToolCall("wai_advisor", { question: "Why is the address missing?" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("ok"))]);
    let started!: () => void;
    const begun = new Promise<void>((r) => (started = r));
    s.advisor.setResponses([
      (_context: Context, options?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          started();
          options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
        }),
    ]);
    const run = s.session.prompt("ask");
    await begun;
    await s.session.abort();
    await run.catch(() => undefined);
    expect(s.advisor.state.callCount).toBe(1);
    const dir = join(s.root, ".pi", "pi-wai-advisor");
    const history = JSON.parse(readFileSync(join(dir, "history.json"), "utf8")) as Array<{ state: string }>;
    expect(history[0]?.state).toBe("cancelled");
  });

  it("refuses the tool for a restricted WAICC recipient chat", async () => {
    const s = await setup({ recipient: true });
    s.main.setResponses([fauxAssistantMessage(fauxToolCall("wai_advisor", { question: "help?" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("ok"))]);
    await s.session.prompt("go");
    const result = s.session.messages.find((m) => m.role === "toolResult") as unknown as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/restricted role/);
    expect(s.advisor.state.callCount).toBe(0);
    // Stored results (which contain source excerpts) are refused too.
    s.main.setResponses([fauxAssistantMessage(fauxToolCall("wai_advisor_result", { requestId: "8f0430a1-9962-4c44-8912-e70ce923e821" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("ok"))]);
    await s.session.prompt("read a result");
    const page = s.session.messages.filter((m) => m.role === "toolResult").at(-1) as unknown as { isError: boolean; content: Array<{ text: string }> };
    expect(page.isError).toBe(true);
    expect(page.content[0]?.text).toMatch(/restricted role/);
  });

  it("slash commands: inspect is blocked without host tools; --quick runs directly; status/history/result/cancel work in print mode", async () => {
    const s = await setup();
    const out = captureStderr();
    await s.session.prompt("/wai-advisor Why is the address missing?");
    expect(out.join("")).toMatch(/\[blocked\][\s\S]*No local or shell fallback/);
    expect(s.advisor.state.callCount).toBe(0);
    expect(s.main.state.callCount).toBe(0); // no main-agent inference for commands

    s.advisor.setResponses([
      fauxAssistantMessage(
        JSON.stringify({ protocol: PROTOCOL_ID, type: "answer", answer: { recommendation: "Prefer a Map for dynamic keys.", rationale: "", basis: "general_reasoning", citations: [], verificationSuggestions: [], missingEvidence: [], risks: [], humanDecisions: [] } }),
      ),
    ]);
    out.length = 0;
    await s.session.prompt("/wai-advisor --quick Map or Record for fixed cache keys?");
    const quick = out.join("");
    expect(quick).toMatch(/\[completed\][\s\S]*Prefer a Map/);
    expect(s.advisor.state.callCount).toBe(1);
    expect(s.main.state.callCount).toBe(0);
    const requestId = /request ([0-9a-f-]{36})/.exec(quick)?.[1] as string;

    out.length = 0;
    await s.session.prompt("/wai-advisor-status");
    expect(out.join("")).toMatch(/Model: faux-advisor\/advisor-1 \(reasoning low\)[\s\S]*compatible and authenticated[\s\S]*Slash commands get no such API/);
    out.length = 0;
    await s.session.prompt("/wai-advisor-history");
    expect(out.join("")).toContain(requestId);
    out.length = 0;
    await s.session.prompt(`/wai-advisor-result ${requestId} --full`);
    expect(out.join("")).toMatch(/displayed to you only[\s\S]*Prefer a Map/);
    out.length = 0;
    await s.session.prompt("/wai-advisor-cancel");
    expect(out.join("")).toMatch(/No active WAI Advisor request/);
    out.length = 0;
    await s.session.prompt("/wai-advisor --quick --file a.ts q");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    // Command results never entered the model context.
    expect(s.session.messages.some((m) => JSON.stringify(m).includes("Prefer a Map"))).toBe(false);
  });

  it("missing consent and non-interactive picker fail with clear errors", async () => {
    const s = await setup({ consent: false });
    const errors = captureStderr();
    await s.session.prompt("/wai-advisor --quick q?");
    expect(errors.join("")).toMatch(/Source-sharing consent is missing/);
    await s.session.prompt("/wai-advisor-model");
    expect(errors.join("")).toMatch(/interactive only/);
    expect(s.advisor.state.callCount).toBe(0);
    process.exitCode = 0;
  });

  it("interactive picker (RPC UI) selects model + effort, records consent and preserves unrelated settings", async () => {
    const notes: string[] = [];
    const answers = ["Select or change model", "faux-advisor/advisor-1", "high"];
    const ui = {
      select: vi.fn(async (_title: string, options: string[]) => {
        const want = answers.shift();
        return options.find((o) => o === want || o.startsWith(`${want} `) || o.startsWith(want ?? "\u0000"));
      }),
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => undefined),
      notify: vi.fn((m: string) => notes.push(m)),
      setStatus: vi.fn(),
    } as unknown as ExtensionUIContext;
    const s = await setup({ consent: false, mode: "rpc", uiContext: ui });
    const settingsPath = join(s.agentDir, "settings.json");
    const before = JSON.parse(readFileSync(settingsPath, "utf8"));
    writeFileSync(settingsPath, JSON.stringify({ ...before, theme: "light", unrelated: { a: 1 } }));
    await s.session.prompt("/wai-advisor-model");
    const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(saved.theme).toBe("light");
    expect(saved.unrelated).toEqual({ a: 1 });
    expect(saved["pi-wai-advisor"].model).toEqual({ provider: "faux-advisor", id: "advisor-1", effort: "high" });
    expect(saved["pi-wai-advisor"].sourceSharingConsent).toMatchObject({ provider: "faux-advisor", id: "advisor-1" });
    expect((ui.confirm as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatch(/provider's own data-retention policy/);
    expect(notes.join("\n")).toMatch(/Applies to the next consultation/);
    mkdirSync(join(s.root, ".pi"), { recursive: true });
  });
});
