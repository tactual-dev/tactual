import { describe, it, expect } from "vitest";
import { chromium } from "playwright";
import { probeTargets, prioritizeTargetsForProbing, type ProbeResults } from "./probes.js";
import { captureState } from "./capture.js";
import type { Target } from "../core/types.js";

describe("probes", () => {
  it("probes a button and reports focusable + stateChanged", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <h1>Test</h1>
        <button id="btn" onclick="this.setAttribute('aria-pressed','true')">Click me</button>
      </main>
    `);

    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
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

    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    const probed = await probeTargets(page, state.targets);
    await browser.close();

    const menuBtn = probed.find((t) => t.name === "Menu");
    const probe = (menuBtn as Record<string, unknown>)?._probe as ProbeResults | undefined;
    if (probe?.probeSucceeded) {
      expect(probe.stateChanged).toBe(true);
    }
  }, 15000);

  it("waits for async aria state commits before reporting no state change", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <h1>Test</h1>
        <button id="async-toggle" aria-expanded="false" aria-controls="panel">
          Details
        </button>
        <section id="panel" hidden>Panel</section>
        <script>
          document.getElementById("async-toggle").addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            Promise.resolve().then(() => {
              const button = event.currentTarget;
              button.setAttribute("aria-expanded", "true");
              document.getElementById("panel").hidden = false;
            });
          });
        </script>
      </main>
    `);

    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    const probed = await probeTargets(page, state.targets);
    await browser.close();

    const button = probed.find((t) => t.name === "Details");
    const probe = (button as Record<string, unknown>)?._probe as ProbeResults | undefined;
    expect(probe?.stateChanged).toBe(true);
    expect(probe?.ariaStateAfterEnter).toMatchObject({ "aria-expanded": "true" });
  }, 15000);

  it("restores stateful controls after measuring activation", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <button id="toggle" aria-expanded="false"
          onclick="this.setAttribute('aria-expanded', this.getAttribute('aria-expanded') === 'true' ? 'false' : 'true')">
          Toggle details
        </button>
      </main>
    `);

    const state = await captureState(page, {
      provenance: "scripted",
      minTargets: 1,
    });
    await probeTargets(page, state.targets, 1);
    const expanded = await page.locator("#toggle").getAttribute("aria-expanded");
    await browser.close();

    expect(expanded).toBe("false");
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

  it("skips consent-management controls that can perturb the page", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <button>Cookie settings</button>
        <button>Allow all cookies</button>
        <button>Open menu</button>
      </main>
    `);

    const state = await captureState(page, { provenance: "scripted" });
    const probed = await probeTargets(page, state.targets, 10);
    await browser.close();

    const cookieSettings = probed.find((t) => t.name === "Cookie settings");
    const allowCookies = probed.find((t) => t.name === "Allow all cookies");
    const menu = probed.find((t) => t.name === "Open menu");
    expect((cookieSettings as Record<string, unknown>)?._probe).toBeUndefined();
    expect((allowCookies as Record<string, unknown>)?._probe).toBeUndefined();
    expect((menu as Record<string, unknown>)?._probe).toBeDefined();
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

  it("captures focusAfterActivation as 'stayed' for a plain toggle button", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <h1>T</h1>
        <button id="t" aria-pressed="false"
          onclick="this.setAttribute('aria-pressed', this.getAttribute('aria-pressed') === 'true' ? 'false' : 'true')">Mute</button>
      </main>
    `);
    const state = await captureState(page, { provenance: "scripted" });
    const probed = await probeTargets(page, state.targets);
    await browser.close();
    const probe = (probed.find((x) => x.role === "button") as Record<string, unknown>)._probe as ProbeResults | undefined;
    expect(probe?.focusAfterActivation).toBe("stayed");
  }, 15000);

  it("captures focusAfterActivation as 'moved-to-body' when the handler blurs focus", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    // Bug: onclick blurs the button itself — focus goes to body, user is at page start.
    await page.setContent(`
      <main>
        <h1>T</h1>
        <button id="b" onclick="this.blur()">Submit</button>
      </main>
    `);
    const state = await captureState(page, { provenance: "scripted" });
    const probed = await probeTargets(page, state.targets);
    await browser.close();
    const probe = (probed.find((x) => x.role === "button") as Record<string, unknown>)._probe as ProbeResults | undefined;
    expect(probe?.focusAfterActivation).toBe("moved-to-body");
  }, 15000);
});

describe("prioritizeTargetsForProbing", () => {
  const mk = (overrides: Partial<Target> & { attrs?: Record<string, string> }): Target =>
    ({
      id: overrides.id ?? "t",
      kind: (overrides.kind ?? "button") as Target["kind"],
      role: overrides.role ?? "button",
      name: overrides.name ?? "n",
      requiresBranchOpen: overrides.requiresBranchOpen ?? false,
      ...(overrides.attrs ? { _attributeValues: overrides.attrs } : {}),
    } as unknown as Target);

  it("ranks revealed-state targets above plain buttons", () => {
    const plain = mk({ id: "plain", role: "button" });
    const revealed = mk({ id: "rev", role: "button", requiresBranchOpen: true });
    const [first] = prioritizeTargetsForProbing([plain, revealed]);
    expect(first.id).toBe("rev");
  });

  it("ranks menu triggers (aria-haspopup) above plain buttons", () => {
    const plain = mk({ id: "plain", role: "button" });
    const trigger = mk({ id: "trig", role: "button", attrs: { "aria-haspopup": "menu" } });
    const [first] = prioritizeTargetsForProbing([plain, trigger]);
    expect(first.id).toBe("trig");
  });

  it("ranks stateful roles (combobox/dialog/menu) above plain roles", () => {
    const btn = mk({ id: "b", role: "button" });
    const combo = mk({ id: "c", role: "combobox" });
    const dialog = mk({ id: "d", role: "dialog" });
    const [first, second] = prioritizeTargetsForProbing([btn, combo, dialog]);
    // combobox has weight 10, dialog has weight 9, button has weight 2.
    expect(first.id).toBe("c");
    expect(second.id).toBe("d");
  });

  it("stacks signals additively (revealed + haspopup beats just haspopup)", () => {
    const onlyPopup = mk({ id: "a", role: "button", attrs: { "aria-haspopup": "menu" } });
    const bothSignals = mk({
      id: "b",
      role: "button",
      requiresBranchOpen: true,
      attrs: { "aria-haspopup": "menu" },
    });
    const [first] = prioritizeTargetsForProbing([onlyPopup, bothSignals]);
    expect(first.id).toBe("b");
  });

  it("is stable: preserves DOM order for equal scores", () => {
    const a = mk({ id: "a", role: "button" });
    const b = mk({ id: "b", role: "button" });
    const c = mk({ id: "c", role: "button" });
    expect(prioritizeTargetsForProbing([a, b, c]).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
});
