import { describe, it, expect } from "vitest";
import { chromium, type BrowserContext } from "playwright";
import { captureState } from "./capture.js";

const FIXTURE_HTML = `<!DOCTYPE html>
<html><body>
<main>
  <h1>Tooltip fixtures</h1>

  <!-- HTML title on a button: tagName === role, simplest case -->
  <button title="Save your changes">Save</button>

  <!-- HTML title on an anchor: tagName 'a' but accessible role 'link' —
       the prior role-fallback (tagName.toLowerCase()) would have failed
       to match this one -->
  <a href="#help" title="Open help docs">Help</a>

  <!-- Bootstrap pattern: title is moved to data-bs-original-title at runtime;
       Tactual reads the attribute either way -->
  <button data-bs-original-title="Bootstrap-style tooltip" data-bs-toggle="tooltip">Bootstrap</button>

  <!-- Tippy.js pattern -->
  <button data-tippy-content="Tippy-style tooltip">Tippy</button>

  <!-- Generic data-tooltip pattern -->
  <button data-tooltip="Generic data-tooltip">Generic</button>

  <!-- Balloon.css pattern -->
  <button data-balloon="Balloon-style tooltip">Balloon</button>

  <!-- Tooltip on a custom-role widget — proves explicit role wins -->
  <div role="button" tabindex="0" data-tooltip="Custom widget tooltip">Widget</div>
</main>
</body></html>`;

async function mockFixture(context: BrowserContext): Promise<void> {
  await context.route("http://tactual.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: FIXTURE_HTML }),
  );
}

describe("captureState (tooltip enrichment)", () => {
  it("attaches _tooltip from title, data-bs-original-title, data-tippy-content, data-tooltip, data-balloon", async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await mockFixture(context);
      const page = await context.newPage();
      await page.goto("http://tactual.test/", { waitUntil: "load" });

      const state = await captureState(page, { provenance: "scripted" });

      const findByName = (kind: string, name: string) =>
        state.targets.find((t) => t.kind === kind && t.name === name) as
          | Record<string, unknown>
          | undefined;

      expect(findByName("button", "Save")?._tooltip).toBe("Save your changes");
      expect(findByName("link", "Help")?._tooltip).toBe("Open help docs");
      expect(findByName("button", "Bootstrap")?._tooltip).toBe("Bootstrap-style tooltip");
      expect(findByName("button", "Tippy")?._tooltip).toBe("Tippy-style tooltip");
      expect(findByName("button", "Generic")?._tooltip).toBe("Generic data-tooltip");
      expect(findByName("button", "Balloon")?._tooltip).toBe("Balloon-style tooltip");
      expect(findByName("button", "Widget")?._tooltip).toBe("Custom widget tooltip");

      await context.close();
    } finally {
      await browser.close();
    }
  }, 30000);

  it("matches tooltips on native inputs labeled via <label for>", async () => {
    // Regression coverage: enrichTooltips previously extracted name as
    // (aria-label ?? textContent), so a <input title="..."> labeled by a
    // sibling <label for> ended up with name="" and never matched the
    // target whose name came from the label association.
    const HTML = `<!DOCTYPE html><html><body>
      <label for="email">Email</label>
      <input id="email" type="email" title="Your work email address" />
    </body></html>`;
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await context.route("http://tactual.test/", (route) =>
        route.fulfill({ contentType: "text/html", body: HTML }),
      );
      const page = await context.newPage();
      await page.goto("http://tactual.test/", { waitUntil: "load" });
      const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
      const email = state.targets.find(
        (t) => t.kind === "formField" && t.name === "Email",
      ) as Record<string, unknown> | undefined;
      expect(email?._tooltip).toBe("Your work email address");
      await context.close();
    } finally {
      await browser.close();
    }
  }, 30000);
});
