import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { captureState } from "./playwright/capture.js";
import { analyze } from "./core/analyzer.js";
import { genericMobileWebSrV0 } from "./profiles/generic-mobile.js";
import { resolve } from "path";

const FILTERABLE = `file://${resolve("fixtures/filterable-page.html")}`;

describe("integration: selector-based exclusions", { timeout: 30000 }, () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("captures all targets without exclusions", async () => {
    const page = await browser.newPage();
    await page.goto(FILTERABLE);
    const state = await captureState(page);
    await page.close();

    const allNames = state.targets.map((t) => t.name);
    expect(allNames).toContain("Konami Code Activated!");
    expect(allNames).toContain("Clear Cache");
    expect(allNames).toContain("Chat with us");
    expect(allNames).toContain("Add to Cart");
    expect(allNames).toContain("Submit");
  });

  it("excludes easter egg targets by CSS selector", async () => {
    const page = await browser.newPage();
    await page.goto(FILTERABLE);
    const state = await captureState(page, {
      excludeSelectors: ["#easter-egg"],
    });
    await page.close();

    const names = state.targets.map((t) => t.name);
    expect(names).not.toContain("Konami Code Activated!");
    expect(names).not.toContain("Secret Page");
    // Other targets still present
    expect(names).toContain("Add to Cart");
    expect(names).toContain("Submit");
  });

  it("excludes admin panel by CSS selector", async () => {
    const page = await browser.newPage();
    await page.goto(FILTERABLE);
    const state = await captureState(page, {
      excludeSelectors: [".admin-only"],
    });
    await page.close();

    const names = state.targets.map((t) => t.name);
    expect(names).not.toContain("Admin Debug");
    expect(names).not.toContain("Clear Cache");
    expect(names).not.toContain("Toggle Feature Flags");
    expect(names).toContain("Add to Cart");
  });

  it("excludes multiple selectors at once", async () => {
    const page = await browser.newPage();
    await page.goto(FILTERABLE);
    const state = await captureState(page, {
      excludeSelectors: ["#easter-egg", ".admin-only", ".external-widget"],
    });
    await page.close();

    const names = state.targets.map((t) => t.name);
    expect(names).not.toContain("Konami Code Activated!");
    expect(names).not.toContain("Clear Cache");
    expect(names).not.toContain("Chat with us");
    // Core content still present
    expect(names).toContain("Add to Cart");
    expect(names).toContain("Submit");
    expect(names).toContain("Products");
  });

  it("excluded targets don't affect scoring of remaining targets", async () => {
    const page1 = await browser.newPage();
    await page1.goto(FILTERABLE);
    const stateAll = await captureState(page1);
    await page1.close();

    const page2 = await browser.newPage();
    await page2.goto(FILTERABLE);
    const stateFiltered = await captureState(page2, {
      excludeSelectors: ["#easter-egg", ".admin-only", ".external-widget"],
    });
    await page2.close();

    const resultAll = analyze([stateAll], genericMobileWebSrV0, { name: "all" });
    const resultFiltered = analyze([stateFiltered], genericMobileWebSrV0, { name: "filtered" });

    // Filtered should have fewer findings
    expect(resultFiltered.findings.length).toBeLessThan(resultAll.findings.length);

    // Core targets should still be scored
    const filteredIds = resultFiltered.findings.map((f) => f.targetId);
    expect(filteredIds.length).toBeGreaterThan(5);
  });
});

describe("integration: name-pattern exclusions", { timeout: 30000 }, () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("excludes targets matching name patterns", async () => {
    const page = await browser.newPage();
    await page.goto(FILTERABLE);
    const state = await captureState(page);
    await page.close();

    const result = analyze([state], genericMobileWebSrV0, {
      name: "filtered",
      filter: { exclude: ["Konami*", "Admin*", "Clear*", "Toggle*", "Chat*", "Secret*"] },
    });

    const names = result.findings.map((f) => {
      const target = result.states[0].targets.find(
        (t) => f.targetId === t.id,
      );
      return target?.name;
    });
    expect(names).not.toContain("Konami Code Activated!");
    expect(names).not.toContain("Clear Cache");
  });

  it("focuses analysis on main landmark only", async () => {
    const page = await browser.newPage();
    await page.goto(FILTERABLE);
    const state = await captureState(page);
    await page.close();

    const result = analyze([state], genericMobileWebSrV0, {
      name: "focused",
      filter: { focus: ["main"] },
    });

    // Should only have targets that are within or are <main>
    // No banner, no contentinfo, no navigation targets
    const kinds = new Set(result.states[0].targets.map((t) => t.role));
    expect(kinds.has("banner")).toBe(false);
    expect(kinds.has("contentinfo")).toBe(false);
  });

  it("threshold flag causes exit code behavior", async () => {
    const page = await browser.newPage();
    await page.goto(FILTERABLE);
    const state = await captureState(page);
    await page.close();

    const result = analyze([state], genericMobileWebSrV0, { name: "test" });

    // Import checkThreshold
    const { checkThreshold } = await import("./core/filter.js");

    const high = checkThreshold(result.findings, 50);
    expect(high.passed).toBe(true);

    const impossible = checkThreshold(result.findings, 99);
    expect(impossible.passed).toBe(false);
  });

  it("suppresses specific diagnostics", async () => {
    const page = await browser.newPage();
    await page.goto(`file://${resolve("fixtures/bad-page.html")}`);
    const state = await captureState(page);
    await page.close();

    const resultUnsuppressed = analyze([state], genericMobileWebSrV0, { name: "test" });
    const resultSuppressed = analyze([state], genericMobileWebSrV0, {
      name: "test",
      filter: { suppress: ["no-headings", "no-landmarks"] },
    });

    const unsuppressedCodes = resultUnsuppressed.diagnostics.map((d) => d.code);
    const suppressedCodes = resultSuppressed.diagnostics.map((d) => d.code);

    // Bad page should have no-headings diagnostic
    if (unsuppressedCodes.includes("no-headings")) {
      expect(suppressedCodes).not.toContain("no-headings");
    }
  });

  it("limits findings with maxFindings", async () => {
    const page = await browser.newPage();
    await page.goto(`file://${resolve("fixtures/good-page.html")}`);
    const state = await captureState(page);
    await page.close();

    const result = analyze([state], genericMobileWebSrV0, {
      name: "test",
      filter: { maxFindings: 3 },
    });

    expect(result.findings.length).toBeLessThanOrEqual(3);
  });

  it("filters by minimum severity", async () => {
    const page = await browser.newPage();
    await page.goto(`file://${resolve("fixtures/bad-page.html")}`);
    const state = await captureState(page);
    await page.close();

    const result = analyze([state], genericMobileWebSrV0, {
      name: "test",
      filter: { minSeverity: "moderate" },
    });

    // Should only have moderate or worse
    for (const f of result.findings) {
      expect(["severe", "high", "moderate"]).toContain(f.severity);
    }
  });
});
