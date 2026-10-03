import { defineConfig } from "vitest/config";

// The end-to-end tests: real processes against the built server (`npm run test:e2e`).
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
