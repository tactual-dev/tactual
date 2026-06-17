import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { probeDomInvaderTaint } from "./dom-invader-taint.js";

describe("probeDomInvaderTaint", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  async function mockHtml(context: BrowserContext, body: string): Promise<void> {
    await context.route("http://tactual.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body }),
    );
  }

  it("flags taint flow: location.search → innerHTML", async () => {
    // Page reads location.search and assigns it to innerHTML — the
    // canonical DOM-XSS pattern.
    const HTML = `<!DOCTYPE html><html lang="en"><head><title>Sink</title></head>
      <body>
        <div id="out"></div>
        <script>
          // Read taint source
          var q = window.location.search;
          // Flow into a sink (innerHTML)
          document.getElementById('out').innerHTML = q;
        </script>
      </body></html>`;
    const context = await browser.newContext();
    await mockHtml(context, HTML);
    const page = await context.newPage();

    const result = await probeDomInvaderTaint(page, "http://tactual.test/?x=hi");
    await context.close();

    expect(result.flows.some((f) => f.source === "location" && f.sink === "innerHTML")).toBe(true);
    expect(result.risky).toBe(true);
  }, 30000);

  it("flags taint flow: document.cookie → eval", async () => {
    const HTML = `<!DOCTYPE html><html lang="en"><head><title>EvalSink</title></head>
      <body>
        <script>
          document.cookie = 'a=1';
          var c = document.cookie;
          // Flow cookie into eval (worst-case sink)
          try { eval('var z = "' + c + '";'); } catch (_) {}
        </script>
      </body></html>`;
    const context = await browser.newContext();
    await mockHtml(context, HTML);
    const page = await context.newPage();

    const result = await probeDomInvaderTaint(page, "http://tactual.test/");
    await context.close();

    expect(result.flows.some((f) => f.source === "cookie" && f.sink === "eval")).toBe(true);
    expect(result.risky).toBe(true);
  }, 30000);

  it("flags taint flow: window.name → document.write", async () => {
    const HTML = `<!DOCTYPE html><html lang="en"><head><title>NameWrite</title></head>
      <body>
        <script>
          var n = window.name;
          if (n) document.write(n);
        </script>
      </body></html>`;
    const context = await browser.newContext();
    await mockHtml(context, HTML);
    const page = await context.newPage();
    // Set window.name BEFORE navigation so the source pickup actually
    // returns a value.
    await page.goto("about:blank");
    await page.evaluate(() => {
      window.name = "tactual_window_name_canary";
    });
    const result = await probeDomInvaderTaint(page, "http://tactual.test/");
    await context.close();

    expect(result.flows.some((f) => f.source === "window.name" && f.sink === "document.write")).toBe(true);
    expect(result.risky).toBe(true);
  }, 30000);

  it("flags taint flow: postMessage → setTimeout-string", async () => {
    const HTML = `<!DOCTYPE html><html lang="en"><head><title>PMTimeout</title></head>
      <body>
        <script>
          window.addEventListener('message', function (e) {
            // Flow postMessage data into setTimeout(string) — also worst case
            setTimeout(String(e.data), 10);
          });
        </script>
      </body></html>`;
    const context = await browser.newContext();
    await mockHtml(context, HTML);
    const page = await context.newPage();

    const result = await probeDomInvaderTaint(page, "http://tactual.test/");
    await context.close();

    expect(
      result.flows.some(
        (f) => f.source === "postMessage" && f.sink === "setTimeout-string",
      ),
    ).toBe(true);
    expect(result.risky).toBe(true);
  }, 30000);

  it("returns no flows when taint sources never reach a sink", async () => {
    const HTML = `<!DOCTYPE html><html lang="en"><head><title>Safe</title></head>
      <body>
        <main><h1>Safe page</h1><p>Static content with no JS interaction.</p></main>
      </body></html>`;
    const context = await browser.newContext();
    await mockHtml(context, HTML);
    const page = await context.newPage();

    const result = await probeDomInvaderTaint(page, "http://tactual.test/?x=hi");
    await context.close();

    expect(result.flows).toEqual([]);
    expect(result.risky).toBe(false);
  }, 30000);

  it("records one flow per source when multiple sources concatenate into one sink", async () => {
    // cookie + location.search both flow into innerHTML — both should
    // be recorded, not just the first one detected.
    const HTML = `<!DOCTYPE html><html lang="en"><head><title>Multi</title></head>
      <body>
        <div id="out"></div>
        <script>
          document.cookie = 'a=1';
          var c = document.cookie;
          var loc = window.location.search;
          // Concatenate two tainted strings into one innerHTML write.
          document.getElementById('out').innerHTML = c + ' / ' + loc;
        </script>
      </body></html>`;
    const context = await browser.newContext();
    await mockHtml(context, HTML);
    const page = await context.newPage();
    const result = await probeDomInvaderTaint(page, "http://tactual.test/?q=hi");
    await context.close();
    const innerHtmlSources = new Set(
      result.flows.filter((f) => f.sink === "innerHTML").map((f) => f.source),
    );
    expect(innerHtmlSources.has("cookie")).toBe(true);
    expect(innerHtmlSources.has("location")).toBe(true);
  }, 30000);

  it("does NOT flag when source is read but never reaches a sink", async () => {
    const HTML = `<!DOCTYPE html><html lang="en"><head><title>Read-only</title></head>
      <body>
        <script>
          // Read location but only console-log it (not a sink)
          var q = window.location.search;
          console.log(q);
        </script>
      </body></html>`;
    const context = await browser.newContext();
    await mockHtml(context, HTML);
    const page = await context.newPage();

    const result = await probeDomInvaderTaint(page, "http://tactual.test/?x=hi");
    await context.close();

    expect(result.flows).toEqual([]);
    expect(result.risky).toBe(false);
  }, 30000);
});
