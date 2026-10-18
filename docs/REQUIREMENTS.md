# Requirements → implementation → evidence

Design package: `C:\WJ_Files\documentation\waia\WAI-Advisor-System-Design` (17 Oct 2026).
Scope implemented: standalone phases A–E. Tests are offline; they establish behavior and
limits, not model quality.

| ID | Requirement | Implementation | Tests |
| --- | --- | --- | --- |
| RA-01 | Standalone, no Yoowai/WAICC runtime dependency | `package.json` peer deps are host-provided Pi packages only; no imports of Yoowai/WAICC | `tests/host/*` load the extension alone |
| RA-02 | Inspect follows missing evidence in a bounded loop | `core/engine.ts`, `core/protocol.ts`, `evidence/discovery.ts` | `investigation.test.ts` "requests and reads an additional, initially unseeded file"; host test main→tool→nested reads |
| RA-03 | Containment + host/role policy on every access, no bypass | `evidence/path-policy.ts`, `evidence/broker.ts`, `evidence/native-tools.ts`, `integration/session.ts` | `path-policy.test.ts`; denial/missing/revoked/throwing hosts; host test with real `tool_call` block; restricted recipient (unit + host) |
| RA-04 | Language-neutral + Java/Spring + full-stack | manifest listing + literal search (no TS index); `core/profile.ts` guidance | Kotlin, Dart, Python discovery; React↔Spring DTO mismatch citing both sides; multi-module tenant defect vs clean control |
| RA-05 | Per-call, cumulative, evidence, time, output, cost budgets | `core/budget.ts`, engine reservations, `effectiveTokenLimits` | `protocol-budget.test.ts` boundaries; lifecycle "budgets and retry accounting"; deadline; cost cap blocks before any call |
| RA-06 | Minimize shared/persisted data; filter secrets/metadata/generated | policy on hits/listings/seeds/reads; `evidence/redact.ts`; bounded excerpts; no transcripts | sensitive-path test (prompt + store contain no secret); `redact.test.ts`; persistence test (no system prompt stored) |
| RA-07 | Real, scoped, labelled evidence; no fabricated execution/approval | broker-minted IDs, `core/answer-validation.ts`, `authority: "none"`, `deliveryVerified: false`, standing limit line | out-of-range citation rejected; caller_report vs direct_observation; authority-language warning |
| RA-08 | Cancellation, snapshots, freshness, session isolation | `core/controller.ts` (abort, deadline, epoch fence, busy), `broker.recheck` | lifecycle "freshness" and "cancellation…" suites; host Esc abort |
| RA-09 | Short main-agent result across all channels | `integration/compact-output.ts` counts content + details; no structuredContent | bounded-output tests at 4000/1200/600; host checks tool result size |
| RA-10 | Atomic private history; no memory/paid resume | `storage/request-store.ts` | persistence, failed write, interrupted marking, corrupt result, explicit lookup |
| RA-11 | Main agent keeps decisions; adapters cannot change authority | advice-only envelope; no integration adapters shipped | — (Phase F deferred) |
| RA-12 | Supported-host validation, docs, notices, honest evaluation | `docs/HOST_COMPATIBILITY.md`, README, this file | real `AgentSession` + real CLI tests |

## Design test-matrix coverage (IMPLEMENTATION_PLAN §9)

Covered: traversal/absolute/UNC/device/ADS/case variants/reserved names, junction escape,
link to sensitive target, broken link (skipped when the OS denies file-symlink creation);
sensitive files via reads, seeds, listing and search; binary/oversize/long-line files;
native read/search/list missing, denied, revoked, throwing — no fallback; restricted role;
source prompt injection; unseeded second file; Kotlin/Dart/Python without TS index;
Java multi-module + full-stack mismatch + clean control; hidden body cannot be cited;
search no-matches/pagination/truncation, repeated reads; supplied logs labelled; every
limit below/equal/above; model capacity below config; missing price; unknown usage;
transient retry/repair/synthesis consume calls; parallel reads cannot overspend; no call
after cancel/deadline; local partial when synthesis is unaffordable; channel bounds;
stale/denied recheck/out-of-range change; busy; settings on next request; late result
fenced after session switch; interrupted reload; corrupt artifacts/failed writes;
explicit same-project lookup; actual host loading/commands/picker/tool; quick mode without
tools; read-only host with seeds; no automatic calls on start.

Not covered (and why): unreadable-file permissions (not reliably reproducible on Windows
test accounts); access-time path replacement race (mitigated by before/after checks,
documented, not OS-isolated); "unavailable external facts → consolidated decision" is
model behavior (only the display/count contract is tested); Linux/macOS execution;
any live provider.

## Independent review

One whole-change review was done by an independent agent after implementation
(2 high, 7 medium, 9 low findings). All were addressed, each with a regression test in
`tests/integration/review-fixes.test.ts` (plus a host test for the result-tool role gate):
host-side search exclusions (H1), citations to evidence omitted from the answering call
(H2), answer kept as stale on a recheck deadline (M1), role/trust gate on stored results
(M2), redacted supplied evidence on disk (M3), busy slot/epoch claimed before any await
(M4), host calls raced against the deadline (M5), unknown cost never reported as $0 (M6),
project settings lower-only (M7), private-key block redaction (L1), `src/`-aware generated
dirs (L2), escape-safe size bound (L3), approval-language surfaced (L4), distinct search
IDs (L5), prefix-based recheck of trimmed pages (L6), store hardening (L7), notice parsing
(L8). L9 (Pi's own `nestedCalls` record) is a host channel and is documented, not changed.

## Deferred (explicitly out of v1)

WAICC adapter, Yoowai adapter, automatic consultation, raw transcript recording,
trusted memory/promotion, cross-request answer cache, multi-model councils, test or
command execution, native VCS diff reader (Pi 1.3.0 has no host diff tool), legacy/direct
filesystem read mode, multi-root access, live evaluation corpus.
