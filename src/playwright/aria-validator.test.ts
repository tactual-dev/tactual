import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { validateAriaUsage } from "./aria-validator.js";

async function mock(context: BrowserContext, body: string): Promise<void> {
  await context.route("http://tactual.test/", (route) =>
    route.fulfill({ contentType: "text/html", body }),
  );
}

describe("validateAriaUsage", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it("flags an unknown role with a 'did you mean' hint", async () => {
    const HTML = `<!DOCTYPE html><html lang="en"><body>
      <div role="buton">x</div>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await validateAriaUsage(page);
    await context.close();

    expect(result.invalidRoles).toHaveLength(1);
    expect(result.invalidRoles[0].name).toBe("buton");
    expect(result.invalidRoles[0].hint).toBe("button");
  }, 30000);

  it("flags an unknown aria-* attribute", async () => {
    const HTML = `<!DOCTYPE html><html lang="en"><body>
      <button aria-decribedby="x">x</button><span id="x">desc</span>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await validateAriaUsage(page);
    await context.close();

    expect(result.unknownAttrs.some((u) => u.name === "aria-decribedby")).toBe(true);
  }, 30000);

  it("flags an aria-* attribute that is NOT supported on a given role", async () => {
    // aria-checked is only supported on roles in the role-checked-by spec
    // (checkbox, radio, switch, etc.) — NOT on link.
    const HTML = `<!DOCTYPE html><html lang="en"><body>
      <a href="#" role="link" aria-checked="true">Bad link</a>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await validateAriaUsage(page);
    await context.close();

    expect(result.unsupportedAttrsForRole).toBeDefined();
    expect(result.unsupportedAttrsForRole.length).toBeGreaterThan(0);
    const issue = result.unsupportedAttrsForRole.find((u) => u.name === "aria-checked");
    expect(issue).toBeDefined();
    expect(issue?.hint).toContain("link");
  }, 30000);

  it("does NOT flag aria-checked on role=checkbox (it IS supported there)", async () => {
    const HTML = `<!DOCTYPE html><html lang="en"><body>
      <div role="checkbox" aria-checked="true" tabindex="0">Toggle</div>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await validateAriaUsage(page);
    await context.close();

    expect(result.unsupportedAttrsForRole).toEqual([]);
  }, 30000);

  it("flags aria-expanded on role=img (image doesn't support expanded)", async () => {
    const HTML = `<!DOCTYPE html><html lang="en"><body>
      <span role="img" aria-label="hi" aria-expanded="false">x</span>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await validateAriaUsage(page);
    await context.close();

    expect(result.unsupportedAttrsForRole.some((u) => u.name === "aria-expanded")).toBe(true);
  }, 30000);

  it("does NOT flag global aria-* attributes (label/hidden/describedby) on any role", async () => {
    // aria-label, aria-labelledby, aria-describedby, aria-hidden, aria-busy,
    // aria-controls, aria-current, aria-details, aria-flowto, aria-keyshortcuts,
    // aria-live, aria-owns, aria-relevant, aria-roledescription are GLOBAL —
    // allowed on any role.
    const HTML = `<!DOCTYPE html><html lang="en"><body>
      <article aria-label="x" aria-describedby="d" aria-hidden="false">
        <p id="d">desc</p>
      </article>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await validateAriaUsage(page);
    await context.close();

    expect(result.unsupportedAttrsForRole).toEqual([]);
  }, 30000);

  it("respects existing required-attrs and naming-prohibited checks", async () => {
    // Combobox without aria-expanded should still fire the required-attr issue.
    const HTML = `<!DOCTYPE html><html lang="en"><body>
      <div role="combobox" tabindex="0">x</div>
      <span role="generic" aria-label="bad">y</span>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await validateAriaUsage(page);
    await context.close();

    expect(result.missingRequiredAttrs.some((i) => i.value === "aria-expanded")).toBe(true);
    expect(result.prohibitedNaming.some((i) => i.name === "generic")).toBe(true);
  }, 30000);
});
