import { describe, it, expect } from "vitest";
import { chromium, type BrowserContext } from "playwright";
import {
  autoScrollChildFrames,
  autoScrollContainers,
  autoScrollToBottom,
  scrollToTop,
} from "./auto-scroll.js";

const LAZY_LIST_HTML = `<!DOCTYPE html>
<html><body>
<div id="initial" style="height: 800px;">
  <h1>Above the fold</h1>
  <p>Initial content</p>
</div>
<div id="lazy-zone" style="height: 200px;"></div>
<script>
  // Lazy-append a heading + button each time the lazy-zone enters the viewport,
  // up to four total — emulates an infinite-scroll feed that exhausts.
  let added = 0;
  const zone = document.getElementById('lazy-zone');
  const observer = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting) return;
    if (added >= 4) return;
    added++;
    const heading = document.createElement('h2');
    heading.textContent = 'Lazy heading ' + added;
    document.body.appendChild(heading);
    const btn = document.createElement('button');
    btn.textContent = 'Lazy button ' + added;
    document.body.appendChild(btn);
    // Push lazy-zone further down so the next scroll triggers another load.
    const spacer = document.createElement('div');
    spacer.style.height = '600px';
    document.body.appendChild(spacer);
    document.body.appendChild(zone);
  }, { threshold: 0 });
  observer.observe(zone);
</script>
</body></html>`;

async function mockLazy(context: BrowserContext, body: string = LAZY_LIST_HTML): Promise<void> {
  await context.route("http://tactual.test/", (route) =>
    route.fulfill({ contentType: "text/html", body }),
  );
}

