import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/evidence/redact.ts";

describe("redaction (defense in depth)", () => {
  it("redacts config values but keeps line structure and references", () => {
    const input = "spring:\n  datasource:\n    password: hunter2-prod-secret\n    username: app\n    token: ${API_TOKEN}\n";
    const { text, redactions } = redactSecrets(input, "src/main/resources/application.yml");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("${API_TOKEN}");
    expect(text.split("\n")).toHaveLength(input.split("\n").length);
    expect(redactions).toBe(1);
  });

  it("redacts quoted literals in code but not code references", () => {
    const { text } = redactSecrets(`const apiKey = "abcd1234efgh";\nval token = account.token\n`, "src/a.ts");
    expect(text).toContain('apiKey = "[REDACTED]"');
    expect(text).toContain("val token = account.token");
  });

  it("redacts well-known token shapes and URL credentials", () => {
    const { text } = redactSecrets("AKIAABCDEFGHIJKLMNOP ghp_abcdefghijklmnopqrstuvwxyz0123456789 postgres://u:pa55word@db/x -----BEGIN RSA PRIVATE KEY-----");
    expect(text).not.toMatch(/AKIA[A-Z]/);
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("pa55word");
    expect(text).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("is deterministic", () => {
    const a = redactSecrets("password: x1y2z3w4", "a.properties");
    const b = redactSecrets("password: x1y2z3w4", "a.properties");
    expect(a).toEqual(b);
  });
});
