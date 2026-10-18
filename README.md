# WAI Advisor (Whatley AI Advisor) — `pi-wai-advisor`

A standalone [Pi](https://pi.dev) extension that gives the main coding agent an
independent, **read-only, source-aware second opinion** from a separately selected
model. The advisor searches and reads permitted project source itself — through Pi's
permission-checked `read`/`grep`/`find` tools — within strict budgets, and returns
short advice with evidence IDs, file/line citations and honest limits.

The advisor recommends; the main agent verifies and decides. It never edits code,
runs commands or tests, approves, sets PASS, resolves human gates or certifies delivery.

Status: v0.1.0, standalone phases A–E of the design implemented and tested **offline**
(scripted models, Pi's real tools, a real Pi 1.3.0 session/CLI). No live provider has
been called; see [Limitations](#limitations).

## Install

Requirements: Pi `@earendil-works/pi-coding-agent` **1.3.0** (the only version tested;
see [docs/HOST_COMPATIBILITY.md](docs/HOST_COMPATIBILITY.md)). Node 22 was used for testing.

```bash
# try for one session
pi -e C:/dev/wtly/pi-wai-advisor

# or install as a local package (writes to ~/.pi/agent/settings.json)
pi install C:/dev/wtly/pi-wai-advisor

# or install from GitHub
pi install git:github.com/whatley95/pi-wai-advisor
```

The package has no runtime dependencies besides host-provided Pi packages, and no
dependency on Yoowai or WAICC. Nothing runs on load or session start: no model calls,
no background work.

**Enable discovery tools (recommended).** Pi 1.3.0's default active tools are
`read`, `bash`, `edit`, `write`; its `grep`/`find`/`ls` tools are callable only when
active. The advisor uses exactly the tools your session allows and never enables tools
itself, so with the defaults it can only read seed paths. To let it search, add to
`~/.pi/agent/settings.json` (or start Pi with `--tools +grep,+find,+ls`):

```json
{ "defaultTools": ["+grep", "+find", "+ls"] }
```

`/wai-advisor-status` shows which host tools are active.

**Subagents.** A subagent extension that starts separate `pi` processes loads every
installed package in each child, so a globally installed advisor is also callable there
(sharing the same global model choice, consent and Pi login). To keep advisor use in the
main session only, load it with `pi -e` rather than `pi install`, or start subagents
with a tool list that omits `wai_advisor`.

## Choose the advisor model

```text
/wai-advisor-model
```

Interactive picker (TUI/RPC): pick any **authenticated, compatible** model exposed by
Pi — independent of the main agent's model — and a supported reasoning level (or the
provider default). You must then confirm the **source-sharing boundary**: your question,
constraints, caller snippets and the project excerpts/paths/search results the advisor
reads are sent to that provider, whose own retention policy applies. Consent is stored
for that exact provider/model in global settings. The same command enables/disables
the advisor. Changes apply to the next consultation; a running one keeps its snapshot.

"Compatible" means Pi resolves auth for it, it is a text chat model, the reasoning
level is supported, and its API is one where WAI Advisor verified that SDK retries are
disabled (so `maxModelCalls` is enforceable): `anthropic-messages`,
`openai-completions`, `openai-responses`, `azure-openai-responses`,
`openai-codex-responses`, `google-generative-ai`, `google-vertex`,
`mistral-conversations`, `pi-messages`. Bedrock (opaque AWS SDK retries), virtual/routed
models and unknown extension APIs are refused. There is no automatic provider fallback.

Non-interactive setup (print/JSON/RPC without a picker) uses settings directly:

```json
{
  "pi-wai-advisor": {
    "model": { "provider": "YOUR_PROVIDER", "id": "YOUR_MODEL", "effort": "high" },
    "sourceSharingConsent": { "provider": "YOUR_PROVIDER", "id": "YOUR_MODEL", "confirmedAt": "2026-10-17T00:00:00Z" }
  }
}
```

## Use it

**Main agent tool (recommended for source investigation):** the agent calls
`wai_advisor` with a focused question:

```json
{ "question": "Trace the React customer form through the Spring Boot API: why is the address missing?",
  "constraints": ["Do not change the public API"],
  "seedPaths": ["frontend/src/api/customerClient.ts"],
  "suppliedEvidence": [{ "label": "server log", "text": "...", "sourceKind": "caller_log" }] }
```

It returns a compact envelope (≤ `maxReturnChars` across *all* channels):

```text
WAI Advisor [completed] request 8f0430a1-…
Advice: The client sends `address` but CustomerRequest binds `streetAddress`; …
Evidence: E4 frontend/src/api/customerClient.ts:14; E5 backend/…/CustomerRequest.java:7
Limits:
- Advice only: the advisor ran no tests or commands and has no authority to approve, set PASS or certify delivery.
Detailed result: .pi/pi-wai-advisor/requests/8f0430a1-…/result.json (page it with wai_advisor_result; …)
```

`wai_advisor_result` pages a stored result (`summary`, `recommendations`, `evidence`,
`limits`) in bounded chunks; it never runs another consultation.

**Human commands:**

| Command | Behavior |
| --- | --- |
| `/wai-advisor [--quick] [--file "path"]... [--] <question>` | Consult directly (no main-agent inference); result shown to you, not injected into the model context |
| `/wai-advisor-model` | Pick model/effort, confirm source sharing, enable/disable |
| `/wai-advisor-status` | Model, compatibility, consent, effective limits, capabilities, active request, last usage |
| `/wai-advisor-history [n]` | Recent request metadata (bounded) |
| `/wai-advisor-result <id> [--full \| --section s]` | Saved result and artifact paths; `--full` shows `ANSWER.md` (display only) |
| `/wai-advisor-cancel` | Cancel this chat's active consultation |

> **Important host limitation:** Pi 1.3.0 gives slash-command handlers no
> permission-checked tool API (`executeTool` exists only for tools). So
> `/wai-advisor <question>` in **inspect** mode reports `blocked` instead of reading
> files any other way. Use `/wai-advisor --quick …` for advice without source access,
> or ask the main agent to call `wai_advisor`, which investigates with Pi's tool
> permissions. See [docs/HOST_COMPATIBILITY.md](docs/HOST_COMPATIBILITY.md).

Output by mode: TUI shows a transcript entry (excluded from LLM context); RPC adds a
notification; print mode writes to **stderr** (Pi reserves stdout for the assistant
answer) and exits non-zero on errors; JSON mode emits an `entry_appended` event
(`customType: "wai-advisor-output"`) on stdout. Interactive consultations run in the
background so `/wai-advisor-cancel` stays usable.

### Modes

- **inspect** (default): language-neutral discovery (build manifests + literal
  identifier search; no TS/AST index needed — Kotlin, Java, Dart, Python, TS/JS, SQL,
  YAML… all work), then a bounded evidence-or-answer loop. Full-stack guidance
  (Java/Spring, API contracts, security, persistence, web/mobile, tests) is selected
  per question inside the same budget.
- **quick**: one model attempt, no source tools, no retries; never claims to have
  inspected source. `--quick` with `--file` is rejected.

### Result states

`completed` (consultation answered within limits — not code completion),
`partial` (useful but evidence/citations/allowance missing, or no conclusion but
evidence gathered), `blocked` (model/scope/capability unavailable), `stale` (cited
ranges changed or could not be rechecked before publication), `cancelled`, `failed`.

## Configuration

Namespace `pi-wai-advisor` in Pi's settings. Precedence: built-in defaults < global
(`~/.pi/agent/settings.json`) < project (`.pi/settings.json`, only when the project is
trusted), capped by hard maxima (values above are rejected, never clamped up). A
repository's project settings may only **lower** limits and may add or lower — never
raise or remove — a cost cap; raising is a human action in global settings. Tool input
can never raise a limit. Source-sharing consent is read only from global settings.

| Limit | Default | Hard max | Meaning |
| --- | --- | --- | --- |
| maxModelCalls | 4 | 12 | Every billed attempt incl. retry, repair, synthesis |
| maxEvidenceRequests | 8 | 40 | Reads/searches/lists incl. discovery, failures, repeats, freshness rechecks |
| maxInputTokens | 16000 | 200000 | Per-call **estimate**, further lowered by model capacity |
| maxCumulativeInputTokens | 48000 | 600000 | Estimated input summed over all attempts |
| maxOutputTokens | 1200 | 32000 | Provider output cap per call |
| maxSerializedRequestBytes | 98304 | 1 MiB | Exact UTF-8 size of the payload this extension builds |
| maxEvidenceBytes | 32768 | 512 KiB | Retained evidence across the request |
| maxReadChars | 6000 | 50000 | Per read/search/list page |
| maxWallTimeMs | 90000 | 600000 | Total deadline; cancellation propagates |
| maxReturnChars | 4000 | 12000 | All main-visible channels combined |
| maxCostUsd | null | — | Optional; reserves estimated input + max output per call; unknown prices block |

Quick mode forces `maxModelCalls=1`, `maxEvidenceRequests=0`. Other keys: `defaultMode`
(`inspect`/`quick`), `enabled`. `autoConsult`, `storeRawTranscripts` and `integrations`
are reserved: enabling them is rejected in v1.

Token counts are estimates (`ceil(UTF-8 bytes / 3) + 16` per message), not provider
tokenization; actual usage is recorded separately when the provider reports it.
Reported cost is computed from Pi's catalog prices (`costBasis: "estimated"`), never a
billing statement; unknown is `null`, never zero.

## Privacy and safety model

- **Read-only broker**: `read_file`, `search_code`, `list_files` only; no command,
  shell, write, test, network or diff capability. Every access is a Pi tool call that
  passes through other extensions' `tool_call` hooks. Missing, inactive, revoked,
  blocked or failing tools are reported — **never** bypassed with local reads, shell,
  MCP or child processes.
- **Path policy** on scopes, every search hit/listing entry and every read, before and
  after access: rejects absolute/UNC/device paths, traversal, `:` (alternate data
  streams), reserved device names, trailing dots/spaces; checks containment through
  symlinks/junctions (metadata only); excludes VCS internals, generated/vendor output,
  `.pi/` runtime state and credential stores (`.env*`, keys, `.npmrc`, `local.properties`,
  `google-services.json`, `*.tfstate`, …). Content searches pass a case-insensitive
  negated glob to Pi's `grep` so excluded files are never opened by the host; if the
  host cannot apply it, the search fails closed. File *listings* (`find`/`ls`) cannot
  take exclusions in Pi 1.3.0, so excluded file **names** (never contents) may pass
  through the host tool pipeline before the broker withholds them. Secret-like values in
  permitted files and caller-supplied snippets (including whole private-key blocks) are
  redacted line-preservingly before model inclusion and persistence. **Redaction is
  best-effort, not a guarantee.**
- Source, logs and tool results are untrusted data; injected instructions cannot add
  actions (the protocol has no command action), switch provider or widen scope.
- The whole chat and prior transcripts are never forwarded. `previousRequestId` imports
  only a bounded summary labelled historical.
- Restricted chats (e.g. a WAICC handoff recipient) and untrusted projects are refused
  for consultations and for reading stored results (`wai_advisor_result`,
  `/wai-advisor-result`).
- Evidence whose text was cut from a model call to fit the budget cannot be cited from
  that call; such citations are rejected and the result becomes `partial`.
- Pi itself keeps a bounded `nestedCalls` record (tool names, arguments, short errors) of
  the advisor's host tool calls on the `wai_advisor` tool result, and compaction may list
  the files read. These are host channels outside the advisor's return envelope.
- "Read-only" describes the broker, not OS isolation; remote providers may retain data.

## Records

`<project>/.pi/pi-wai-advisor/requests/<id>/{request.json, events.jsonl,
evidence-index.json, result.json, ANSWER.md}` and `history.json`. Atomic writes,
confined to that directory. Stored: question/constraints, result, evidence references,
hashes and bounded redacted excerpts, usage/limits, errors, timestamps. Not stored:
provider transcripts, credentials, whole files. Questions and excerpts can still be
sensitive — add `.pi/pi-wai-advisor/` to your VCS ignore rules yourself (the extension
never edits project configuration). Interrupted requests are marked `failed` on the next
session start; paid work is never resumed.

## Development

```bash
npm install
npm run check      # tsc --noEmit + vitest (offline; PI_OFFLINE=1)
```

Tests use fixture projects, Pi's real `read`/`grep`/`find`/`ls` tools, scripted
advisor models, a real Pi 1.3.0 `AgentSession` with offline faux providers, and the
real Pi CLI entry. They establish orchestration, policy and limit behavior — **not**
model quality. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## Limitations

- No live provider/model has been exercised; advice quality, provider connectivity,
  real token accounting and real cost are unverified.
- Tested only on Windows 11 with Pi 1.3.0 and Node 22. Linux/macOS path behavior is
  covered only by lexical normalization tests, not by running on those platforms.
- Slash-command inspect mode is blocked by the host API (above).
- Retry control is verified per API id; an extension could register a provider that
  reuses a verified API id with its own retrying implementation.
- Search can miss dynamic references; freshness covers cited ranges only, not
  uncited lines or unread files. Rechecks share the evidence allowance (a small reserve
  is held back); answers citing more items than remain are reported `stale`
  (unconfirmed) rather than overspending. A deadline during rechecks keeps the answer
  and marks it `stale`.
- Esc does not cancel a background `/wai-advisor` command consultation; use
  `/wai-advisor-cancel` (Esc does cancel the `wai_advisor` tool).
- When provider cost is unknown, the tool reports no usage to Pi's session totals rather
  than a false $0; the result records tokens with `costUsd: null`.
- License not chosen yet (`UNLICENSED`, `private: true`): decide before distribution.
- Optional WAICC/Yoowai adapters, auto-consultation, memory, councils and execution
  features are deferred.
