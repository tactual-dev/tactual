import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { diffViewports } from "./viewport-diff.js";

async function mock(context: BrowserContext, body: string): Promise<void> {
  await context.route("http://tactual.test/", (route) =>
    route.fulfill({ contentType: "text/html", body }),
  );
}

describe("diffViewports", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it("returns no divergences for a page that renders identically at both viewports", async () => {
    const HTML = `<!DOCTYPE html><html><body>
      <header><nav><a href="/a">Home</a><a href="/b">About</a></nav></header>
      <main>
        <h1>Title</h1>
        <p>Stable content.</p>
        <button>Action</button>
      </main>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await diffViewports(page, { url: "http://tactual.test/" });
    await context.close();

    expect(result.desktop.targetCount).toBeGreaterThan(0);
    expect(result.mobile.targetCount).toBeGreaterThan(0);
    expect(result.divergences.targetsOnlyOnDesktop).toEqual([]);
    expect(result.divergences.targetsOnlyOnMobile).toEqual([]);
    // Same content at both viewports → no landmark divergence either.
    expect(result.divergences.landmarksOnlyOnDesktop).toEqual([]);
    expect(result.divergences.landmarksOnlyOnMobile).toEqual([]);
  }, 60000);

  it("flags a desktop-only nav menu (mobile uses hamburger that hides links)", async () => {
    // Classic responsive pattern: full nav on desktop, collapsed on mobile.
    // Use a viewport meta + explicit sizing on the toggle button so
    // its accessible bounding box is non-zero in both modes.
    const HTML = `<!DOCTYPE html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        .mobile-toggle { display: none; padding: 12px 18px; min-width: 80px; }
        .desktop-nav { display: block; }
        @media (max-width: 768px) {
          .desktop-nav { display: none; }
          .mobile-toggle { display: inline-block; }
        }
      </style>
    </head><body>
      <header>
        <nav class="desktop-nav">
          <a href="/products">Products</a>
          <a href="/pricing">Pricing</a>
          <a href="/contact">Contact</a>
        </nav>
        <button class="mobile-toggle" type="button" aria-label="Open menu">Menu</button>
      </header>
      <main><h1>Home</h1></main>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await diffViewports(page, { url: "http://tactual.test/" });
    await context.close();

    // Three nav links should be present desktop-only.
    expect(result.divergences.targetsOnlyOnDesktop.length).toBeGreaterThanOrEqual(3);
    const desktopOnlyNames = result.divergences.targetsOnlyOnDesktop.map((t) => t.name);
    expect(desktopOnlyNames).toContain("Products");
    expect(desktopOnlyNames).toContain("Pricing");
    expect(desktopOnlyNames).toContain("Contact");
    // Mobile sees the hamburger button — desktop hides it. Lookup by name
    // since target IDs vary per viewport.
    const mobileNames = result.mobile.targets.map((t) => t.name);
    expect(mobileNames).toContain("Open menu");
    const desktopNames = result.desktop.targets.map((t) => t.name);
    expect(desktopNames).not.toContain("Open menu");
  }, 60000);

  it("flags a section that's hidden at one viewport (visibility:hidden)", async () => {
    // Sidebar visible only on desktop.
    const HTML = `<!DOCTYPE html><html><head>
      <style>
        @media (max-width: 768px) {
          aside { display: none; }
        }
      </style>
    </head><body>
      <main>
        <h1>Article</h1>
        <p>Body</p>
      </main>
      <aside aria-label="Related links">
        <a href="/r1">Related 1</a>
        <a href="/r2">Related 2</a>
      </aside>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await diffViewports(page, { url: "http://tactual.test/" });
    await context.close();

    // The complementary landmark + its links exist desktop-only.
    expect(result.divergences.landmarksOnlyOnDesktop.length).toBeGreaterThan(0);
    const desktopLandmarks = result.divergences.landmarksOnlyOnDesktop.map((l) => l.role);
    expect(desktopLandmarks).toContain("complementary");
  }, 60000);

  it("respects custom viewport sizes via options", async () => {
    const HTML = `<!DOCTYPE html><html><body>
      <main><h1>Custom viewports</h1></main>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await diffViewports(page, {
      url: "http://tactual.test/",
      desktopViewport: { width: 1920, height: 1080 },
      mobileViewport: { width: 320, height: 568 }, // iPhone SE
    });
    await context.close();

    expect(result.desktop.viewport).toEqual({ width: 1920, height: 1080 });
    expect(result.mobile.viewport).toEqual({ width: 320, height: 568 });
  }, 60000);
});
