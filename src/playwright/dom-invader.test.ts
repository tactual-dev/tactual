import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { probeDomInvader, probeDomInvaderMultiSource } from "./dom-invader.js";

describe("probeDomInvader", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  async function mockReflectedXss(context: BrowserContext): Promise<void> {
    // Server-side mock: reflect the tactual_canary param into an inline
    // <script> tag (the worst-case DOM-XSS sink).
    await context.route("http://tactual.test/**", (route) => {
      const u = new URL(route.request().url());
      const canary = u.searchParams.get("tactual_canary") ?? "";
      route.fulfill({
        contentType: "text/html",
        body: `<!DOCTYPE html><html lang="en"><head><title>Reflect</title></head>
        <body>
          <main><h1>Reflected</h1></main>
          <script>var x = "${canary}";</script>
        </body></html>`,
      });
    });
  }

  async function mockSafeReflection(context: BrowserContext): Promise<void> {
    // Reflect into a regular text node — safe.
    await context.route("http://tactual.test/**", (route) => {
      const u = new URL(route.request().url());
      const canary = u.searchParams.get("tactual_canary") ?? "";
      route.fulfill({
        contentType: "text/html",
        body: `<!DOCTYPE html><html lang="en"><head><title>Safe</title></head>
        <body><main><h1>Safe</h1><p>You searched for: ${canary}</p></main></body></html>`,
      });
    });
  }

  it("flags canary echo into inline <script> as risky", async () => {
    const context = await browser.newContext();
    await mockReflectedXss(context);
    const page = await context.newPage();

    const result = await probeDomInvader(page, "http://tactual.test/");
    await context.close();

    expect(result.findings.some((f) => f.context === "script-content")).toBe(true);
    expect(result.risky).toBe(true);
    expect(result.findings[0].context).toBe("script-content");
  }, 30000);

  it("does NOT flag risky when canary echoes only into text content", async () => {
    const context = await browser.newContext();
    await mockSafeReflection(context);
    const page = await context.newPage();

    const result = await probeDomInvader(page, "http://tactual.test/");
    await context.close();

    // No risky context fires; findings may include "other-attr" elsewhere
    // but no script-content / event-handler-attr / javascript-url.
    expect(result.risky).toBe(false);
  }, 30000);

  it("multi-source probe injects unique canaries into URL/storage/cookie/postMessage", async () => {
    // Page that echoes localStorage value into an inline script — should
    // catch the local-storage canary specifically.
    const context = await browser.newContext();
    await context.route("http://tactual.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!DOCTYPE html><html lang="en"><head><title>Multi</title></head>
        <body>
          <main><h1>Multi</h1></main>
          <script>
            // Echo localStorage value into an inline script tag (created
            // dynamically, so source flows into a 'script-content' sink).
            var v = localStorage.getItem('tactual_canary_ls') || '';
            var s = document.createElement('script');
            s.textContent = 'var fromLs = "' + v + '";';
            document.head.appendChild(s);
          </script>
        </body></html>`,
      }),
    );
    const page = await context.newPage();

    const result = await probeDomInvaderMultiSource(page, "http://tactual.test/");
    await context.close();

    // local-storage canary should have ended up in a script-content sink
    const lsCanary = result.canaries.find((c) => c.source === "local-storage");
    expect(lsCanary?.findings.some((f) => f.context === "script-content")).toBe(true);
    expect(result.contamination.some((c) => c.source === "local-storage" && c.sinkContext === "script-content")).toBe(true);
    expect(result.risky).toBe(true);
  }, 30000);

  it("returns no findings when the page doesn't echo the canary at all", async () => {
    const context = await browser.newContext();
    await context.route("http://tactual.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!DOCTYPE html><html lang="en"><head><title>Static</title></head>
        <body><main><h1>Static page</h1></main></body></html>`,
      }),
    );
    const page = await context.newPage();

    const result = await probeDomInvader(page, "http://tactual.test/");
    await context.close();

    expect(result.findings).toEqual([]);
    expect(result.risky).toBe(false);
  }, 30000);
});
