import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { captureState } from "./capture.js";
import { probeHoverContent } from "./hover-probe.js";

async function mock(context: BrowserContext, body: string): Promise<void> {
  await context.route("http://tactual.test/", (route) =>
    route.fulfill({ contentType: "text/html", body }),
  );
}

describe("probeHoverContent", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it("captures hover-only popup content with no attribute hint", async () => {
    // CSS-only hover popup. The hidden link inside the .extras div only
    // appears in the accessibility tree when display flips to block, which
    // the hover triggers. role="tooltip" without aria-describedby gets
    // pruned from the a11y tree by Chrome, so the test uses a regular link
    // (clearly in-tree) as the revealed content.
    const HTML = `<!DOCTYPE html><html><head><style>
      .extras { display: none; position: absolute; background: #fff; padding: 8px; }
      .has-popup:hover .extras { display: block; }
    </style></head><body>
      <main>
        <div class="has-popup">
          <button>More info</button>
          <div class="extras">
            <a href="/learn">Learn more about the option</a>
          </div>
        </div>
        <button>Plain button</button>
      </main>
    </body></html>`;

    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });

    // Sanity: the revealed link is NOT in the initial state.
    expect(state.targets.some((t) => t.name === "Learn more about the option")).toBe(false);

    const probed = await probeHoverContent(page, state.targets, 5);
    await context.close();

    const moreInfo = probed.find((t) => t.kind === "button" && t.name === "More info");
    expect((moreInfo as Record<string, unknown>)?._hoverContent).toBeDefined();
    expect((moreInfo as Record<string, unknown>)?._hoverContent).toMatch(/Learn more/);

    const plain = probed.find((t) => t.kind === "button" && t.name === "Plain button");
    expect((plain as Record<string, unknown>)?._hoverContent).toBeUndefined();
  }, 30000);

  it("skips targets that already have an attribute-derived _tooltip", async () => {
    const HTML = `<!DOCTYPE html><html><body>
      <main>
        <button title="Save changes">Save</button>
        <button>No tooltip</button>
      </main>
    </body></html>`;

    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });

    // The Save button already has _tooltip from the title attribute. The
    // hover probe should leave it alone (no _hoverContent attempt).
    const save = state.targets.find((t) => t.name === "Save") as Record<string, unknown> | undefined;
    expect(save?._tooltip).toBeDefined();

    const probed = await probeHoverContent(page, state.targets, 5);
    await context.close();
    const saveAfter = probed.find((t) => t.name === "Save") as Record<string, unknown> | undefined;
    expect(saveAfter?._hoverContent).toBeUndefined();
  }, 30000);

  it("respects the budget cap", async () => {
    const buttons = Array.from({ length: 20 }, (_, i) => `<button>Btn ${i}</button>`).join("\n");
    const HTML = `<!DOCTYPE html><html><body><main>${buttons}</main></body></html>`;

    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });

    // Budget 3 → at most 3 hover attempts (none of these have hover content,
    // but the number of hover attempts is bounded by the budget regardless).
    const before = Date.now();
    await probeHoverContent(page, state.targets, 3);
    const elapsed = Date.now() - before;
    await context.close();

    // 3 hovers × ~750 ms each = ~2.25 s. Cap with margin: under 5 s.
    expect(elapsed).toBeLessThan(5000);
  }, 30000);
});
