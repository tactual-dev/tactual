import { defineConfig } from "vitest/config";
import { resolve } from "path";

// Vitest's default forks pool can spin up many browser-heavy files at once.
// Keep the release suite to one worker so Chromium startup/teardown does not
// starve page-capture tests on high-core Windows machines.
const MAX_FORKS = 1;

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    // Browser-heavy describe.concurrent suites should run in small waves.
    maxConcurrency: 2,
    maxWorkers: MAX_FORKS,
    // Browser-test load is uneven; some tests cold-start a Chromium per test.
    // 60 s default absorbs browser-worker startup contention in the release
    // suite without masking true hangs in the bounded Playwright operations.
    testTimeout: 60000,
    // Chromium cold-start can exceed Vitest's 10 s hook default when another
    // browser-heavy worker is active, especially on Windows release runs.
    hookTimeout: 60000,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
