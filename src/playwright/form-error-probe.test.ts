import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { probeFormErrorFlows, type FormErrorProbeResults } from "./form-error-probe.js";
import type { Target } from "../core/types.js";

function field(): Target {
  return {
    id: "email",
    kind: "formField",
    role: "textbox",
    name: "Email",
    requiresBranchOpen: false,
  };
}

describe("probeFormErrorFlows", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("detects associated validation messages and focus movement", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <form>
        <label>Email <input aria-label="Email" required aria-describedby="email-error"></label>
        <div id="email-error">Email is required</div>
        <div role="alert">Fix the errors</div>
      </form>
    `);

    const [result] = await probeFormErrorFlows(page, [field()]);
    const probe = (result as Record<string, unknown>)._formErrorProbe as FormErrorProbeResults;
    expect(probe.probeSucceeded).toBe(true);
    expect(probe.invalidStateExposed).toBe(true);
    expect(probe.errorMessageAssociated).toBe(true);
    expect(probe.focusMovedToInvalidField).toBe(true);
    expect(probe.liveErrorRegionPresent).toBe(true);
    await page.close();
  }, 15_000);

  it("measures visible custom invalid fields without native validity", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <form>
        <div
          role="textbox"
          aria-label="Custom field"
          aria-invalid="true"
          tabindex="0"
          style="display:block; width: 240px; min-height: 24px; border: 1px solid #999;"
        ></div>
      </form>
    `);

    const [result] = await probeFormErrorFlows(page, [
      {
        id: "custom",
        kind: "formField",
        role: "textbox",
        name: "Custom field",
        requiresBranchOpen: false,
      },
    ]);
    const probe = (result as Record<string, unknown>)._formErrorProbe as FormErrorProbeResults;
    expect(probe.probeSucceeded).toBe(true);
    expect(probe.invalidStateExposed).toBe(true);
    expect(probe.errorMessageAssociated).toBe(false);
    expect(probe.focusMovedToInvalidField).toBe(false);
    expect(probe.liveErrorRegionPresent).toBe(false);
    await page.close();
  }, 15_000);
});
