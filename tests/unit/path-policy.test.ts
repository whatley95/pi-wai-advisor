import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalRoot, checkContainment, checkPolicyPath, classifyPath, normalizeRelativePath } from "../../src/evidence/path-policy.ts";
import { tempDir } from "../helpers/harness.ts";

describe("lexical path validation", () => {
  it.each([
    ["../secret.txt", "traversal"],
    ["src/../../x", "traversal"],
    ["src\\..\\..\\x", "traversal"],
    ["/etc/passwd", "absolute_path"],
    ["C:\\Windows\\win.ini", "absolute_path"],
    ["c:relative", "absolute_path"],
    ["\\\\server\\share\\x", "absolute_path"],
    ["//server/share/x", "absolute_path"],
    ["\\\\?\\C:\\x", "device_path"],
    ["\\\\.\\PhysicalDrive0", "device_path"],
    ["src/file.ts:Zone.Identifier", "alternate_stream"],
    ["src/file.ts::$DATA", "alternate_stream"],
    ["src/CON", "device_path"],
    ["nul.txt", "device_path"],
    ["COM1.log", "device_path"],
    ["src/trailing.", "invalid_path"],
    ["src/trailing ", "invalid_path"],
    ["~/x", "absolute_path"],
    ["src/\u0000x", "invalid_path"],
    ["src/*.ts", "invalid_path"],
  ])("rejects %s (%s)", (input, code) => {
    const result = normalizeRelativePath(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code);
  });

  it("normalizes separators and dot segments", () => {
    expect(normalizeRelativePath("./src\\a/./b.ts")).toEqual({ ok: true, path: "src/a/b.ts" });
    expect(normalizeRelativePath(".", true)).toEqual({ ok: true, path: "" });
    expect(normalizeRelativePath(".").ok).toBe(false);
  });
});

describe("sensitive/generated policy", () => {
  it.each([
    ".env",
    ".ENV",
    "backend/.env.production",
    "config/prod.env",
    "keys/server.PEM",
    "home/id_ed25519",
    ".npmrc",
    "android/local.properties",
    "app/google-services.json",
    "deploy/terraform.tfstate",
    "creds/credentials.json",
    "config/secrets.yml",
    ".git/config",
    ".GIT/HEAD",
    ".svn/entries",
    "node_modules/x/index.js",
    "web/dist/app.js",
    "build/out.txt",
    ".pi/pi-wai-advisor/requests/x/result.json",
    ".pi/settings.json",
    ".ssh/config",
    "img/logo.png",
    "lib/app.jar",
  ])("denies %s", (path) => {
    expect(checkPolicyPath(path).ok).toBe(false);
  });

  it.each(["src/Secret.kt", "src/secrets.ts", "backend/src/main/resources/application.yml", "package.json", "pubspec.yaml", "app/build.gradle.kts", "src/env.ts", "docs/build-notes.md"])(
    "allows %s",
    (path) => {
      expect(classifyPath(path)).toBeNull();
    },
  );
});

describe("containment (metadata only)", () => {
  it("allows missing files under the root and contained files", () => {
    const root = tempDir();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "x");
    const r = canonicalRoot(root);
    expect(checkContainment(r, "src/a.ts").ok).toBe(true);
    expect(checkContainment(r, "src/missing/deeper.ts").ok).toBe(true);
  });

  it("rejects directory links (junctions/symlinks) that escape the root", () => {
    const root = tempDir();
    const outside = tempDir("wai-outside-");
    writeFileSync(join(outside, "loot.txt"), "secret");
    symlinkSync(outside, join(root, "escape"), "junction");
    const result = checkContainment(canonicalRoot(root), "escape/loot.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("outside_root");
  });

  it("rejects a contained link whose target is a sensitive path", () => {
    const root = tempDir();
    mkdirSync(join(root, ".ssh"));
    writeFileSync(join(root, ".ssh", "id_rsa"), "key");
    symlinkSync(join(root, ".ssh"), join(root, "innocent"), "junction");
    const result = checkContainment(canonicalRoot(root), "innocent/id_rsa");
    expect(result.ok).toBe(false);
  });

  it("fails closed on broken links (file symlinks may need privileges on Windows)", (ctx) => {
    const root = tempDir();
    try {
      symlinkSync(join(root, "does-not-exist"), join(root, "broken.ts"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return ctx.skip();
      throw error;
    }
    const result = checkContainment(canonicalRoot(root), "broken.ts");
    expect(result.ok).toBe(false);
  });
});
