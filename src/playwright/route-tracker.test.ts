import { describe, it, expect } from "vitest";
import { chromium, type BrowserContext } from "playwright";
import { coerceRouteChange, installRouteTracker } from "./route-tracker.js";

describe("coerceRouteChange", () => {
  it("accepts each supported kind", () => {
    for (const kind of ["pushState", "replaceState", "popstate", "hashchange"] as const) {
      const c = coerceRouteChange({ kind, url: "https://example.com/x" }, 42);
      expect(c).toEqual({ kind, url: "https://example.com/x", at: 42 });
    }
  });

  it("rejects unknown kinds", () => {
    expect(coerceRouteChange({ kind: "navigate", url: "https://x" }, 0)).toBeNull();
  });

  it("rejects non-object payloads", () => {
    expect(coerceRouteChange(null, 0)).toBeNull();
    expect(coerceRouteChange("pushState", 0)).toBeNull();
    expect(coerceRouteChange(42, 0)).toBeNull();
    expect(coerceRouteChange(undefined, 0)).toBeNull();
  });

  it("rejects payloads with missing or non-string fields", () => {
    expect(coerceRouteChange({ kind: "pushState" }, 0)).toBeNull();
    expect(coerceRouteChange({ url: "https://x" }, 0)).toBeNull();
    expect(coerceRouteChange({ kind: 1, url: "https://x" }, 0)).toBeNull();
    expect(coerceRouteChange({ kind: "pushState", url: 7 }, 0)).toBeNull();
  });
});

// SPA fixture must be served from a non-null origin so history.pushState is
// allowed (data: and about: have origin null and the call throws). We mock an
// http origin via context.route to keep the test hermetic.
const SPA_HTML = `<!DOCTYPE html>
<html><body>
<button id="push">push</button>
<button id="replace">replace</button>
<button id="back">back</button>
<button id="hash">hash</button>
<script>
  document.getElementById('push').addEventListener('click', function () {
    history.pushState({}, '', '/a');
  });
  document.getElementById('replace').addEventListener('click', function () {
    history.replaceState({}, '', '/b');
  });
  document.getElementById('back').addEventListener('click', function () {
    history.back();
  });
  document.getElementById('hash').addEventListener('click', function () {
    location.hash = '#section';
  });
</script>
</body></html>`;

async function mockSpa(context: BrowserContext, body: string = SPA_HTML): Promise<void> {
  await context.route("http://tactual.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body }),
  );
}

describe("installRouteTracker (integration)", () => {
  it("captures pushState, replaceState, popstate, and hashchange", async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await mockSpa(context);
      const tracker = await installRouteTracker(context);
      const page = await context.newPage();
      tracker.start();

      await page.goto("http://tactual.test/", { waitUntil: "load" });

      await page.click("#push");
      await page.click("#replace");
      await page.click("#hash");
      await page.click("#back");
      await page.waitForTimeout(150);

      const kinds = tracker.events.map((e) => e.kind);
      expect(kinds).toContain("pushState");
      expect(kinds).toContain("replaceState");
      expect(kinds).toContain("hashchange");
      expect(kinds).toContain("popstate");

      const push = tracker.events.find((e) => e.kind === "pushState");
      expect(push?.url.endsWith("/a")).toBe(true);
      const replace = tracker.events.find((e) => e.kind === "replaceState");
      expect(replace?.url.endsWith("/b")).toBe(true);
      const hash = tracker.events.find((e) => e.kind === "hashchange");
      expect(hash?.url.endsWith("#section")).toBe(true);

      for (const e of tracker.events) {
        expect(e.at).toBeGreaterThanOrEqual(0);
      }

      await context.close();
    } finally {
      await browser.close();
    }
  }, 30000);

  it("does not record events before start() is called", async () => {
    const earlyHtml = `<!DOCTYPE html><html><body><script>
      history.pushState({}, '', '/early');
    </script></body></html>`;

    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await mockSpa(context, earlyHtml);
      const tracker = await installRouteTracker(context);
      const page = await context.newPage();

      await page.goto("http://tactual.test/", { waitUntil: "load" });
      await page.waitForTimeout(100);

      expect(tracker.events).toHaveLength(0);
      await context.close();
    } finally {
      await browser.close();
    }
  }, 30000);

  it("stops recording after dispose()", async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await mockSpa(context);
      const tracker = await installRouteTracker(context);
      const page = await context.newPage();
      tracker.start();

      await page.goto("http://tactual.test/", { waitUntil: "load" });

      await page.click("#push");
      await page.waitForTimeout(100);
      const beforeDispose = tracker.events.length;
      expect(beforeDispose).toBeGreaterThan(0);

      tracker.dispose();
      await page.click("#push");
      await page.waitForTimeout(100);
      expect(tracker.events.length).toBe(beforeDispose);

      await context.close();
    } finally {
      await browser.close();
    }
  }, 30000);
});
