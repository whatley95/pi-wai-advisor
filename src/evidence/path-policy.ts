/**
 * Project containment and sensitive-path policy.
 *
 * Applied to discovery, search hits, listings, seed paths and reads, not only the
 * final read. Path checks use filesystem *metadata* (lstat/realpath) to verify
 * containment through symlinks/junctions; they never read file contents.
 *
 * Path races (a path swapped between check and host access) are mitigated by
 * re-checking after access, not eliminated: this is not OS-level isolation.
 */
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const POLICY_VERSION = "wai-advisor-path-policy/1";

export type PathDenialCode =
  | "invalid_path"
  | "absolute_path"
  | "traversal"
  | "device_path"
  | "alternate_stream"
  | "sensitive_path"
  | "generated_path"
  | "vcs_internal"
  | "private_runtime"
  | "binary_file"
  | "outside_root"
  | "broken_link";

export type PathCheck = { ok: true; path: string } | { ok: false; code: PathDenialCode; message: string };

const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** VCS internals. */
const VCS_DIRS = new Set([".git", ".svn", ".hg", ".bzr", "_darcs", ".jj"]);

/** Generated, vendored or dependency output. */
const GENERATED_DIRS = new Set([
  "node_modules",
  "bower_components",
  "jspm_packages",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".gradle",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".angular",
  ".turbo",
  ".parcel-cache",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".venv",
  "venv",
  ".dart_tool",
  ".pub-cache",
  ".fvm",
  "pods",
  ".terraform",
  "vendor",
  ".idea",
  ".vs",
  ".vscode-test",
  "deriveddata",
]);

/** Generated-directory names that are also common real source package/module names. */
const AMBIGUOUS_GENERATED = new Set(["build", "out", "target", "dist", "vendor", "pods", "coverage"]);

/** Credential and key stores (directory segments). */
const SENSITIVE_DIRS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".secrets", ".password-store", ".gcloud"]);

const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/i, // .env, .env.local, .env.production, .env.example ...
  /^.*\.env$/i, // prod.env
  /^\.envrc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|truststore|p8|ppk|asc|gpg|pgp|kdbx|der|crt|cer|csr)$/i,
  /^\.(npmrc|yarnrc|yarnrc\.yml|pypirc|netrc|pgpass|git-credentials|dockercfg|htpasswd|s3cfg|boto)$/i,
  /^_netrc$/i,
  /^(credentials|credential)(\.(json|ya?ml|xml|ini|txt|properties))?$/i,
  /^secrets?(\.(json|ya?ml|toml|ini|env|txt|properties|xml|conf|cfg))?$/i,
  /\.secrets?$/i,
  /^auth\.json$/i,
  /^service[-_]?account.*\.json$/i,
  /^google-services\.json$/i,
  /^googleservice-info\.plist$/i,
  /^local\.properties$/i,
  /^keystore\.properties$/i,
  /^signing\.properties$/i,
  /\.tfstate(\.backup)?$/i,
  /\.tfvars$/i,
  /^kubeconfig$/i,
  /^\.?vault[-_]?token$/i,
  /^master\.key$/i,
  /\.(sqlite|sqlite3|db)$/i,
];

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "tif", "tiff", "psd", "pdf",
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "jar", "war", "ear", "aar", "apk", "aab", "ipa",
  "class", "dex", "so", "dll", "exe", "dylib", "o", "a", "lib", "obj", "pdb", "pyc", "pyo", "wasm", "node",
  "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "m4a", "wav", "ogg", "mov", "avi", "mkv", "webm", "bin",
  "tsbuildinfo",
]);

/**
 * Lexically validate a caller/model-supplied project-relative path and return its
 * normalized POSIX form. `allowRoot` accepts "" / "." for list/search scopes.
 */
