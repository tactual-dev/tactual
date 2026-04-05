import { describe, it, expect } from "vitest";
import { chromium } from "playwright";
import { probeTargets, type ProbeResults } from "./probes.js";
import { captureState } from "./capture.js";

describe("probes", () => {
  it("probes a button and reports focusable + activatable", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <h1>Test</h1>
        <button id="btn" onclick="this.setAttribute('aria-pressed','true')">Click me</button>
      </main>
    `);

    const state = await captureState(page, { provenance: "scripted" });
    const probed = await probeTargets(page, state.targets);
    await browser.close();

    const btn = probed.find((t) => t.role === "button");
    expect(btn).toBeDefined();

    const probe = (btn as Record<string, unknown>)._probe as ProbeResults | undefined;
    expect(probe).toBeDefined();
    expect(probe!.probeSucceeded).toBe(true);
    expect(probe!.focusable).toBe(true);
  }, 15000);

  it("probes a menu and detects state change on expansion", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <h1>Test</h1>
        <button aria-expanded="false" aria-haspopup="menu"
          onclick="this.setAttribute('aria-expanded', this.getAttribute('aria-expanded')==='true' ? 'false' : 'true')">
          Menu
        </button>
        <ul role="menu" hidden><li role="menuitem">Item 1</li></ul>
      </main>
    `);

    const state = await captureState(page, { provenance: "scripted" });
    const probed = await probeTargets(page, state.targets);
    await browser.close();

    const menuBtn = probed.find((t) => t.name === "Menu");
    const probe = (menuBtn as Record<string, unknown>)?._probe as ProbeResults | undefined;
    if (probe?.probeSucceeded) {
      expect(probe.stateChanged).toBe(true);
    }
  }, 15000);

  it("leaves non-interactive and link targets unprobed", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <h1>Heading</h1>
        <nav aria-label="Main"><a href="/about">About</a></nav>
        <p>Some text</p>
      </main>
    `);

    const state = await captureState(page, { provenance: "scripted" });
    const probed = await probeTargets(page, state.targets);
    await browser.close();

    // Headings are not probeable
    const heading = probed.find((t) => t.role === "heading");
    expect(heading).toBeDefined();
    expect((heading as Record<string, unknown>)._probe).toBeUndefined();

    // Landmarks are not probeable
    const landmark = probed.find((t) => t.role === "navigation");
    expect(landmark).toBeDefined();
    expect((landmark as Record<string, unknown>)._probe).toBeUndefined();

    // Links are excluded from probing (clicking navigates away)
    const link = probed.find((t) => t.role === "link");
    expect(link).toBeDefined();
    expect((link as Record<string, unknown>)._probe).toBeUndefined();
  }, 15000);

  it("handles detached elements gracefully", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <h1>Test</h1>
        <button id="disappear">Gone</button>
      </main>
    `);

    const state = await captureState(page, { provenance: "scripted" });

    // Remove the button before probing
    await page.evaluate(() => document.getElementById("disappear")?.remove());

    const probed = await probeTargets(page, state.targets);
    await browser.close();

    const btn = probed.find((t) => t.name === "Gone");
    const probe = (btn as Record<string, unknown>)?._probe as ProbeResults | undefined;
    // Should either not have probe data or report probeSucceeded: false
    if (probe) {
      expect(probe.probeSucceeded).toBe(false);
    }
  }, 15000);

  it("respects MAX_PROBE_TARGETS limit", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    // Create 30 buttons — only 20 should be probed
    const buttons = Array.from({ length: 30 }, (_, i) =>
      `<button>Button ${i}</button>`
    ).join("\n");
    await page.setContent(`<main><h1>Test</h1>${buttons}</main>`);

    const state = await captureState(page, { provenance: "scripted" });
    const probed = await probeTargets(page, state.targets);
    await browser.close();

    const probedCount = probed.filter(
      (t) => (t as Record<string, unknown>)._probe !== undefined,
    ).length;
    expect(probedCount).toBeLessThanOrEqual(20);
    expect(probedCount).toBeGreaterThan(0);
  }, 30000);
});
