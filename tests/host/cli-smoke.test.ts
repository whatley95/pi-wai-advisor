/**
 * Spawns the real Pi 1.3.0 CLI (the pinned devDependency, same version as the
 * supported host) with this extension loaded via -e, offline and with a throwaway
 * agent dir. Exercises loading plus command behavior in print and json modes.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { project, tempDir } from "../helpers/harness.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const CLI = resolve(here, "../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const EXTENSION = resolve(here, "../../src/index.ts");

function pi(args: string[]) {
  const cwd = project("kotlin-android");
  const agentDir = tempDir("wai-cli-agent-");
  return spawnSync(process.execPath, [CLI, "--no-extensions", "-e", EXTENSION, ...args], {
    cwd,
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir },
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("real Pi CLI", () => {
  it("print mode: commands run without a main-model call; output on stderr; errors exit non-zero", () => {
    const status = pi(["-p", "/wai-advisor-status"]);
    expect(status.status).toBe(0);
    expect(status.stderr).toMatch(/WAI Advisor status[\s\S]*Model: none selected/);
    expect(status.stdout).toBe("");
    const ask = pi(["-p", "/wai-advisor --quick Map or Record?"]);
    expect(ask.status).toBe(1);
    expect(ask.stderr).toMatch(/No advisor model is selected/);
  });

  it("json mode: command output is an entry_appended event on stdout", () => {
    const res = pi(["--mode", "json", "/wai-advisor-history"]);
    expect(res.status).toBe(0);
    const events = res.stdout.trim().split("\n").map((l) => JSON.parse(l) as { type: string; entry?: { customType?: string; data?: { text?: string } } });
    const output = events.find((e) => e.type === "entry_appended" && e.entry?.customType === "wai-advisor-output");
    expect(output?.entry?.data?.text).toMatch(/No WAI Advisor history/);
  });
});