export function normalizeRelativePath(input: unknown, allowRoot = false): PathCheck {
  if (typeof input !== "string") return { ok: false, code: "invalid_path", message: "Path must be a string." };
  const raw = input;
  if (!raw.trim()) return allowRoot ? { ok: true, path: "" } : { ok: false, code: "invalid_path", message: "A file path is required." };
  if (raw.length > 512) return { ok: false, code: "invalid_path", message: "Path is too long." };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, code: "invalid_path", message: "Path contains control characters." };
  if (/^(\\\\|\/\/)[.?]([\\/]|$)/.test(raw)) return { ok: false, code: "device_path", message: "Device namespace paths are not allowed." };
  if (/^(\\\\|\/\/)/.test(raw)) return { ok: false, code: "absolute_path", message: "UNC/network paths are not allowed." };
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith("/") || raw.startsWith("\\") || isAbsolute(raw))
    return { ok: false, code: "absolute_path", message: "Absolute paths are not allowed; use a project-relative path." };
  if (raw.startsWith("~")) return { ok: false, code: "absolute_path", message: "Home-relative paths are not allowed." };
  if (raw.includes(":")) return { ok: false, code: "alternate_stream", message: "':' is not allowed (alternate data streams/drive specifiers)." };
  if (/[*?"<>|]/.test(raw)) return { ok: false, code: "invalid_path", message: "Wildcard or reserved characters are not allowed in a path." };

  const segments = raw.replaceAll("\\", "/").split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return { ok: false, code: "traversal", message: "Parent-directory traversal is not allowed." };
    if (/[. ]$/.test(segment))
      return { ok: false, code: "invalid_path", message: "Path segments ending in '.' or ' ' are not allowed (Windows normalization)." };
    if (WINDOWS_DEVICE_NAMES.test(segment)) return { ok: false, code: "device_path", message: `'${segment}' is a reserved device name.` };
    out.push(segment);
  }
  const path = out.join("/");
  if (!path && !allowRoot) return { ok: false, code: "invalid_path", message: "A file path is required." };
  return { ok: true, path };
}

/** Policy exclusion for an already-normalized relative path (case-insensitive). */
export function classifyPath(path: string): { code: PathDenialCode; message: string } | null {
  if (!path) return null;
  const segments = path.split("/");
  const lower = segments.map((s) => s.toLowerCase());
  if (lower[0] === ".pi") {
    return lower[1] === "pi-wai-advisor"
      ? { code: "private_runtime", message: "The advisor's own runtime directory is excluded." }
      : { code: "private_runtime", message: "Pi/extension runtime state under .pi is excluded." };
  }
  for (const segment of lower) {
    if (VCS_DIRS.has(segment)) return { code: "vcs_internal", message: "VCS internals are excluded." };
    if (SENSITIVE_DIRS.has(segment)) return { code: "sensitive_path", message: "Credential/key store directories are excluded." };
  }
  const srcIndex = lower.indexOf("src");
  for (const [index, segment] of lower.slice(0, -1).entries()) {
    // Ambiguous names (a Java package "build", a module "target") are source under a src/ tree.
    if (AMBIGUOUS_GENERATED.has(segment) && srcIndex !== -1 && srcIndex < index) continue;
    if (GENERATED_DIRS.has(segment)) return { code: "generated_path", message: "Generated/vendor output is excluded." };
  }
  const base = segments[segments.length - 1] ?? "";
  const baseIsAmbiguousUnderSrc = AMBIGUOUS_GENERATED.has(base.toLowerCase()) && srcIndex !== -1 && srcIndex < segments.length - 1;
  if (GENERATED_DIRS.has(base.toLowerCase()) && segments.length > 0 && !baseIsAmbiguousUnderSrc) {
    // A generated directory itself (as a list/search scope).
    return { code: "generated_path", message: "Generated/vendor output is excluded." };
  }
  if (SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(base))) return { code: "sensitive_path", message: "Sensitive file (credentials/keys/secrets) is excluded." };
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
  if (BINARY_EXTENSIONS.has(ext)) return { code: "binary_file", message: "Binary file types are excluded." };
  return null;
}

/** Combined lexical validation + policy classification. */
export function checkPolicyPath(input: unknown, allowRoot = false): PathCheck {
  const normalized = normalizeRelativePath(input, allowRoot);
  if (!normalized.ok) return normalized;
  const denied = classifyPath(normalized.path);
  if (denied) return { ok: false, ...denied };
  return normalized;
}

export interface ProjectRoot {
  /** Lexically resolved root (the Pi cwd). */
  lexical: string;
  /** Canonical root through symlinks/junctions. */
  real: string;
}

