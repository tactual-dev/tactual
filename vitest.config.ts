import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    // Default 5 caps describe.concurrent batches. Explorer has 12 concurrent
    // tests; lifting this lets them all run at once instead of in two waves.
    maxConcurrency: 16,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
