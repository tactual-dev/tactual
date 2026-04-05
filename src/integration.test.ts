import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { captureState } from "./playwright/capture.js";
import { analyze } from "./core/analyzer.js";
import { genericMobileWebSrV0 } from "./profiles/generic-mobile.js";
import { formatReport } from "./reporters/index.js";
import { resolve } from "path";

describe("integration: end-to-end analysis", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("analyzes a well-structured page and produces high scores", async () => {
    const page = await browser.newPage();
    const filePath = resolve("fixtures/good-page.html");
    await page.goto(`file://${filePath}`);

    const state = await captureState(page, { provenance: "scripted" });
    await page.close();

    expect(state.targets.length).toBeGreaterThan(5);

    // Should find headings, landmarks, links, buttons, form fields
    const kinds = new Set(state.targets.map((t) => t.kind));
    expect(kinds.has("heading")).toBe(true);
    expect(kinds.has("landmark")).toBe(true);
    expect(kinds.has("link")).toBe(true);
    expect(kinds.has("button")).toBe(true);

    const result = analyze([state], genericMobileWebSrV0, { name: "good-page" });

    expect(result.findings.length).toBeGreaterThan(5);
    expect(result.metadata.edgeCount).toBeGreaterThan(10);

    // Average score should be reasonably high for a well-structured page
    const avgScore =
      result.findings.reduce((sum, f) => sum + f.scores.overall, 0) /
      result.findings.length;
    expect(avgScore).toBeGreaterThan(60);
  });

  it("analyzes a poorly structured page and produces lower scores", async () => {
    const page = await browser.newPage();
    const filePath = resolve("fixtures/bad-page.html");
    await page.goto(`file://${filePath}`);

    const state = await captureState(page, { provenance: "scripted" });
    await page.close();

    const result = analyze([state], genericMobileWebSrV0, { name: "bad-page" });

    // Bad page should have fewer structured targets
    const headings = state.targets.filter((t) => t.kind === "heading");
    const landmarks = state.targets.filter((t) => t.kind === "landmark");

    // The bad page has no headings and no semantic landmarks
    expect(headings.length).toBe(0);
    expect(landmarks.length).toBe(0);

    // Should still find some targets (links, inputs)
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("good page scores higher than bad page on average", async () => {
    const goodPage = await browser.newPage();
    await goodPage.goto(`file://${resolve("fixtures/good-page.html")}`);
    const goodState = await captureState(goodPage);
    await goodPage.close();

    const badPage = await browser.newPage();
    await badPage.goto(`file://${resolve("fixtures/bad-page.html")}`);
    const badState = await captureState(badPage);
    await badPage.close();

    const goodResult = analyze([goodState], genericMobileWebSrV0, { name: "good" });
    const badResult = analyze([badState], genericMobileWebSrV0, { name: "bad" });

    const goodAvg =
      goodResult.findings.reduce((sum, f) => sum + f.scores.overall, 0) /
      goodResult.findings.length;
    const badAvg =
      badResult.findings.reduce((sum, f) => sum + f.scores.overall, 0) /
      badResult.findings.length;

    expect(goodAvg).toBeGreaterThan(badAvg);
  });

  it("produces valid report output in all formats", async () => {
    const page = await browser.newPage();
    await page.goto(`file://${resolve("fixtures/good-page.html")}`);
    const state = await captureState(page);
    await page.close();

    const result = analyze([state], genericMobileWebSrV0);

    const json = formatReport(result, "json");
    expect(() => JSON.parse(json)).not.toThrow();

    const md = formatReport(result, "markdown");
    expect(md).toContain("# Tactual Analysis");

    const console = formatReport(result, "console");
    expect(console).toContain("Tactual Analysis");
  });
});
