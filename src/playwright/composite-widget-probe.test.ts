import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  probeComboListboxContracts,
  type ComboboxProbeResults,
  type ListboxProbeResults,
} from "./composite-widget-probe.js";
import type { Target } from "../core/types.js";

function target(overrides: Partial<Target>): Target {
  return {
    id: "t",
    kind: "formField",
    role: "combobox",
    name: "Target",
    requiresBranchOpen: false,
    ...overrides,
  };
}

describe("probeComboListboxContracts", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("measures combobox popup, active option, and Escape contract", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <input role="combobox" aria-label="City" aria-expanded="false" aria-controls="cities" aria-activedescendant="">
      <div role="listbox" id="cities" hidden>
        <div role="option" id="city-a">Austin</div>
      </div>
      <script>
        const combo = document.querySelector('[role="combobox"]');
        const list = document.getElementById('cities');
        combo.addEventListener('keydown', (event) => {
          if (event.key === 'ArrowDown') {
            combo.setAttribute('aria-expanded', 'true');
            combo.setAttribute('aria-activedescendant', 'city-a');
            list.hidden = false;
          }
          if (event.key === 'Escape') {
            combo.setAttribute('aria-expanded', 'false');
            list.hidden = true;
          }
        });
      </script>
    `);

    const [result] = await probeComboListboxContracts(page, [
      target({ id: "city", role: "combobox", name: "City" }),
    ]);
    const probe = (result as Record<string, unknown>)._comboboxProbe as ComboboxProbeResults;
    expect(probe.probeSucceeded).toBe(true);
    expect(probe.opensWithArrowDown).toBe(true);
    expect(probe.exposesActiveOption).toBe(true);
    expect(probe.escapeCloses).toBe(true);
    await page.close();
  }, 15_000);

  it("detects listbox arrow movement failures", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="listbox" aria-label="Plan" tabindex="0">
        <div role="option">Free</div>
        <div role="option">Pro</div>
      </div>
    `);

    const [result] = await probeComboListboxContracts(page, [
      target({ id: "plans", role: "listbox", name: "Plan" }),
    ]);
    const probe = (result as Record<string, unknown>)._listboxProbe as ListboxProbeResults;
    expect(probe.probeSucceeded).toBe(true);
    expect(probe.arrowDownMovesOption).toBe(false);
    expect(probe.exposesSelectedOption).toBe(false);
    await page.close();
  }, 15_000);

  it("does not run custom APG combobox checks against native selects", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <label for="country">Country</label>
      <select id="country">
        <option>Canada</option>
        <option>United States</option>
      </select>
    `);

    const [result] = await probeComboListboxContracts(page, [
      target({
        id: "country",
        role: "combobox",
        name: "Country",
        _nativeHtmlControl: "select",
      } as Partial<Target>),
    ]);
    expect((result as Record<string, unknown>)._comboboxProbe).toBeUndefined();
    await page.close();
  }, 15_000);
});
