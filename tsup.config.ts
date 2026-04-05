import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cli/index": "src/cli/index.ts",
    "playwright/index": "src/playwright/index.ts",
    "mcp/index": "src/mcp/index.ts",
    "mcp/cli": "src/mcp/cli.ts",
    "validation/index": "src/validation/index.ts",
    "calibration/index": "src/calibration/index.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  splitting: true,
  external: ["playwright", "@modelcontextprotocol/sdk", "@guidepup/virtual-screen-reader"],
});
