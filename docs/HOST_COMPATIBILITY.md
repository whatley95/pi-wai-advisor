# Host compatibility (Pi runtime inspection)

Inspected and tested against `@earendil-works/pi-coding-agent` **1.3.0** (installed via
Volta on Windows 11; the pinned devDependency is the same version). No other version has
been tested; no compatibility range beyond 1.3.0 is claimed.

## APIs used

| Need | Pi 1.3.0 API | Notes |
| --- | --- | --- |
| Commands | `pi.registerCommand` | Handler gets `ExtensionCommandContext` (**no** `executeTool`) |
| Tools | `pi.registerTool` (TypeBox params, `executionMode`, `annotations`) | `exposure` default `direct` |
| Permission-checked source access | `ctx.executeTool(name, args, {signal})` + `ctx.tools` (tool context only) | Runs validation + every extension's `tool_call`/`tool_result` hook; blocked calls return `isError` |
| Advisor model call | `ctx.modelRegistry.streamSimple(model, context, options).result()` | Pi resolves auth; options `maxRetries: 0`, `maxTokens`, `reasoning`, `signal` |
| Model lookup / auth | `modelRegistry.getAll()/find()/hasConfiguredAuth()/getProviderAuth()` | The auth snapshot refreshes asynchronously; Pi's own `prompt()` falls back to an async check, and so does the advisor |
| Reasoning levels | mirrors pi-ai `getSupportedThinkingLevels` rules | `xhigh`/`max` only when mapped; `null` = unsupported |
| Settings path | `getAgentDir()` (`PI_CODING_AGENT_DIR` override) | Writes use Pi's `<settings>.lock` directory convention and preserve unrelated keys |
| Results shown to humans | `pi.appendEntry` + `pi.registerEntryRenderer` | Custom entries do not enter LLM context; JSON mode emits them as `entry_appended` |
| Lifecycle | `session_start`, `session_shutdown`, `session_tree` | Abort + fence late publication |
| Progress | `ctx.ui.setStatus`, tool `onUpdate` | No extra model calls |

## Findings that shaped the implementation

1. **Slash commands cannot use permission-checked tools.** `executeTool` is defined only
   on `ExtensionToolContext`. A command that read files would have to call built-in tool
   implementations directly, skipping other extensions' `tool_call` hooks (e.g. WAICC
   restrictions) — the bypass the design forbids. Therefore `/wai-advisor` inspect mode is
   `blocked` with an explanation; quick mode works; the `wai_advisor` tool investigates.
2. **Default sessions activate only `read` among read/grep/find/ls**
   (`DEFAULT_TOOL_NAMES = read, bash, edit, write`). Built-in grep/find/ls have `direct`
   exposure, so they are callable only when active. The advisor does not auto-activate
   tools; users opt in with `"defaultTools": ["+grep", "+find", "+ls"]`.
3. **Retry control.** In pi-ai 1.3.0, `anthropic-messages`, `openai-completions`,
   `openai-responses`, `azure-openai-responses` set SDK `maxRetries: 0` and wrap requests
   in `retryProviderRequest`, which retries only when `options.maxRetries > 0`;
   `google-generative-ai`/`google-vertex` use the same wrapper; `openai-codex-responses`
   defaults to 0; `mistral-conversations` and `pi-messages` issue a single `fetch`.
   `bedrock-converse-stream` constructs an AWS SDK client with default (opaque) retries →
   refused. Virtual models route to other models → refused. Unknown/extension API ids →
   refused. Providers registered through the legacy config path with a custom
   `streamSimple` → refused. Residual risk: a native provider can reuse a verified API id
   with its own implementation; this cannot be detected from the public API.
4. **Output guard.** In print/JSON mode Pi redirects extension `process.stdout.write` to
   stderr. Print-mode command output is therefore written to stderr deliberately; JSON mode
   uses `appendEntry` (emitted on stdout as an event).
5. **Command dispatch.** `session.prompt()` awaits command handlers. Interactive/RPC
   consultations run in the background so cancellation and the editor stay usable;
   print/JSON await so the process does not exit early.
6. `read` accepts absolute paths and follows links; `grep` uses `--hidden` and respects
   `.gitignore`. Hence the advisor validates/contains paths itself before *and* after each
   host call, passes a case-insensitive negated glob (`grep`'s `glob` → ripgrep `--glob`,
   verified to keep `.env`/`.ENV.local`/`*.pem`/`node_modules` unopened) and still filters
   every search hit and listing entry by policy. `find`/`ls` accept no exclusions, so
   excluded *names* can transit the host pipeline before being withheld.
7. Built-in tool output formats (parsed by the broker): read → raw lines plus an optional
   trailing `[Showing lines X-Y of N…]`/`[K more lines in file…]` notice; grep →
   `path:line: text`, `No matches found`, trailing limit notice; find/ls → one path per
   line, `No files found matching pattern` / `(empty directory)`.

## Verified by tests (offline)

- Real `AgentSession` (SDK) loads `src/index.ts` from its file path; main faux model calls
  `wai_advisor`; nested reads go through a real `tool_call` hook that blocks one file;
  `nestedCalls` shows only read/find/grep; result is bounded; `wai_advisor_result` pages.
- Pi abort (Esc) cancels the consultation and persists `cancelled`.
- Restricted WAICC recipient marker refuses the tool.
- Commands in print mode (SDK) and via the real CLI entry in print and JSON modes; the
  installed global `pi` 1.3.0 loaded the package directory (`-e <dir>`) without warnings.
- RPC-mode UI drives the model picker (selection, effort, consent, settings preservation).

Not verified: interactive TUI rendering by eye, RPC clients other than the test double,
Linux/macOS, live providers.
