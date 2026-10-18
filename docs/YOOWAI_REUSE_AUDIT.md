# Yoowai reuse audit (Phase A1)

Source inspected read-only: local checkout `C:\dev\wtly\pi-dev\pi-heyyo` at commit
`55dc1520131e831a90f8712f8cce0e11bd7d8cb4` (the commit pinned by the design). Nothing in
that checkout, `pi-waicc` or the WAI-A design was modified.

Licensing: Yoowai's `package.json` declares MIT, but no LICENSE file exists at that
commit. To avoid relying on an unconfirmed grant, **no Yoowai code was copied**; only
concepts were re-implemented. No third-party notices are therefore required.

| Component | Finding | Decision |
| --- | --- | --- |
| `src/actions/advisor.ts` | Up to 5 TS-index-selected files, no tool loop, plain-text answer; depends on Yoowai config, backends, cost tracking, progress | Not reused; replaced by the bounded evidence loop |
| `src/project-index.ts` / `project-snapshot.ts` | TS/JS-family symbol index; outlines instead of bodies | Not reused (design requires language-neutral discovery); "outlines are not evidence" rule kept |
| `src/tool-loop.ts` | Read/search/paging bounds, plus `run_command` and structured-review completion; local `searchCodeTool` reads files directly | Not reused; concepts kept: batch caps, reuse of identical reads, allowance messaging. `run_command` and local reads deliberately excluded |
| `src/integration/read-tools.ts` | Native `executeTool` dispatch with "no fallback after denial", but **falls back to local reads when the native API is missing** (e.g. commands) | Concept reused (dispatch + no fallback after denial). The missing-API local fallback is **not** adopted (v1 has no direct filesystem adapter) |
| `src/path-security.ts` | Relative-path validation; realpath walk of existing ancestors; broken links fail closed | Concept re-implemented in `evidence/path-policy.ts` with added device/ADS/reserved-name/trailing-dot checks and sensitive-target checks |
| `src/file-policy.ts` | Generated-directory list; binary detection | Concept re-implemented with a broader list, sensitive-file patterns and binary handling |
| Cost/cancellation patterns | Spread across Yoowai state/backends | Re-implemented in `core/budget.ts` / controller; unknown cost stays `null` |
