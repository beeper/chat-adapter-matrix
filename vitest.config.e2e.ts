import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
