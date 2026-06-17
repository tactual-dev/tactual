import { describe, it, expect } from "vitest";
import { chromium, type BrowserContext } from "playwright";
import { captureState } from "./capture.js";

const PARENT_HTML = `<!DOCTYPE html>
<html><body>
<main>
  <h1>Parent</h1>
  <button>Parent button</button>
  <iframe src="http://tactual.test/frame-a" title="Frame A" name="a"></iframe>
  <iframe src="http://tactual.test/frame-b" title="Frame B" name="b"></iframe>
  <button>After frames</button>
</main>
</body></html>`;

const FRAME_A_HTML = `<!DOCTYPE html>
<html><body>
<h2>Frame A heading</h2>
<button style="width: 100px; height: 40px;">Frame A button</button>
<a href="https://example.com/a">Frame A link</a>
<label for="frame-a-input">Frame A field</label>
<input id="frame-a-input" type="text" aria-describedby="frame-a-help" />
<span id="frame-a-help">Type something here</span>
</body></html>`;

const FRAME_B_HTML = `<!DOCTYPE html>
<html><body>
<h2>Frame B heading</h2>
<button>Frame B button</button>
</body></html>`;

const OOPIF_PARENT_HTML = `<!DOCTYPE html>
<html><body>
<main>
  <h1>Parent checkout</h1>
  <iframe src="http://child.test/payment" title="Payment fields" name="payment"></iframe>
  <button>Review order</button>
</main>
</body></html>`;

const OOPIF_CHILD_HTML = `<!DOCTYPE html>
<html><body>
<main>
  <h2>Payment details</h2>
  <a href="https://pay.example/help">Payment help</a>
  <label for="card-number">Card number</label>
  <input id="card-number" value="4242 4242 4242 4242" />
  <label><input type="checkbox" /> Save card</label>
  <button aria-controls="receipt-dialog" aria-haspopup="dialog">Pay now</button>
  <div id="receipt-dialog" role="dialog" aria-label="Receipt">
    <button>Close receipt</button>
  </div>
</main>
</body></html>`;

async function mockMultiFrame(context: BrowserContext): Promise<void> {
  await context.route("http://tactual.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: PARENT_HTML }),
  );
  await context.route("http://tactual.test/frame-a", (route) =>
    route.fulfill({ contentType: "text/html", body: FRAME_A_HTML }),
  );
  await context.route("http://tactual.test/frame-b", (route) =>
    route.fulfill({ contentType: "text/html", body: FRAME_B_HTML }),
  );
}