export function canonicalRoot(cwd: string): ProjectRoot {
  const lexical = resolve(cwd);
  return { lexical, real: realpathSync.native(lexical) };
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function sameCase(a: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? a.toLowerCase() : a;
}

/**
 * Metadata-only containment check: the path and every existing ancestor must resolve
 * inside the canonical root. Broken links fail closed. Missing targets are allowed
 * (the host tool will report them) provided their existing ancestors are contained.
 */
export function checkContainment(root: ProjectRoot, path: string): PathCheck {
  const target = resolve(root.lexical, path);
  if (!within(sameCase(root.lexical), sameCase(target))) return { ok: false, code: "outside_root", message: "Path escapes the project root." };
  let probe = target;
  for (;;) {
    let exists = true;
    try {
      lstatSync(probe);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return { ok: false, code: "outside_root", message: `Cannot verify containment (${code}).` };
      exists = false;
    }
    if (exists) {
      let real: string;
      try {
        real = realpathSync.native(probe);
      } catch {
        return { ok: false, code: "broken_link", message: "Broken or unresolvable link." };
      }
      if (!within(sameCase(root.real), sameCase(real))) return { ok: false, code: "outside_root", message: "Path resolves outside the project root (symlink/junction)." };
      // Policy also applies to the resolved location (a link named src/a.ts -> .env).
      const realRel = relative(root.real, real).split(sep).join("/");
      const denied = classifyPath(realRel);
      if (denied && probe === target) return { ok: false, ...denied };
      return { ok: true, path };
    }
    if (sameCase(probe) === sameCase(root.lexical)) return { ok: false, code: "outside_root", message: "Project root is missing." };
    const parent = resolve(probe, "..");
    if (parent === probe) return { ok: false, code: "outside_root", message: "Cannot verify containment." };
    probe = parent;
  }
}

/** Glob equivalents of the sensitive-file patterns, for host-side search exclusion. */
const SENSITIVE_FILE_GLOBS = [
  ".env",
  ".env.*",
  "*.env",
  ".envrc",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "*.{pem,key,p12,pfx,jks,keystore,truststore,p8,ppk,asc,gpg,pgp,kdbx,der,crt,cer,csr}",
  ".{npmrc,yarnrc,pypirc,netrc,pgpass,git-credentials,dockercfg,htpasswd,s3cfg,boto}",
  ".yarnrc.yml",
  "_netrc",
  "credential",
  "credentials",
  "credential{s,}.{json,yml,yaml,xml,ini,txt,properties}",
  "secret",
  "secrets",
  "secret{s,}.{json,yml,yaml,toml,ini,env,txt,properties,xml,conf,cfg}",
  "*.secret",
  "*.secrets",
  "auth.json",
  "service{-,_,}account*.json",
  "google-services.json",
  "googleservice-info.plist",
  "local.properties",
  "keystore.properties",
  "signing.properties",
  "*.tfstate",
  "*.tfstate.backup",
  "*.tfvars",
  "kubeconfig",
  "vault{-,_,}token",
  ".vault{-,_,}token",
  "master.key",
  "*.{sqlite,sqlite3,db}",
];

/** Expand `{a,b}` groups so the outer alternation never nests (globset alternates do not nest). */
function expandBraces(glob: string): string[] {
  const match = /\{([^{}]*)\}/.exec(glob);
  if (!match) return [glob];
  const head = glob.slice(0, match.index);
  const tail = glob.slice(match.index + match[0].length);
  return (match[1] as string).split(",").flatMap((option) => expandBraces(`${head}${option}${tail}`));
}

function caseInsensitiveGlob(glob: string): string {
  return glob.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
}

/**
 * A single negated ripgrep glob that keeps the host search from opening VCS internals,
 * generated/vendor output, Pi runtime state, credential stores and sensitive files
 * (case-insensitive, so `.ENV` variants are excluded too). Verified against Pi 1.3.0's
 * grep (ripgrep `--glob`). Hits are still filtered by classifyPath as defense in depth.
 */
export function searchExcludeGlob(): string {
  const dirs = [...VCS_DIRS, ...[...GENERATED_DIRS].filter((d) => !AMBIGUOUS_GENERATED.has(d)), ...SENSITIVE_DIRS, ".pi"].map((d) => `**/${d}/**`);
  const files = SENSITIVE_FILE_GLOBS.map((f) => `**/${f}`);
  const binary = [...BINARY_EXTENSIONS].map((ext) => `**/*.${ext}`);
  const all = [...new Set([...dirs, ...files, ...binary].flatMap(expandBraces))];
  return `!{${all.map(caseInsensitiveGlob).join(",")}}`;
}

export function policyFingerprint(): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: POLICY_VERSION,
        vcs: [...VCS_DIRS],
        gen: [...GENERATED_DIRS],
        dirs: [...SENSITIVE_DIRS],
        files: SENSITIVE_FILE_PATTERNS.map(String),
        bin: [...BINARY_EXTENSIONS],
      }),
    )
    .digest("hex")
    .slice(0, 16);
}
