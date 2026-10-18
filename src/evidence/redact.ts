/**
 * Content redaction: defense in depth only. Path policy is the primary control;
 * pattern-based detection cannot find every secret, and the docs say so.
 *
 * Redaction is line-preserving (values are replaced in place) so line numbers stay
 * valid, and deterministic so freshness rechecks hash identically.
 */

const MARK = "[REDACTED]";

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$(?![\s\S]))/g;
const BASE64_LINE = /^([ \t]*)[A-Za-z0-9+/]{60,}={0,2}[ \t\r]*$/gm;

const TOKEN_PATTERNS: RegExp[] = [
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

/** scheme://user:password@host  ->  scheme://user:[REDACTED]@host */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:)([^\s@'"]+)(@)/gi;

const SECRET_KEY = String.raw`(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|credentials?|signing[_-]?key|encryption[_-]?key)`;

/** key = "literal" / key: 'literal' (any file type). */
const QUOTED_ASSIGNMENT = new RegExp(String.raw`(${SECRET_KEY}[\w.-]*["']?\s*[:=]\s*)(["'])([^"'\n]{4,})\2`, "gi");

/** key=value / key: value in configuration-style files (unquoted). */
const CONFIG_ASSIGNMENT = new RegExp(String.raw`^(\s*[\w.-]*${SECRET_KEY}[\w.-]*\s*[:=]\s*)([^\s#'"][^#\n]*)$`, "gim");

const CONFIG_EXTENSIONS = /\.(ya?ml|properties|ini|conf|cfg|toml|env|xml|json|gradle|kts)$/i;

function isReference(value: string): boolean {
  const v = value.trim();
  // Environment/placeholder references are informative and not secrets themselves.
  return /^\$\{[^}]+\}$/.test(v) || /^\$[A-Z_][A-Z0-9_]*$/.test(v) || /^%[A-Z_]+%$/.test(v) || /^<[^>]+>$/.test(v) || /^(true|false|null|none|changeme|\*+)$/i.test(v);
}

export function redactSecrets(text: string, path?: string): { text: string; redactions: number } {
  let redactions = 0;
  // Whole private-key blocks (header, base64 body, footer), line-preserving.
  let out = text.replace(PRIVATE_KEY_BLOCK, (block) => {
    redactions++;
    return block
      .split("\n")
      .map(() => MARK)
      .join("\n");
  });
  // Long base64-only lines (e.g. a key body read without its header).
  out = out.replace(BASE64_LINE, (_m, lead: string) => {
    redactions++;
    return `${lead}${MARK}`;
  });
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, () => {
      redactions++;
      return MARK;
    });
  }
  out = out.replace(URL_CREDENTIALS, (_m, head: string, _pw: string, at: string) => {
    redactions++;
    return `${head}${MARK}${at}`;
  });
  out = out.replace(QUOTED_ASSIGNMENT, (match, head: string, quote: string, value: string) => {
    if (isReference(value) || value === MARK) return match;
    redactions++;
    return `${head}${quote}${MARK}${quote}`;
  });
  if (path && CONFIG_EXTENSIONS.test(path)) {
    out = out.replace(CONFIG_ASSIGNMENT, (match, head: string, value: string) => {
      if (isReference(value) || value.trim() === MARK || value.trim().startsWith("[REDACTED]")) return match;
      redactions++;
      return `${head}${MARK}`;
    });
  }
  return { text: out, redactions };
}
