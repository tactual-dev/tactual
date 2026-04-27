import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { runSaveAuth, SaveAuthError, stepsFromCliFlags } from "./save-auth.js";

describe("runSaveAuth", () => {
  it("rejects malformed steps before launching a browser", async () => {
    await expect(
      runSaveAuth({
        url: "https://example.test/login",
        steps: [{ fill: ["#email"] } as unknown as Record<string, unknown>],
      }),
    ).rejects.toMatchObject({
      code: "invalid-step",
      name: "SaveAuthError",
    } satisfies Partial<SaveAuthError>);
  });

  it("rejects restricted output paths outside the current working directory", async () => {
    await expect(
      runSaveAuth({
        url: "https://example.test/login",
        steps: [],
        outputPath: resolve("..", "tactual-auth.json"),
        restrictOutputToCwd: true,
      }),
    ).rejects.toMatchObject({
      code: "invalid-output-path",
      name: "SaveAuthError",
    } satisfies Partial<SaveAuthError>);
  });
});

describe("stepsFromCliFlags", () => {
  it("preserves CLI step order as fills, click, then waitForUrl", () => {
    expect(
      stepsFromCliFlags({
        fill: ["#email=user@example.test", "#password=s3cr3t"],
        click: "Sign in",
        waitForUrl: "/dashboard",
      }),
    ).toEqual([
      { fill: ["#email", "user@example.test"] },
      { fill: ["#password", "s3cr3t"] },
      { click: "Sign in" },
      { waitForUrl: "/dashboard" },
    ]);
  });
});
