import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { simulateCvd, contrastWithCvd, detectCvdContrastIssues } from "./cvd-simulation.js";

describe("simulateCvd (pure)", () => {
  it("preserves white and black for all CVD types", () => {
    const white = { r: 255, g: 255, b: 255 };
    const black = { r: 0, g: 0, b: 0 };
    for (const cvd of ["deuteranopia", "protanopia", "tritanopia"] as const) {
      const wOut = simulateCvd(white, cvd);
      const bOut = simulateCvd(black, cvd);
      expect(wOut.r).toBeGreaterThan(250);
      expect(wOut.g).toBeGreaterThan(250);
      expect(wOut.b).toBeGreaterThan(250);
      expect(bOut.r).toBeLessThan(5);
      expect(bOut.g).toBeLessThan(5);
      expect(bOut.b).toBeLessThan(5);
    }
  });

  it("collapses red and green to similar perceived colors under deuteranopia", () => {
    // Classic red-green confusion: a deuteranope sees pure red and pure green
    // as similar muddy yellows. The CVD-transformed pair should be much
    // closer to each other than the originals.
    const red = { r: 255, g: 0, b: 0 };
    const green = { r: 0, g: 255, b: 0 };
    const redD = simulateCvd(red, "deuteranopia");
    const greenD = simulateCvd(green, "deuteranopia");

    const origDist =
      Math.abs(red.r - green.r) + Math.abs(red.g - green.g) + Math.abs(red.b - green.b);
    const cvdDist =
      Math.abs(redD.r - greenD.r) + Math.abs(redD.g - greenD.g) + Math.abs(redD.b - greenD.b);

    // Original RGB distance is 510; CVD-collapsed should be much smaller
    // (deuteranopia perceives both as muddy yellow-green; precise distance
    // depends on gamma + matrix coefficients).
    expect(origDist).toBe(510);
    expect(cvdDist).toBeLessThan(300);
  });

  it("collapses blue/yellow under tritanopia (S-cone deficiency)", () => {
    const blue = { r: 0, g: 0, b: 255 };
    const yellow = { r: 255, g: 255, b: 0 };
    const blueT = simulateCvd(blue, "tritanopia");
    const yellowT = simulateCvd(yellow, "tritanopia");

    // Tritanopia confuses blue/yellow more than red/green; verify the
    // direction of the shift: blue moves toward green-cyan, yellow moves
    // toward pinkish.
    expect(blueT.g).toBeGreaterThan(blue.g); // blue gains green channel
    expect(yellowT.b).toBeGreaterThan(yellow.b); // yellow gains blue channel
  });

  it("clamps output channels to [0, 255]", () => {
    // Pathological input that could overflow without clamping.
    const out = simulateCvd({ r: 300, g: -50, b: 999 }, "deuteranopia");
    expect(out.r).toBeGreaterThanOrEqual(0);
    expect(out.r).toBeLessThanOrEqual(255);
    expect(out.g).toBeGreaterThanOrEqual(0);
    expect(out.g).toBeLessThanOrEqual(255);
    expect(out.b).toBeGreaterThanOrEqual(0);
    expect(out.b).toBeLessThanOrEqual(255);
  });
});

describe("contrastWithCvd (pure)", () => {
  it("matches normal-vision contrast for white-on-black (no color info to drop)", () => {
    const white = { r: 255, g: 255, b: 255 };
    const black = { r: 0, g: 0, b: 0 };
    const c = contrastWithCvd(white, black, "deuteranopia");
    expect(c).toBeGreaterThan(20); // ~21:1 for true black/white
  });

  it("flags red-on-green as low contrast under deuteranopia even if it's fine for normal vision", () => {
    // Bright red (#dd2222) on bright green (#22dd22) — ratio ~2.5:1 (low for
    // normal vision too, BUT comparable greens/reds at higher luminances
    // can be designed to pass). For severe deuteranopia both collapse to
    // similar-luminance yellows so the ratio drops near 1.
    const red = { r: 0xdd, g: 0x22, b: 0x22 };
    const green = { r: 0x22, g: 0xdd, b: 0x22 };
    const cvd = contrastWithCvd(red, green, "deuteranopia");
    expect(cvd).toBeLessThan(2.0);
  });
});

describe("detectCvdContrastIssues (integration)", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  async function mock(context: BrowserContext, body: string): Promise<void> {
    await context.route("http://tactual.test/", (route) =>
      route.fulfill({ contentType: "text/html", body }),
    );
  }

  it("flags red text on light-yellow background (passes normal vision, fails deuteranopia)", async () => {
    // #cc0000 on #ffff99: ~5.4:1 normal contrast (passes WCAG AA at 18px)
    // ~2.4:1 under deuteranopia (red shifts to yellow-greenish, collapsing
    // toward the yellow background).
    const HTML = `<!DOCTYPE html><html><body>
      <p style="color:#cc0000; background:#ffff99; font-size:18px; padding:20px;">
        Important warning text
      </p>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await detectCvdContrastIssues(page);
    await context.close();

    // Should detect the red/green failure under deuteranopia and protanopia
    // (both collapse red/green) but NOT tritanopia (blue/yellow axis).
    expect(result.byType.deuteranopia.count).toBeGreaterThan(0);
    expect(result.byType.protanopia.count).toBeGreaterThan(0);
    expect(result.totalUniqueElements).toBeGreaterThan(0);
  }, 30000);

  it("does NOT double-count elements that already fail normal contrast", async () => {
    // Light-grey text on white: ~2.5:1 normal contrast (already fails
    // WCAG). Such elements are surfaced by detectLowContrastText and
    // must not also appear in the CVD diagnostic.
    const HTML = `<!DOCTYPE html><html><body style="background:#fff;">
      <p style="color:#aaaaaa; font-size:18px;">Already-failing text</p>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await detectCvdContrastIssues(page);
    await context.close();

    // 0 unique elements — every CVD-failing element here also fails
    // normal contrast and is therefore caught by low-contrast-text.
    expect(result.totalUniqueElements).toBe(0);
  }, 30000);

  it("does NOT flag white-on-black (passes all CVD types)", async () => {
    const HTML = `<!DOCTYPE html><html><body style="background:#000;">
      <p style="color:#fff; font-size:18px; padding:20px;">High contrast white text</p>
    </body></html>`;
    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });

    const result = await detectCvdContrastIssues(page);
    await context.close();

    expect(result.totalUniqueElements).toBe(0);
  }, 30000);
});
