import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { waitForFrameworkSettled } from "./framework-settle.js";

async function mock(context: BrowserContext, body: string): Promise<void> {
  await context.route("http://tactual.test/", (route) =>
    route.fulfill({ contentType: "text/html", body }),
  );
}

describe("waitForFrameworkSettled", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it("returns 'no-framework' immediately for a plain HTML page", async () => {
    const HTML = `<!DOCTYPE html><html><body><h1>Plain</h1></body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const start = Date.now();
    const result = await waitForFrameworkSettled(page, [], { timeout: 2000 });
    const elapsed = Date.now() - start;
    await context.close();

    expect(result.settled).toBe(true);
    expect(result.strategy).toBe("no-framework");
    // Should NOT spin for the full timeout when no framework is present.
    expect(elapsed).toBeLessThan(500);
  }, 30000);

  it("applies the React strategy when React is detected — settles after fiber commit", async () => {
    // Stub a React-fiber marker on document.body so the strategy probe finds
    // it. The settle helper waits for a commit-finished signal: in our stub
    // we toggle a flag that the strategy polls.
    const HTML = `<!DOCTYPE html><html><body>
      <div id="root"><span>Hi</span></div>
      <script>
        // Fake a React container w/ a 'committing' phase that resolves after 200ms
        const root = document.getElementById('root');
        root.__reactContainer$abc = { current: { alternate: { tag: 1 } } };
        // After 200ms, "commit" finishes — alternate becomes null (which is
        // what real react-dom does after a commit).
        setTimeout(() => {
          root.__reactContainer$abc.current.alternate = null;
        }, 200);
      </script>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const start = Date.now();
    const result = await waitForFrameworkSettled(
      page,
      [{ name: "React", evidence: "stub" }],
      { timeout: 3000 },
    );
    const elapsed = Date.now() - start;
    await context.close();

    expect(result.settled).toBe(true);
    expect(result.strategy).toBe("react");
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2000);
  }, 30000);

  it("applies the Angular strategy and uses NgZone.isStable", async () => {
    const HTML = `<!DOCTYPE html><html><body>
      <app-root ng-version="17.0.0">App</app-root>
      <script>
        // Fake the NgZone API: starts unstable, becomes stable after 250ms.
        let stable = false;
        window.getAllAngularTestabilities = function () {
          return [{
            isStable: () => stable,
            whenStable: (cb) => {
              if (stable) cb();
              else {
                const t = setInterval(() => { if (stable) { clearInterval(t); cb(); } }, 50);
              }
            }
          }];
        };
        setTimeout(() => { stable = true; }, 250);
      </script>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const start = Date.now();
    const result = await waitForFrameworkSettled(
      page,
      [{ name: "Angular", version: "17.0.0", evidence: "[ng-version]" }],
      { timeout: 3000 },
    );
    const elapsed = Date.now() - start;
    await context.close();

    expect(result.settled).toBe(true);
    expect(result.strategy).toBe("angular");
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(2000);
  }, 30000);

  it("applies the Vue strategy and waits for nextTick to flush", async () => {
    const HTML = `<!DOCTYPE html><html><body>
      <div data-v-app>
        <span data-v-pending="1">x</span>
      </div>
      <script>
        // Vue 3 marker — settle helper waits for one rAF + microtask flush.
        // Schedule a DOM mutation in a microtask; settle should observe a
        // stable DOM after that flushes.
        Promise.resolve().then(() => {
          document.querySelector('[data-v-pending]').setAttribute('data-v-done', '1');
        });
      </script>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await waitForFrameworkSettled(
      page,
      [{ name: "Vue 3", evidence: "[data-v-app]" }],
      { timeout: 3000 },
    );
    await context.close();

    expect(result.settled).toBe(true);
    expect(result.strategy).toBe("vue");
  }, 30000);

  it("returns settled=false (timed out) when the framework never settles", async () => {
    // React stub that NEVER clears the alternate.
    const HTML = `<!DOCTYPE html><html><body>
      <div id="root"></div>
      <script>
        const r = document.getElementById('root');
        r.__reactContainer$xyz = { current: { alternate: { tag: 1 } } };
        // alternate stays set forever — strategy must time out gracefully
      </script>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const start = Date.now();
    const result = await waitForFrameworkSettled(
      page,
      [{ name: "React", evidence: "stub" }],
      { timeout: 800 },
    );
    const elapsed = Date.now() - start;
    await context.close();

    expect(result.settled).toBe(false);
    expect(result.strategy).toBe("react");
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThan(1500);
  }, 30000);
});
