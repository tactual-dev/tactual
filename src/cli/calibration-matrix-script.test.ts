import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { resolve } from "path";

const script = resolve(__dirname, "../../scripts/calibration-matrix.mjs");

describe("calibration matrix script", () => {
  it("shows help without requiring built output", () => {
    const stdout = execFileSync(process.execPath, [script, "--help"], {
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    expect(stdout).toContain("Calibration matrix reporter");
    expect(stdout).toContain("calibration-matrix.mjs");
    expect(stdout).toContain("npm run build");
    expect(stdout).toContain("sequence plans drifted");
  });

  it("is valid JavaScript", () => {
    execFileSync(process.execPath, ["--check", script], {
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
  });
});
