import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { detectFrameworks } from "./framework-detect.js";

async function mock(context: BrowserContext, body: string): Promise<void> {
  await context.route("http://tactual.test/", (route) =>
    route.fulfill({ contentType: "text/html", body }),
  );
}

describe("detectFrameworks", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it("detects Vue 3 via __vue_app__ JS prop on body (VitePress / vuejs.org pattern)", async () => {
    // VitePress doesn't add [data-v-app] but does install __vue_app__
    // on the mounted root element.
    const HTML = `<!DOCTYPE html><html><body>
      <div id="app"></div>
      <script>
        document.body.__vue_app__ = { _component: { name: 'App' } };
      </script>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });
    const f = await detectFrameworks(page);
    await context.close();
    expect(f.some((s) => s.name.startsWith("Vue"))).toBe(true);
  }, 30000);

  it("detects React via fiber keys on body element (Next.js App Router pattern)", async () => {
    // App-Router Next.js doesn't add #__next root; fiber keys live
    // on body and its first children.
    const HTML = `<!DOCTYPE html><html><body>
      <div>content</div>
      <script>
        document.body.__reactFiber$abc = { tag: 1 };
        document.body.__reactProps$abc = {};
      </script>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });
    const f = await detectFrameworks(page);
    await context.close();
    expect(f.some((s) => s.name === "React")).toBe(true);
  }, 30000);

  it("detects modern SvelteKit via svelte-* scoped style classes", async () => {
    const HTML = `<!DOCTYPE html><html data-sveltekit-preload-data>
      <body>
        <div class="container svelte-1abcd2e">Content</div>
        <p class="svelte-xyz123">More</p>
      </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });
    const f = await detectFrameworks(page);
    await context.close();
    expect(f.some((s) => s.name.startsWith("Svelte"))).toBe(true);
  }, 30000);
});