describe("autoScrollToBottom", () => {
  it("triggers IntersectionObserver-driven lazy loads", async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      await mockLazy(context);
      const page = await context.newPage();
      await page.goto("http://tactual.test/", { waitUntil: "load" });

      const beforeCount = await page.evaluate(() => document.querySelectorAll("h2").length);
      expect(beforeCount).toBe(0);

      const result = await autoScrollToBottom(page, { maxScrolls: 10, scrollPauseMs: 200 });

      const afterCount = await page.evaluate(() => document.querySelectorAll("h2").length);
      expect(afterCount).toBeGreaterThan(0);
      expect(afterCount).toBeLessThanOrEqual(4);
      expect(result.scrolls).toBeGreaterThan(0);
      expect(result.finalHeight).toBeGreaterThan(result.startHeight);

      await context.close();
    } finally {
      await browser.close();
    }
  }, 30000);

  it("returns reachedBottom=true on a static page", async () => {
    const STATIC_HTML = `<!DOCTYPE html>
      <html><body><main><h1>Static page</h1><p>No lazy content.</p></main></body></html>`;
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      await mockLazy(context, STATIC_HTML);
      const page = await context.newPage();
      await page.goto("http://tactual.test/", { waitUntil: "load" });

      const result = await autoScrollToBottom(page, { maxScrolls: 10, scrollPauseMs: 100 });

      expect(result.reachedBottom).toBe(true);
      expect(result.finalHeight).toBe(result.startHeight);
      expect(result.scrolls).toBeLessThanOrEqual(3);

      await context.close();
    } finally {
      await browser.close();
    }
  }, 30000);

  it("scrolls inner overflow:auto containers and triggers their lazy loads", async () => {
    const HTML = `<!DOCTYPE html><html><body>
      <h1>Outer page</h1>
      <div id="inner" style="height: 200px; overflow: auto; border: 1px solid;">
        <div id="seed" style="height: 250px;">seed</div>
        <div id="lazy-anchor" style="height: 50px;"></div>
      </div>
      <script>
        let added = 0;
        const inner = document.getElementById('inner');
        const anchor = document.getElementById('lazy-anchor');
        new IntersectionObserver((entries) => {
          if (!entries[0].isIntersecting || added >= 3) return;
          added++;
          const h = document.createElement('h2');
          h.textContent = 'Inner lazy ' + added;
          inner.appendChild(h);
          const spacer = document.createElement('div');
          spacer.style.height = '300px';
          inner.appendChild(spacer);
          inner.appendChild(anchor);
        }, { root: inner, threshold: 0 }).observe(anchor);
      </script>
    </body></html>`;

    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      await mockLazy(context, HTML);
      const page = await context.newPage();
      await page.goto("http://tactual.test/", { waitUntil: "load" });

      const before = await page.evaluate(() => document.querySelectorAll("h2").length);
      expect(before).toBe(0);

      const result = await autoScrollContainers(page, {
        maxContainers: 5,
        maxScrollsPerContainer: 8,
        scrollPauseMs: 150,
      });

      const after = await page.evaluate(() => document.querySelectorAll("h2").length);
      expect(after).toBeGreaterThan(0);
      expect(result.containers).toBe(1);
      expect(result.totalScrolls).toBeGreaterThan(0);

      // Container scroll position should be restored to 0 after.
      const scrollTopAfter = await page.evaluate(
        () => document.getElementById("inner")!.scrollTop,
      );
      expect(scrollTopAfter).toBe(0);

      await context.close();
    } finally {
      await browser.close();
    }
  }, 30000);

  it("ignores elements without overflow scroll/auto and elements that already fit", async () => {
    const HTML = `<!DOCTYPE html><html><body>
      <h1>Page</h1>
      <!-- visible div, no overflow set, content fits — should be skipped -->
      <div style="height: 100px;">tiny</div>
      <!-- has overflow but content fits exactly — should be skipped -->
      <div style="height: 200px; overflow: auto;">
        <div style="height: 200px;">fits</div>
      </div>
    </body></html>`;
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      await mockLazy(context, HTML);
      const page = await context.newPage();
      await page.goto("http://tactual.test/", { waitUntil: "load" });

      const result = await autoScrollContainers(page);
      expect(result.containers).toBe(0);
      expect(result.totalScrolls).toBe(0);

      await context.close();
    } finally {
      await browser.close();
    }
  }, 30000);

  it("scrollToTop returns scrollY to 0", async () => {
    const TALL_HTML = `<!DOCTYPE html>
      <html><body><div style="height: 5000px;">tall</div></body></html>`;
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      await mockLazy(context, TALL_HTML);
      const page = await context.newPage();
      await page.goto("http://tactual.test/", { waitUntil: "load" });

      await page.evaluate(() => window.scrollTo(0, 2000));
      const beforeReset = await page.evaluate(() => window.scrollY);
      expect(beforeReset).toBeGreaterThan(1000);

      await scrollToTop(page);

      const afterReset = await page.evaluate(() => window.scrollY);
      expect(afterReset).toBe(0);

      await context.close();
    } finally {
      await browser.close();
    }
  }, 30000);

  it("scrolls child frames before frame capture", async () => {
    const PARENT = `<!DOCTYPE html><html><body>
      <h1>Parent</h1>
      <iframe src="http://tactual.test/frame" title="Lazy frame"></iframe>
    </body></html>`;
    const FRAME = `<!DOCTYPE html><html><body>
      <div style="height: 900px;">Frame start</div>
      <div id="lazy-zone" style="height: 50px;"></div>
      <script>
        let added = 0;
        const zone = document.getElementById('lazy-zone');
        new IntersectionObserver((entries) => {
          if (!entries[0].isIntersecting || added >= 2) return;
          added++;
          const button = document.createElement('button');
          button.textContent = 'Frame lazy button ' + added;
          document.body.appendChild(button);
          const spacer = document.createElement('div');
          spacer.style.height = '500px';
          document.body.appendChild(spacer);
          document.body.appendChild(zone);
        }).observe(zone);
      </script>
    </body></html>`;

    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      await context.route("http://tactual.test/", (route) =>
        route.fulfill({ contentType: "text/html", body: PARENT }),
      );
      await context.route("http://tactual.test/frame", (route) =>
        route.fulfill({ contentType: "text/html", body: FRAME }),
      );
      const page = await context.newPage();
      await page.goto("http://tactual.test/", { waitUntil: "load" });

      const frame = page.frames().find((f) => f.url() === "http://tactual.test/frame");
      expect(frame).toBeDefined();
      const before = await frame!.evaluate(() => document.querySelectorAll("button").length);
      expect(before).toBe(0);

      const result = await autoScrollChildFrames(page, {
        maxFrames: 5,
        maxScrolls: 6,
        scrollPauseMs: 150,
      });

      const after = await frame!.evaluate(() => document.querySelectorAll("button").length);
      expect(after).toBeGreaterThan(0);
      expect(result.frames).toBe(1);
      expect(result.framesScrolled).toBe(1);

      await context.close();
    } finally {
      await browser.close();
    }
  }, 30000);
});
