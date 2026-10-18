/**
 * Human-visible command output that respects Pi's mode conventions. Results are
 * shown to the human but never injected into the next model turn:
 * - tui:   a custom session entry (excluded from LLM context) rendered in the transcript
 * - rpc:   an extension UI notification plus the same custom entry
 * - print: stderr (Pi reserves stdout for the assistant answer); errors set a non-zero exit code
 * - json:  the custom entry, which Pi emits on stdout as an entry_appended JSON event
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const OUTPUT_ENTRY = "wai-advisor-output";

export type OutputLevel = "info" | "warning" | "error";

export function show(pi: ExtensionAPI, ctx: ExtensionContext, text: string, level: OutputLevel = "info", data?: Record<string, unknown>): void {
  let mode: string;
  try {
    mode = ctx.mode;
  } catch {
    return; // stale context after a session switch: never publish into a replacement chat
  }
  if (mode === "print") {
    // Pi's print mode reserves stdout for the assistant's final answer (its output
    // guard redirects extension stdout writes to stderr), so command output goes to stderr.
    process.stderr.write(`${text}\n`);
    if (level === "error") process.exitCode = 1;
    return;
  }
  // tui/rpc render the entry; json mode emits it on stdout as an `entry_appended` event.
  try {
    pi.appendEntry(OUTPUT_ENTRY, { text, level, ...(data ?? {}) });
  } catch {
    /* session gone */
  }
  if (mode === "json") {
    if (level === "error") process.exitCode = 1;
    return;
  }
  if (mode === "rpc" || level !== "info") {
    try {
      ctx.ui.notify(level === "info" ? text : text.split("\n")[0] ?? text, level);
    } catch {
      /* no UI */
    }
  }
}
