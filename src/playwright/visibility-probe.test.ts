import { describe, it, expect } from "vitest";
import { chromium } from "playwright";
import { collectVisibility, type VisibilityRecord, type VisualMode } from "./visibility-probe.js";
import { captureState } from "./capture.js";

const MODES: VisualMode[] = [
  { colorScheme: "light", forcedColors: "none" },
  { colorScheme: "light", forcedColors: "active" },
  { colorScheme: "dark", forcedColors: "none" },
  { colorScheme: "dark", forcedColors: "active" },
];

const PAGE_HTML = `
  <html>
    <body style="background: #fff; color: #000;">
      <main>
        <h1>Visibility test</h1>
        <button id="hardcoded">
          <svg id="hardcoded-icon" fill="#000" width="16" height="16" viewBox="0 0 16 16"><path d="M0 0 L16 16"/></svg>
          Open
        </button>
        <button id="current-color">
          <svg id="current-color-icon" fill="currentColor" width="16" height="16" viewBox="0 0 16 16"><path d="M0 0 L16 16"/></svg>
          Close
        </button>
        <button id="system-color" style="forced-color-adjust: auto;">
          <svg id="system-color-icon" fill="ButtonText" width="16" height="16" viewBox="0 0 16 16"><path d="M0 0 L16 16"/></svg>
          System
        </button>
        <button id="opt-out">
          <svg id="opt-out-icon" fill="#888" style="forced-color-adjust: none;" width="16" height="16" viewBox="0 0 16 16"><path d="M0 0 L16 16"/></svg>
          Opt-out
        </button>
        <button id="text-only">No icon</button>
      </main>
    </body>
  </html>
`;