describe("captureState (descendFrames)", () => {
  it("stitches iframe targets near their owner with _frame attribution when descendFrames is true", async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await mockMultiFrame(context);
      const page = await context.newPage();
      await page.goto("http://tactual.test/", { waitUntil: "load" });

      const state = await captureState(page, {
        provenance: "scripted",
        descendFrames: true,
      });

      const parentH1 = state.targets.find(
        (t) => t.kind === "heading" && t.name === "Parent",
      );
      expect(parentH1).toBeDefined();
      expect((parentH1 as Record<string, unknown>)._frame).toBeUndefined();

      const frameATargets = state.targets.filter((t) => {
        const f = (t as Record<string, unknown>)._frame as { url?: string } | undefined;
        return f?.url?.endsWith("/frame-a");
      });
      const frameBTargets = state.targets.filter((t) => {
        const f = (t as Record<string, unknown>)._frame as { url?: string } | undefined;
        return f?.url?.endsWith("/frame-b");
      });

      expect(frameATargets.some((t) => t.kind === "heading" && t.name === "Frame A heading")).toBe(true);
      expect(frameATargets.some((t) => t.kind === "button" && t.name === "Frame A button")).toBe(true);
      expect(frameATargets.some((t) => t.kind === "link" && t.name === "Frame A link")).toBe(true);
      expect(frameBTargets.some((t) => t.kind === "heading" && t.name === "Frame B heading")).toBe(true);
      expect(frameBTargets.some((t) => t.kind === "button" && t.name === "Frame B button")).toBe(true);

      const parentButtonIndex = state.targets.findIndex(
        (t) => t.kind === "button" && t.name === "Parent button",
      );
      const frameAHeadingIndex = state.targets.findIndex(
        (t) => t.kind === "heading" && t.name === "Frame A heading",
      );
      const frameBHeadingIndex = state.targets.findIndex(
        (t) => t.kind === "heading" && t.name === "Frame B heading",
      );
      const afterFramesIndex = state.targets.findIndex(
        (t) => t.kind === "button" && t.name === "After frames",
      );
      expect(parentButtonIndex).toBeGreaterThanOrEqual(0);
      expect(frameAHeadingIndex).toBeGreaterThan(parentButtonIndex);
      expect(frameBHeadingIndex).toBeGreaterThan(frameAHeadingIndex);
      expect(afterFramesIndex).toBeGreaterThan(frameBHeadingIndex);

      // IDs should be prefixed to avoid collision with main-frame IDs.
      for (const t of [...frameATargets, ...frameBTargets]) {
        expect(t.id.startsWith("f")).toBe(true);
        expect(t.id).toMatch(/^f\d+\./);
        const frame = (t as Record<string, unknown>)._frame as
          | { ownerRect?: { width?: number; height?: number } }
          | undefined;
        expect(frame?.ownerRect?.width).toBeGreaterThan(0);
        expect(frame?.ownerRect?.height).toBeGreaterThan(0);
      }

      await context.close();
    } finally {
      await browser.close();
    }
  }, 30000);

  it("does not include iframe targets when descendFrames is false", async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await mockMultiFrame(context);
      const page = await context.newPage();
      await page.goto("http://tactual.test/", { waitUntil: "load" });

      const state = await captureState(page, {
        provenance: "scripted",
      });

      const frameTargets = state.targets.filter(
        (t) => (t as Record<string, unknown>)._frame !== undefined,
      );
      expect(frameTargets).toHaveLength(0);
      // Frame A's "Frame A heading" should not be present at all.
      expect(state.targets.some((t) => t.name === "Frame A heading")).toBe(false);

      await context.close();
    } finally {
      await browser.close();
    }
  }, 30000);

  it("enriches frame targets with href, rect, and native control metadata via the frame's scope", async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await mockMultiFrame(context);
      const page = await context.newPage();
      await page.goto("http://tactual.test/", { waitUntil: "load" });

      const state = await captureState(page, {
        provenance: "scripted",
        descendFrames: true,
      });

      const frameATargets = state.targets.filter((t) => {
        const f = (t as Record<string, unknown>)._frame as { url?: string } | undefined;
        return f?.url?.endsWith("/frame-a");
      });

      // _href on the link inside the iframe — proves enrichLinkHrefs ran in
      // the frame's scope (page.getByRole would have returned 0 handles).
      const frameLink = frameATargets.find(
        (t) => t.kind === "link" && t.name === "Frame A link",
      ) as Record<string, unknown> | undefined;
      expect(frameLink?._href).toBe("https://example.com/a");

      // _rect on the iframe button — proves enrichBoundingRects ran in the
      // frame's scope.
      const frameButton = frameATargets.find(
        (t) => t.kind === "button" && t.name === "Frame A button",
      ) as Record<string, unknown> | undefined;
      const rect = frameButton?._rect as { width: number; height: number } | undefined;
      expect(rect?.width).toBeGreaterThan(0);
      expect(rect?.height).toBeGreaterThan(0);

      // _nativeHtmlControl on the iframe input — proves
      // enrichNativeControlMetadata ran in the frame's scope.
      const frameInput = frameATargets.find(
        (t) => t.kind === "formField" && t.name === "Frame A field",
      ) as Record<string, unknown> | undefined;
      expect(frameInput?._nativeHtmlControl).toBe("input");

      // NOTE: aria-describedby enrichment (_description) is NOT asserted
      // here — there's a pre-existing bug in enrichWithAriaReferences that
      // matches by tagName.toLowerCase() ("input") instead of the computed
      // accessible role ("textbox"), so native HTML controls never get
      // their _description populated. The bug is independent of frame
      // scope and would also fail in the main frame; tracked as a separate
      // follow-up rather than mixed into the frame-enrichment change.

      await context.close();
    } finally {
      await browser.close();
    }
  }, 30000);

  it("differentiates state hashes when frames have different content", async () => {
    const browser = await chromium.launch();
    try {
      const context1 = await browser.newContext();
      await mockMultiFrame(context1);
      const page1 = await context1.newPage();
      await page1.goto("http://tactual.test/", { waitUntil: "load" });
      const state1 = await captureState(page1, { descendFrames: true });
      await context1.close();

      const context2 = await browser.newContext();
      await context2.route("http://tactual.test/", (route) =>
        route.fulfill({ contentType: "text/html", body: PARENT_HTML }),
      );
      await context2.route("http://tactual.test/frame-a", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!DOCTYPE html><html><body><h2>Different A heading</h2></body></html>`,
        }),
      );
      await context2.route("http://tactual.test/frame-b", (route) =>
        route.fulfill({ contentType: "text/html", body: FRAME_B_HTML }),
      );
      const page2 = await context2.newPage();
      await page2.goto("http://tactual.test/", { waitUntil: "load" });
      const state2 = await captureState(page2, { descendFrames: true });
      await context2.close();

      expect(state1.snapshotHash).not.toBe(state2.snapshotHash);
    } finally {
      await browser.close();
    }
  }, 30000);

  it("recovers OOPIF frame targets through CDP when frame ariaSnapshot is inaccessible", async () => {
    const browser = await chromium.launch({ args: ["--site-per-process"] });
    try {
      const context = await browser.newContext();
      await context.route("http://parent.test/", (route) =>
        route.fulfill({ contentType: "text/html", body: OOPIF_PARENT_HTML }),
      );
      await context.route("http://child.test/payment", (route) =>
        route.fulfill({ contentType: "text/html", body: OOPIF_CHILD_HTML }),
      );
      const page = await context.newPage();
      await page.goto("http://parent.test/", { waitUntil: "load" });

      const childFrame = page.frames().find((f) => f.url() === "http://child.test/payment");
      expect(childFrame).toBeDefined();
      if (!childFrame) throw new Error("Expected child payment frame");

      // Local Chromium can often ariaSnapshot forced-site-isolation frames, but
      // production OOPIFs can still reject that path. Patch only the child
      // frame's html snapshot call so this test exercises the real CDP fallback
      // deterministically while leaving the browser, frame target, and AX tree
      // untouched.
      const originalLocator = childFrame.locator.bind(childFrame) as typeof childFrame.locator;
      (childFrame as unknown as { locator: typeof childFrame.locator }).locator = ((
        ...args: Parameters<typeof childFrame.locator>
      ): ReturnType<typeof childFrame.locator> => {
        const locator = originalLocator(...args);
        if (args[0] !== "html") return locator;
        return new Proxy(locator, {
          get(target, prop, receiver) {
            if (prop === "ariaSnapshot") {
              return async () => {
                throw new Error("forced inaccessible frame snapshot");
              };
            }
            const value = Reflect.get(target, prop, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as ReturnType<typeof childFrame.locator>;
      }) as typeof childFrame.locator;

      const state = await captureState(page, {
        provenance: "scripted",
        descendFrames: true,
        snapshotDepth: 20,
        minTargets: 1,
      });

      const frameTargets = state.targets.filter((t) => {
        const frame = (t as Record<string, unknown>)._frame as
          | { url?: string; source?: string }
          | undefined;
        return frame?.url === "http://child.test/payment";
      });

      expect(frameTargets.some((t) => t.kind === "heading" && t.name === "Payment details")).toBe(true);
      expect(frameTargets.some((t) => t.kind === "formField" && t.name === "Card number")).toBe(true);
      expect(frameTargets.some((t) => t.kind === "button" && t.name === "Pay now")).toBe(true);
      expect(frameTargets.some((t) => t.kind === "link" && t.name === "Payment help")).toBe(true);
      expect(frameTargets.some((t) => t.kind === "formField" && t.name === "Save card")).toBe(true);
      expect(
        frameTargets.every((t) => {
          const frame = (t as Record<string, unknown>)._frame as { source?: string } | undefined;
          return frame?.source === "cdp";
        }),
      ).toBe(true);
      const help = frameTargets.find((t) => t.kind === "link" && t.name === "Payment help") as
        | Record<string, unknown>
        | undefined;
      expect(help?._href).toBe("https://pay.example/help");

      const card = frameTargets.find((t) => t.kind === "formField" && t.name === "Card number") as
        | Record<string, unknown>
        | undefined;
      expect(card?._nativeHtmlControl).toBe("input");
      expect((card?._rect as { width?: number } | undefined)?.width).toBeGreaterThan(0);

      const saveCard = frameTargets.find((t) => t.kind === "formField" && t.name === "Save card") as
        | Record<string, unknown>
        | undefined;
      expect(saveCard?._attributeValues).toMatchObject({ "aria-checked": "false" });

      const pay = frameTargets.find((t) => t.kind === "button" && t.name === "Pay now") as
        | Record<string, unknown>
        | undefined;
      const relationships = pay?._ariaRelationships as
        | { controls?: Array<{ role: string; name: string }> }
        | undefined;
      expect(relationships?.controls?.[0]).toMatchObject({
        role: "dialog",
        name: "Receipt",
      });
      expect((state as Record<string, unknown>)._framesSkipped).toBeUndefined();

      const parentHeadingIndex = state.targets.findIndex(
        (t) => t.kind === "heading" && t.name === "Parent checkout",
      );
      const paymentHeadingIndex = state.targets.findIndex(
        (t) => t.kind === "heading" && t.name === "Payment details",
      );
      const reviewButtonIndex = state.targets.findIndex(
        (t) => t.kind === "button" && t.name === "Review order",
      );
      expect(parentHeadingIndex).toBeGreaterThanOrEqual(0);
      expect(paymentHeadingIndex).toBeGreaterThan(parentHeadingIndex);
      expect(reviewButtonIndex).toBeGreaterThan(paymentHeadingIndex);

      await context.close();
    } finally {
      await browser.close();
    }
  }, 30000);
});
