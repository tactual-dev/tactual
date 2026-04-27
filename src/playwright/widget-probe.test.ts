import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  probeTabAndDisclosurePatterns,
  type DisclosureProbeResults,
  type TabProbeResults,
} from "./widget-probe.js";
import type { Target } from "../core/types.js";

function target(overrides: Partial<Target>): Target {
  return {
    id: "t",
    kind: "button",
    role: "button",
    name: "Target",
    requiresBranchOpen: false,
    ...overrides,
  };
}

describe("probeTabAndDisclosurePatterns", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("measures APG tab keyboard and panel invariants", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="tablist">
        <button role="tab" id="tab-one" aria-selected="true" aria-controls="panel-one">One</button>
        <button role="tab" id="tab-two" aria-selected="false" aria-controls="panel-two" tabindex="-1">Two</button>
      </div>
      <section role="tabpanel" id="panel-one" aria-labelledby="tab-one">One panel</section>
      <section role="tabpanel" id="panel-two" aria-labelledby="tab-two" hidden>Two panel</section>
      <script>
        const tabs = [...document.querySelectorAll('[role="tab"]')];
        function select(tab) {
          for (const t of tabs) {
            const selected = t === tab;
            t.setAttribute('aria-selected', selected ? 'true' : 'false');
            t.tabIndex = selected ? 0 : -1;
            document.getElementById(t.getAttribute('aria-controls')).hidden = !selected;
          }
        }
        for (const [idx, tab] of tabs.entries()) {
          tab.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowRight') {
              event.preventDefault();
              tabs[(idx + 1) % tabs.length].focus();
            }
            if (event.key === 'Enter') select(tab);
          });
          tab.addEventListener('click', () => select(tab));
        }
      </script>
    `);

    const result = await probeTabAndDisclosurePatterns(page, [
      target({
        id: "tab-one",
        kind: "tab",
        role: "tab",
        name: "One",
        _attributeValues: { "aria-selected": "true" },
      } as Partial<Target>),
    ]);

    const probe = (result[0] as Record<string, unknown>)._tabProbe as TabProbeResults;
    expect(probe.probeSucceeded).toBe(true);
    expect(probe.arrowRightMovesFocus).toBe(true);
    expect(probe.activationSelectsTab).toBe(true);
    expect(probe.selectedTabHasPanel).toBe(true);

    await page.close();
  }, 15_000);

  it("detects disclosure toggle and controlled-region failures", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <button id="bad" aria-expanded="false" aria-controls="panel">Details</button>
      <div id="panel" hidden>Details panel</div>
      <script>
        document.getElementById('bad').addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            document.getElementById('bad').setAttribute('aria-expanded', 'true');
            // Bug: panel remains hidden.
          }
        });
      </script>
    `);

    const result = await probeTabAndDisclosurePatterns(page, [
      target({
        id: "bad",
        kind: "button",
        role: "button",
        name: "Details",
      } as Partial<Target>),
    ]);

    const probe = (result[0] as Record<string, unknown>)._disclosureProbe as DisclosureProbeResults;
    expect(probe.probeSucceeded).toBe(true);
    expect(probe.expandedFlipped).toBe(true);
    expect(probe.controlledRegionDisplayed).toBe(false);

    await page.close();
  }, 15_000);

  it("does not activate ordinary buttons while looking for disclosures", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <button id="plain">Plain action</button>
      <script>
        window.clicked = false;
        document.getElementById('plain').addEventListener('click', () => {
          window.clicked = true;
        });
      </script>
    `);

    const result = await probeTabAndDisclosurePatterns(page, [
      target({
        id: "plain",
        kind: "button",
        role: "button",
        name: "Plain action",
      } as Partial<Target>),
    ]);

    expect((result[0] as Record<string, unknown>)._disclosureProbe).toBeUndefined();
    await expect(page.evaluate(() => (window as unknown as { clicked: boolean }).clicked))
      .resolves.toBe(false);

    await page.close();
  }, 15_000);
});
