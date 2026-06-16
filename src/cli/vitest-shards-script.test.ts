import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { resolve } from "path";

const script = resolve(__dirname, "../../scripts/vitest-shards.mjs");

describe("Vitest shard runner script", () => {
  it("prints the shard list when run directly", () => {
    const stdout = execFileSync(process.execPath, [script, "--list"], {
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });

    expect(stdout).toContain("core\tCore graph/scoring/profile/report/calibration tests");
    expect(stdout).toContain("capture\tCapture, iframe descent, and CDP AX serializer tests");
    expect(stdout).toContain("pipeline\tPipeline, MCP, CLI, validation, benchmark, and integration tests");
  });

  it("fails unknown shard names", () => {
    const result = spawnSync(process.execPath, [script, "not-a-shard"], {
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown Vitest shard: not-a-shard");
  });
});
