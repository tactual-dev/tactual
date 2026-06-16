import { describe, it, expect } from "vitest";
import { chromium, type BrowserContext } from "playwright";
import { captureState } from "./capture.js";
import { explore } from "./explorer.js";

const FIXTURE_HTML = `<!DOCTYPE html>
<html><body>
<main>
  <h1>Custom triggers</h1>

  <button id="bs-modal" data-bs-toggle="modal">Open Bootstrap modal</button>
  <div id="bs-modal-target" hidden>
    <h2>Bootstrap modal heading</h2>
    <button>Bootstrap modal action</button>
  </div>

  <button id="bs-dropdown" data-bs-toggle="dropdown">Open Bootstrap dropdown</button>
  <ul id="bs-dropdown-target" hidden>
    <li><a href="#x">Bootstrap dropdown link</a></li>
  </ul>

  <button id="aria-controls-only" aria-controls="custom-panel">Show details</button>
  <div id="custom-panel" hidden>
    <h2>Custom panel heading</h2>
  </div>

  <button id="custom-data" data-modal-trigger>Open custom modal</button>
  <div id="custom-data-target" hidden>
    <h2>Custom data-trigger heading</h2>
  </div>

  <script>
    function bind(triggerId, targetId) {
      document.getElementById(triggerId).addEventListener("click", () => {
        const t = document.getElementById(targetId);
        t.removeAttribute("hidden");
      });
    }
    bind("bs-modal", "bs-modal-target");
    bind("bs-dropdown", "bs-dropdown-target");
    bind("aria-controls-only", "custom-panel");
    bind("custom-data", "custom-data-target");
  </script>
</main>
</body></html>`;

async function mockFixture(context: BrowserContext): Promise<void> {
  await context.route("http://tactual.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: FIXTURE_HTML }),
  );
}

describe("explorer (custom-pattern triggers)", () => {
  it("activates Bootstrap data-toggle, data-*-trigger, and bare aria-controls buttons", async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await mockFixture(context);
      const page = await context.newPage();
      await page.goto("http://tactual.test/", { waitUntil: "load" });

      const initial = await captureState(page);
      const initialNames = new Set(initial.targets.map((t) => `${t.kind}:${t.name}`));

      const result = await explore(page, initial, { maxDepth: 1, maxActions: 8 });

      // The content hidden behind each custom trigger should appear in
      // explored states once the corresponding button is activated.
      const allTargets = result.states.flatMap((s) => s.targets);
      const allNames = new Set(allTargets.map((t) => `${t.kind}:${t.name}`));

      expect(allNames.has("heading:Bootstrap modal heading")).toBe(true);
      expect(allNames.has("link:Bootstrap dropdown link")).toBe(true);
      expect(allNames.has("heading:Custom panel heading")).toBe(true);
      expect(allNames.has("heading:Custom data-trigger heading")).toBe(true);

      // None of those existed in the initial state.
      expect(initialNames.has("heading:Bootstrap modal heading")).toBe(false);
      expect(initialNames.has("heading:Custom panel heading")).toBe(false);

      // Sanity: the explorer recorded actual activations.
      expect(result.actionsPerformed).toBeGreaterThanOrEqual(4);

      await page.close();
      await context.close();
    } finally {
      await browser.close();
    }
  }, 90000);
});
