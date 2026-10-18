/**
 * /wai-advisor argument parsing: [--quick] [--file "path"]... [--] question
 * Flags must precede the question; `--` ends flag parsing so a question may start
 * with "--". --quick with --file is rejected (quick mode never reads files).
 */
export type ParsedAdvisorArgs =
  | { ok: true; question: string; quick: boolean; files: string[] }
  | { ok: false; error: string };

export function parseAdvisorArgs(raw: string): ParsedAdvisorArgs {
  let rest = raw.trimStart();
  let quick = false;
  const files: string[] = [];
  for (;;) {
    if (rest.startsWith("-- ") || rest === "--") {
      rest = rest.slice(2).trimStart();
      break;
    }
    if (/^--quick(\s|$)/.test(rest)) {
      quick = true;
      rest = rest.slice("--quick".length).trimStart();
      continue;
    }
    const file = /^--file(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))(\s|$)/.exec(rest);
    if (file) {
      files.push((file[1] ?? file[2] ?? file[3] ?? "").trim());
      rest = rest.slice(file[0].length).trimStart();
      continue;
    }
    if (/^--file(\s*)$/.test(rest)) return { ok: false, error: "--file needs a project-relative path." };
    const unknown = /^(--?[A-Za-z][\w-]*)/.exec(rest);
    if (unknown) return { ok: false, error: `Unknown option ${unknown[1]}. Use -- before a question that starts with a dash.` };
    break;
  }
  const question = rest.trim();
  if (quick && files.length) return { ok: false, error: "--quick cannot be combined with --file: quick mode uses no source tools and will not read files." };
  if (files.some((f) => !f)) return { ok: false, error: "--file needs a non-empty path." };
  if (!question) return { ok: false, error: "Usage: /wai-advisor [--quick] [--file \"path\"]... [--] <question>" };
  return { ok: true, question, quick, files };
}
