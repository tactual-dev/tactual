import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { walkTabOrder } from "./tab-order.js";

describe("walkTabOrder", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it("walks through focusable elements in DOM order on a normal page", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <button id="b1">First</button>
        <a id="a1" href="#x">Second</a>
        <input id="i1" type="text" />
        <button id="b2">Last</button>
      </main>
    `);

    const result = await walkTabOrder(page);
    await page.close();

    expect(result.sequence.length).toBeGreaterThanOrEqual(4);
    // First few stops should match DOM order
    expect(result.sequence[0].name).toBe("First");
    expect(result.sequence[1].name).toBe("Second");
    expect(result.sequence[3].name).toBe("Last");
    expect(result.hasPositiveTabindex).toBe(false);
  }, 20000);

  it("detects positive-tabindex anti-pattern", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <button>Plain</button>
        <button tabindex="5">Positive 5</button>
        <button>Another plain</button>
      </main>
    `);

    const result = await walkTabOrder(page);
    await page.close();

    expect(result.hasPositiveTabindex).toBe(true);
    // The positive-tabindex button should be encountered first per browser
    // tabindex semantics (positive values go before tabindex=0).
    const positiveStop = result.sequence.find((s) => s.tabIndex > 0);
    expect(positiveStop?.name).toBe("Positive 5");
  }, 20000);

  it("stops cleanly when the page has no focusables", async () => {
    const page = await browser.newPage();
    await page.setContent(`<main><h1>No focusables here</h1><p>Text only.</p></main>`);

    const result = await walkTabOrder(page);
    await page.close();

    expect(result.sequence.length).toBe(0);
    expect(result.cycledBack).toBe(false);
  }, 20000);
});
