/**
 * Bounded investigation guidance (FULL_STACK_PROFILE). Only the sections relevant to
 * the question and detected manifests are included, inside the same context budget.
 * Stack labels come from evidence (manifest file names), never from role labels.
 */

interface ProfileSection {
  id: string;
  /** Question keywords that select this section. */
  keywords: RegExp;
  /** Manifest file names that select this section. */
  manifests?: RegExp;
  text: string;
}

const SECTIONS: ProfileSection[] = [
  {
    id: "jvm",
    keywords: /\b(java|spring|boot|jvm|maven|gradle|kotlin|bean|controller|service|@\w+mapping|webflux|jpa|hibernate)\b/i,
    manifests: /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|libs\.versions\.toml)$/i,
    text: "JVM/Spring: identify the containing Maven/Gradle module of the code in question (an aggregator or sibling module is not automatically the owner). Separate declared versions from resolved ones; without a dependency-resolution result, inherited/runtime versions stay unknown. Do not assume Spring Boot, JPA, MVC vs WebFlux, a security library or a Java release from file names alone. Follow the real component boundaries rather than expecting controller/service folders.",
  },
  {
    id: "api",
    keywords: /\b(api|dto|endpoint|route|payload|request|response|json|serializ|deserializ|mapping|field|status|openapi|swagger|rest|http)\b/i,
    manifests: /(^|\/)(openapi|swagger)\.(ya?ml|json)$/i,
    text: "API contract: compare both sides for route/method/base path, body/query/path binding, field names and nesting, optional/null handling, enums, date/time and timezone, numeric precision/ids/money, paging/sorting, error status/shape and auth/session transport. Checked-in OpenAPI files and generated clients may be stale; compare with endpoint/DTO/client source. Cite both sides of a mismatch.",
  },
  {
    id: "security",
    keywords: /\b(auth|authori[sz]|authenticat|tenant|account|permission|role|csrf|cors|token|session|login|logout|security|access)\b/i,
    text: "Security: verify whether the actual call path enforces the intended boundary (authentication, authorization, account/tenant filters). An annotation or naming convention alone is not proof. Never recommend disabling authentication, CSRF or other controls just to make a request succeed.",
  },
  {
    id: "persistence",
    keywords: /\b(repository|query|sql|database|db|entity|table|migration|flyway|liquibase|transaction|jpa|orm|schema|paging|pagination)\b/i,
    text: "Persistence: inspect repository predicates, paging/order, entity/migration source and transaction boundaries where implicated. Source cannot establish production rows, applied migrations, query plans or effective runtime settings; mark them unknown. Checked-in configuration does not establish deployed values.",
  },
  {
    id: "web",
    keywords: /\b(react|next|vue|angular|svelte|frontend|component|form|hook|state|redux|fetch|axios|browser|typescript|javascript)\b/i,
    manifests: /(^|\/)(package\.json|angular\.json)$/i,
    text: "Web frontend: determine whether code is client-side, server-side or shared before reasoning about browser APIs, auth state or configuration. Trace the API client payload and how responses/errors update state.",
  },
  {
    id: "mobile",
    keywords: /\b(android|kotlin|flutter|dart|ios|swift|mobile|activity|fragment|viewmodel|compose|widget|bloc|provider|riverpod|lifecycle)\b/i,
    manifests: /(^|\/)(pubspec\.yaml|AndroidManifest\.xml)$/i,
    text: "Mobile: inspect the containing module/pubspec and the API client, cache/session and state code. Check lifecycle and account-change paths (logout/login, process death) when data leakage or staleness is suspected.",
  },
  {
    id: "tests",
    keywords: /\b(test|tests|junit|spec|coverage|regression|verify|verification|mock)\b/i,
    text: "Tests: reading test source is not running it. Separate tests inspected, caller-supplied execution results, tests suggested but not executed, and runtime behavior still unverified. Match suggestions to the project's actual test dependencies.",
  },
];

export function selectProfileGuidance(question: string, manifestPaths: readonly string[], maxChars = 1800): { ids: string[]; text: string } {
  const picked = SECTIONS.filter(
    (section) => section.keywords.test(question) || (section.manifests ? manifestPaths.some((p) => section.manifests?.test(p)) : false),
  );
  const ids: string[] = [];
  const parts: string[] = [];
  let size = 0;
  for (const section of picked) {
    if (size + section.text.length > maxChars) break;
    ids.push(section.id);
    parts.push(`- ${section.text}`);
    size += section.text.length;
  }
  return { ids, text: parts.join("\n") };
}