describe("collectVisibility", () => {
  it("attaches one _visibility record per (target × mode) for icon-bearing targets", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(PAGE_HTML);

    const state = await captureState(page, { provenance: "scripted" });
    const enriched = await collectVisibility(page, state, MODES);
    await browser.close();

    const buttonsWithIcons = enriched.targets.filter(
      (t) => t.role === "button" && t.name && t.name !== "No icon",
    );
    expect(buttonsWithIcons.length).toBeGreaterThan(0);

    for (const t of buttonsWithIcons) {
      const records = (t as Record<string, unknown>)._visibility as VisibilityRecord[] | undefined;
      expect(records).toBeDefined();
      expect(records!.length).toBe(MODES.length);
    }
  }, 30000);

  it("captures the hardcoded fill='#000' icon as fill rgb(0,0,0) across all modes", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(PAGE_HTML);

    const state = await captureState(page, { provenance: "scripted" });
    const enriched = await collectVisibility(page, state, MODES);
    await browser.close();

    const target = enriched.targets.find(
      (t) => t.role === "button" && t.name === "Open",
    );
    const records = (target as Record<string, unknown>)?._visibility as VisibilityRecord[] | undefined;
    expect(records).toBeDefined();

    for (const r of records!) {
      expect(r.fill).toMatch(/rgb\(0,?\s*0,?\s*0\)/);
      expect(r.fillAttr).toBe("#000");
    }
  }, 30000);

  it("captures the currentColor icon with fill === color (HCM-safe)", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(PAGE_HTML);

    const state = await captureState(page, { provenance: "scripted" });
    const enriched = await collectVisibility(page, state, MODES);
    await browser.close();

    const target = enriched.targets.find(
      (t) => t.role === "button" && t.name === "Close",
    );
    const records = (target as Record<string, unknown>)?._visibility as VisibilityRecord[] | undefined;
    expect(records).toBeDefined();

    for (const r of records!) {
      expect(r.fillAttr).toBe("currentColor");
      // Computed fill resolves currentColor → equals computed color.
      expect(r.fill).toBe(r.color);
    }
  }, 30000);

  it("captures forced-color-adjust=none for the opt-out icon", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(PAGE_HTML);

    const state = await captureState(page, { provenance: "scripted" });
    const enriched = await collectVisibility(page, state, MODES);
    await browser.close();

    const target = enriched.targets.find(
      (t) => t.role === "button" && t.name === "Opt-out",
    );
    const records = (target as Record<string, unknown>)?._visibility as VisibilityRecord[] | undefined;
    expect(records).toBeDefined();

    for (const r of records!) {
      expect(r.forcedColorAdjust).toBe("none");
    }
  }, 30000);

  it("flags hasTextLabel=true for icons inside buttons with visible text", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(PAGE_HTML);

    const state = await captureState(page, { provenance: "scripted" });
    const enriched = await collectVisibility(page, state, MODES);
    await browser.close();

    const target = enriched.targets.find(
      (t) => t.role === "button" && t.name === "Open",
    );
    const records = (target as Record<string, unknown>)?._visibility as VisibilityRecord[] | undefined;
    expect(records).toBeDefined();
    for (const r of records!) {
      expect(r.hasTextLabel).toBe(true);
    }
  }, 30000);

  it("does not attach _visibility to text-only targets with no icons", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(PAGE_HTML);

    const state = await captureState(page, { provenance: "scripted" });
    const enriched = await collectVisibility(page, state, MODES);
    await browser.close();

    const target = enriched.targets.find(
      (t) => t.role === "button" && t.name === "No icon",
    );
    const records = (target as Record<string, unknown>)?._visibility as VisibilityRecord[] | undefined;
    expect(records).toBeUndefined();
  }, 30000);

  it("returns the original state when modes is empty", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(PAGE_HTML);

    const state = await captureState(page, { provenance: "scripted" });
    const enriched = await collectVisibility(page, state, []);
    await browser.close();

    expect(enriched).toBe(state);
  }, 30000);

  it("restores default emulation after running (no leaked forced-colors state)", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(PAGE_HTML);

    const state = await captureState(page, { provenance: "scripted" });
    await collectVisibility(page, state, MODES);

    const stillForced = await page.evaluate(
      () => matchMedia("(forced-colors: active)").matches,
    );
    await browser.close();

    expect(stillForced).toBe(false);
  }, 30000);

  // Find a record that should have low contrast (fill black on white bg in dark+forced).
  // In dark+forced, Chromium's Canvas resolves dark; our hardcoded #000 fill stays black.
  // bgColor of nearest non-transparent ancestor depends on the page's body bg in HCM.
  it("attributes icons to the correct owner when buttons share a row container", async () => {
    // Three buttons under the same parent, each with its own SVG.
    // Mirrors Swagger UI's .opblock-summary pattern. Each icon must end up on
    // the correct owner via closest-tagged-ancestor, not bleed across siblings.
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <h1>Row</h1>
        <div class="row">
          <button>
            <svg id="a-icon" fill="#000" width="16" height="16"><path d="M0 0L16 16"/></svg>
            Edit
          </button>
          <button>
            <svg id="b-icon" fill="currentColor" width="16" height="16"><path d="M0 0L16 16"/></svg>
            Copy
          </button>
          <button>
            <svg id="c-icon" fill="ButtonText" width="16" height="16"><path d="M0 0L16 16"/></svg>
            Lock
          </button>
        </div>
      </main>
    `);

    const state = await captureState(page, { provenance: "scripted" });
    const enriched = await collectVisibility(page, state, MODES);
    await browser.close();

    const edit = enriched.targets.find((t) => t.role === "button" && t.name === "Edit");
    const copy = enriched.targets.find((t) => t.role === "button" && t.name === "Copy");
    const lock = enriched.targets.find((t) => t.role === "button" && t.name === "Lock");

    const editRecords = (edit as Record<string, unknown>)?._visibility as VisibilityRecord[] | undefined;
    const copyRecords = (copy as Record<string, unknown>)?._visibility as VisibilityRecord[] | undefined;
    const lockRecords = (lock as Record<string, unknown>)?._visibility as VisibilityRecord[] | undefined;

    // Each button should get exactly its own icon × MODES count, no bleed.
    expect(editRecords?.length).toBe(MODES.length);
    expect(copyRecords?.length).toBe(MODES.length);
    expect(lockRecords?.length).toBe(MODES.length);

    // Edit owns the #000-fill icon; Copy owns currentColor; Lock owns ButtonText.
    expect(editRecords?.[0].fillAttr).toBe("#000");
    expect(copyRecords?.[0].fillAttr).toBe("currentColor");
    expect(lockRecords?.[0].fillAttr).toBe("ButtonText");
  }, 30000);

  it("removes its data-tactual-target-id tags after running", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <h1>Cleanup</h1>
        <button><svg fill="#000" width="16" height="16"><path d="M0 0L16 16"/></svg> Open</button>
      </main>
    `);

    const state = await captureState(page, { provenance: "scripted" });
    await collectVisibility(page, state, MODES);

    const remaining = await page.evaluate(() =>
      document.querySelectorAll("[data-tactual-target-id]").length,
    );
    await browser.close();
    expect(remaining).toBe(0);
  }, 30000);

  it("hardcoded-#000 icon has fill rgb(0,0,0) in all modes (visibility-determining baseline)", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(PAGE_HTML);

    const state = await captureState(page, { provenance: "scripted" });
    const enriched = await collectVisibility(page, state, MODES);
    await browser.close();

    const target = enriched.targets.find(
      (t) => t.role === "button" && t.name === "Open",
    );
    const records = (target as Record<string, unknown>)?._visibility as VisibilityRecord[] | undefined;
    expect(records).toBeDefined();
    const darkForced = records!.find(
      (r) => r.mode.colorScheme === "dark" && r.mode.forcedColors === "active",
    );
    expect(darkForced).toBeDefined();
    // The fill stays black across all modes — contrast computation in finding-builder
    // will compare this against the bgColor (which becomes Canvas-resolved in HCM).
    expect(darkForced!.fill).toMatch(/rgb\(0,?\s*0,?\s*0\)/);
  }, 30000);
});
