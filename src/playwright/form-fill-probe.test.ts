import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { probeFormEnablement } from "./form-fill-probe.js";

async function mock(context: BrowserContext, body: string): Promise<void> {
  await context.route("http://tactual.test/", (route) =>
    route.fulfill({ contentType: "text/html", body }),
  );
}

describe("probeFormEnablement", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it("detects a button that flips disabled→enabled after a form is filled", async () => {
    const HTML = `<!DOCTYPE html><html lang="en"><head><title>Enable</title></head>
      <body><main>
        <form aria-label="Sign up">
          <input id="email" type="email" required />
          <button id="submit" type="submit" disabled>Sign up</button>
        </form>
        <script>
          // Enable submit when email field has a non-empty value
          document.getElementById('email').addEventListener('input', (e) => {
            document.getElementById('submit').disabled = !e.target.value;
          });
        </script>
      </main></body></html>`;

    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await probeFormEnablement(page);
    await context.close();

    expect(result.formsProbed).toBe(1);
    expect(result.enablementsFound.length).toBe(1);
    expect(result.enablementsFound[0].buttonName).toBe("Sign up");
    expect(result.enablementsFound[0].formName).toBe("Sign up");
  }, 30000);

  it("returns empty enablementsFound when buttons stay disabled regardless of fill", async () => {
    // Static disabled button — fill doesn't help.
    const HTML = `<!DOCTYPE html><html lang="en"><head><title>Static</title></head>
      <body><main>
        <form>
          <input type="text" />
          <button type="submit" disabled>Always disabled</button>
        </form>
      </main></body></html>`;

    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await probeFormEnablement(page);
    await context.close();

    expect(result.formsProbed).toBe(1);
    expect(result.enablementsFound).toEqual([]);
  }, 30000);
});
