import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { dismissBanners } from "./banner-dismiss.js";

async function mock(context: BrowserContext, body: string): Promise<void> {
  await context.route("http://tactual.test/", (route) =>
    route.fulfill({ contentType: "text/html", body }),
  );
}

describe("dismissBanners", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it("dismisses a cookie banner via an Accept All button", async () => {
    const HTML = `<!DOCTYPE html><html><body>
      <main><h1>App</h1></main>
      <div id="cookie-banner" style="position:fixed;bottom:0;left:0;right:0;padding:20px;background:#222;color:#fff">
        We use cookies.
        <button>Decline</button>
        <button>Accept All</button>
      </div>
      <script>
        document.querySelectorAll('#cookie-banner button').forEach(btn => {
          btn.addEventListener('click', () => {
            document.getElementById('cookie-banner').remove();
          });
        });
      </script>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await dismissBanners(page);
    expect(result.candidatesFound).toBeGreaterThan(0);
    expect(result.attempted).toBe(1);
    expect(result.dismissed).toBe(1);
    expect(result.clickedLabels[0]).toMatch(/accept all/i);

    const stillVisible = await page.locator("#cookie-banner").count();
    expect(stillVisible).toBe(0);

    await context.close();
  }, 30000);

  it("does NOT click Decline / Manage / Customize buttons", async () => {
    const HTML = `<!DOCTYPE html><html><body>
      <div id="consent-modal" role="dialog">
        We need your consent.
        <button>Decline All</button>
        <button>Manage Preferences</button>
        <button>Customize Choices</button>
      </div>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await dismissBanners(page);
    // The modal is detected (has "consent" in id) but no acceptable
    // button matched — so we attempt nothing.
    expect(result.attempted).toBe(0);
    expect(result.dismissed).toBe(0);

    await context.close();
  }, 30000);

  it("returns empty result when no banner exists", async () => {
    const HTML = `<!DOCTYPE html><html><body>
      <main><h1>Plain page</h1><p>No banners here.</p></main>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await dismissBanners(page);
    expect(result.candidatesFound).toBe(0);
    expect(result.attempted).toBe(0);
    expect(result.dismissed).toBe(0);

    await context.close();
  }, 30000);

  it("dismisses a banner via aria-label when text content is empty", async () => {
    const HTML = `<!DOCTYPE html><html><body>
      <div class="cookie-bar">
        We use cookies.
        <button aria-label="Got it">×</button>
      </div>
      <script>
        document.querySelector('.cookie-bar button').addEventListener('click', () => {
          document.querySelector('.cookie-bar').remove();
        });
      </script>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await dismissBanners(page);
    expect(result.dismissed).toBe(1);
    expect(result.clickedLabels[0]).toMatch(/got it/i);

    await context.close();
  }, 30000);
});
