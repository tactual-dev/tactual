import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { captureState } from "./capture.js";
import { installEventListenerRegistry } from "./event-listener-registry.js";

async function mock(context: BrowserContext, body: string): Promise<void> {
  await context.route("http://tactual.test/", (route) =>
    route.fulfill({ contentType: "text/html", body }),
  );
}

describe("event-listener registry + extended fake-interactive detection", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it("catches a div with addEventListener('click') when registry is installed", async () => {
    const HTML = `<!DOCTYPE html><html><body>
      <main>
        <button>Real button</button>
        <!-- No declarative onclick. The click handler is attached via
             addEventListener — invisible to a [onclick] DOM scan. -->
        <div id="fake" style="width:100px;height:30px;cursor:pointer">Pseudo button</div>
      </main>
      <script>
        document.getElementById('fake').addEventListener('click', () => {
          console.log('clicked');
        });
      </script>
    </body></html>`;

    const context = await browser.newContext();
    await installEventListenerRegistry(context);
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });
    const state = await captureState(page, {
      provenance: "scripted",
      minTargets: 1,
      spaWaitTimeout: 2000,
    });
    await context.close();

    const fake = (state as Record<string, unknown>)._fakeInteractive as
      | { count: number; samples: string[] }
      | undefined;
    expect(fake?.count).toBe(1);
    expect(fake?.samples.some((s) => s.includes("[addEventListener]"))).toBe(true);
  }, 30000);

  it("does NOT catch addEventListener click when registry isn't installed", async () => {
    // Sanity: without the init script, addEventListener-attached handlers
    // are invisible. Confirms the registry is the bridge — capture.ts on
    // its own can't see these handlers.
    const HTML = `<!DOCTYPE html><html><body>
      <main>
        <h1>Page</h1>
        <div id="fake" style="width:100px;height:30px">Pseudo</div>
      </main>
      <script>
        document.getElementById('fake').addEventListener('click', () => {});
      </script>
    </body></html>`;

    const context = await browser.newContext();
    // Note: NOT calling installEventListenerRegistry.
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });
    const state = await captureState(page, {
      provenance: "scripted",
      minTargets: 1,
      spaWaitTimeout: 2000,
    });
    await context.close();

    const fake = (state as Record<string, unknown>)._fakeInteractive as
      | { count: number; samples: string[] }
      | undefined;
    // Without the registry and without a __reactProps fiber, this div is
    // invisible to our detection.
    expect(fake?.count ?? 0).toBe(0);
  }, 30000);

  it("catches a div whose React fiber __reactProps$ carries onClick", async () => {
    // No registry installed and no addEventListener. We synthesize a
    // React-style fiber prop on the element. capture.ts should still
    // detect this via the __reactProps$ key scan.
    const HTML = `<!DOCTYPE html><html><body>
      <main>
        <h1>Page</h1>
        <div id="reactish" style="width:100px;height:30px">Reactish button</div>
      </main>
      <script>
        // Simulate React 17+ fiber prop attachment.
        document.getElementById('reactish').__reactProps$abc123 = {
          onClick: function () {},
          children: 'Reactish button',
        };
      </script>
    </body></html>`;

    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });
    const state = await captureState(page, {
      provenance: "scripted",
      minTargets: 1,
      spaWaitTimeout: 2000,
    });
    await context.close();

    const fake = (state as Record<string, unknown>)._fakeInteractive as
      | { count: number; samples: string[] }
      | undefined;
    expect(fake?.count).toBe(1);
    expect(fake?.samples.some((s) => s.includes("[react]"))).toBe(true);
  }, 30000);

  it("does not double-count an element that has both onclick AND addEventListener", async () => {
    const HTML = `<!DOCTYPE html><html><body>
      <main>
        <h1>Page</h1>
        <div id="dup" onclick="alert()" style="width:100px;height:30px">Dup</div>
      </main>
      <script>
        document.getElementById('dup').addEventListener('click', () => {});
      </script>
    </body></html>`;

    const context = await browser.newContext();
    await installEventListenerRegistry(context);
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });
    const state = await captureState(page, {
      provenance: "scripted",
      minTargets: 1,
      spaWaitTimeout: 2000,
    });
    await context.close();

    const fake = (state as Record<string, unknown>)._fakeInteractive as
      | { count: number; samples: string[] }
      | undefined;
    expect(fake?.count).toBe(1);
  }, 30000);
});
