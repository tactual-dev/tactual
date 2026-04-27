import { describe, expect, it } from "vitest";
import { runValidateUrl, ValidateUrlError } from "./validate-url.js";

describe("runValidateUrl", () => {
  it("rejects unsafe URLs before loading optional validation dependencies", async () => {
    await expect(runValidateUrl({ url: "javascript:alert(1)" })).rejects.toMatchObject({
      code: "invalid-url",
      name: "ValidateUrlError",
    } satisfies Partial<ValidateUrlError>);
  });

  it("rejects unknown profiles before launching a browser", async () => {
    await expect(
      runValidateUrl({ url: "https://example.test", profileId: "unknown-profile" }),
    ).rejects.toMatchObject({
      code: "unknown-profile",
      name: "ValidateUrlError",
    } satisfies Partial<ValidateUrlError>);
  });
});
