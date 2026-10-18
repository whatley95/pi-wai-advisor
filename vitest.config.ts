import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Pi's grep/find use local rg/fd; never download anything during tests.
    env: { PI_OFFLINE: "1" },
  },
});
