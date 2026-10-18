/**
 * Language-neutral initial discovery: explicit seeds, path-like mentions, a build
 * manifest listing and a literal identifier search. No AST/TS index is required;
 * the initial set is a seed, not a ceiling or a coverage claim. Discovery requests
 * consume the same evidence allowance as model-requested evidence.
 */
import type { BrokerRequest } from "./broker.ts";
import { checkPolicyPath } from "./path-policy.ts";

/** Build/module manifests across ecosystems (fd glob with braces). */
export const MANIFEST_PATTERN =
  "{pom.xml,build.gradle,build.gradle.kts,settings.gradle,settings.gradle.kts,libs.versions.toml,gradle.properties,package.json,angular.json,pubspec.yaml,pyproject.toml,setup.py,setup.cfg,requirements.txt,Pipfile,go.mod,Cargo.toml,*.csproj,*.sln,Gemfile,composer.json,AndroidManifest.xml,openapi.yaml,openapi.yml,openapi.json,swagger.yaml,swagger.json,application.yml,application.yaml,application.properties}";

const STOPWORDS = new Set(
  "about above after again against also because before being below between both cannot could does doing down during each from further have having here into itself just more most other over same should some such than that their theirs them then there these they this those through under until very what when where which while whom with would your yours why how the and for are but not you all any can had her was one our out his has its who did get got may use used using show shows shown screen data value values make makes made call calls called fix bug issue error errors problem problems code file files line lines thing things like want need still even only into onto".split(
    " ",
  ),
);

export interface DiscoveryPlan {
  seedReads: BrokerRequest[];
  manifestListing: BrokerRequest | null;
  searches: BrokerRequest[];
  rejectedSeeds: Array<{ path: string; reason: string }>;
}

/** Identifier-like tokens, most specific first. */
export function extractSearchTerms(text: string, max = 3): string[] {
  const found = new Map<string, number>();
  const add = (term: string, score: number) => {
    const t = term.trim();
    if (t.length < 3 || t.length > 80) return;
    if (STOPWORDS.has(t.toLowerCase())) return;
    found.set(t, Math.max(found.get(t) ?? 0, score));
  };
  for (const m of text.matchAll(/[`"']([^`"'\n]{3,60})[`"']/g)) add(m[1] as string, 6);
  for (const m of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/g)) {
    if (!/\.(kt|java|ts|tsx|js|jsx|dart|py|go|rs|cs|swift|xml|yml|yaml|json|sql|gradle|kts|properties)$/i.test(m[0])) add(m[0].split(".").pop() as string, 4);
  }
  for (const m of text.matchAll(/\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g)) add(m[0], 5); // camelCase / PascalCase
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g)) add(m[0], 5); // snake_case
  for (const m of text.matchAll(/(?:^|\s)(\/[a-z0-9_{}\-/]{3,60})/gi)) add(m[1] as string, 4); // route-like
  for (const m of text.matchAll(/\b[A-Za-z]{5,}\b/g)) add(m[0], m[0].length >= 8 ? 2 : 1);
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([term]) => term)
    .slice(0, max);
}

/** Project-relative file paths mentioned in free text (validated by policy). */
export function extractPathMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s(`"'])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,10})(?=$|[\s)`"',:;])/g)) out.add(m[1] as string);
  return [...out].slice(0, 6);
}

export function planDiscovery(input: {
  question: string;
  constraints: readonly string[];
  seedPaths: readonly string[];
  /** Evidence requests discovery may use (after reserving model/recheck capacity). */
  allowance: number;
  canList: boolean;
  canSearch: boolean;
  canRead: boolean;
  initialReadLines: number;
}): DiscoveryPlan {
  const plan: DiscoveryPlan = { seedReads: [], manifestListing: null, searches: [], rejectedSeeds: [] };
  let left = Math.max(0, input.allowance);
  const seeds = [...input.seedPaths, ...extractPathMentions(input.question)];
  const seen = new Set<string>();
  for (const raw of seeds) {
    const check = checkPolicyPath(raw);
    if (!check.ok) {
      plan.rejectedSeeds.push({ path: raw.slice(0, 200), reason: check.message });
      continue;
    }
    if (seen.has(check.path)) continue;
    seen.add(check.path);
    if (!input.canRead || left <= 0) {
      plan.rejectedSeeds.push({ path: check.path, reason: input.canRead ? "No evidence allowance left for the initial read." : "read_file is not available." });
      continue;
    }
    plan.seedReads.push({ tool: "read_file", path: check.path, startLine: 1, endLine: input.initialReadLines });
    left--;
  }
  // With explicit seeds, let the model ask for more; otherwise do minimal discovery.
  if (plan.seedReads.length === 0) {
    if (input.canList && left > 1) {
      plan.manifestListing = { tool: "list_files", path: "", pattern: MANIFEST_PATTERN };
      left--;
    }
    if (input.canSearch && left > 0) {
      const terms = extractSearchTerms(`${input.question}\n${input.constraints.join("\n")}`, 1);
      for (const term of terms) plan.searches.push({ tool: "search_code", query: term, literal: true });
    }
  }
  return plan;
}
