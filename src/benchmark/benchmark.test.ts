import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { resolve } from "path";
import { captureState } from "../playwright/capture.js";
import { analyze } from "../core/analyzer.js";
import { genericMobileWebSrV0 } from "../profiles/generic-mobile.js";
import { formatReport } from "../reporters/index.js";
import { runBenchmarkSuite, formatBenchmarkResults } from "./runner.js";
import { publicFixturesSuite } from "./suites/public-fixtures.js";

describe("benchmarks", { timeout: 120000 }, () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("public fixtures suite passes all cases and comparisons", async () => {
    const result = await runBenchmarkSuite(publicFixturesSuite, browser);

    // Log results for visibility
    const output = formatBenchmarkResults(result);
    console.log(output);

    // All cases should pass
    for (const c of result.cases) {
      const failedAssertions = c.assertionResults.filter((a) => !a.passed);
      if (failedAssertions.length > 0) {
        console.log(`Failed case: ${c.caseName}`);
        for (const a of failedAssertions) {
          console.log(`  ${a.message}`);
        }
      }
      expect(c.passed, `Case "${c.caseName}" should pass`).toBe(true);
    }

    // All comparisons should pass
    for (const c of result.comparisons) {
      expect(c.passed, `Comparison "${c.comparisonName}" should pass: ${c.message}`).toBe(true);
    }

    expect(result.totalFailed).toBe(0);
  });
});

describe("score stability", { timeout: 30000 }, () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("produces identical scores for the same page analyzed twice", async () => {
    const page1 = await browser.newPage();
    await page1.goto(`file://${resolve("fixtures/good-page.html")}`);
    const state1 = await captureState(page1);
    await page1.close();

    const page2 = await browser.newPage();
    await page2.goto(`file://${resolve("fixtures/good-page.html")}`);
    const state2 = await captureState(page2);
    await page2.close();

    const result1 = analyze([state1], genericMobileWebSrV0, { name: "run1" });
    const result2 = analyze([state2], genericMobileWebSrV0, { name: "run2" });

    // Same number of findings
    expect(result1.findings.length).toBe(result2.findings.length);

    // Same scores for each target
    for (let i = 0; i < result1.findings.length; i++) {
      expect(result1.findings[i].scores.overall).toBe(
        result2.findings[i].scores.overall,
      );
      expect(result1.findings[i].scores.discoverability).toBe(
        result2.findings[i].scores.discoverability,
      );
      expect(result1.findings[i].scores.reachability).toBe(
        result2.findings[i].scores.reachability,
      );
    }

    // Same edge count
    expect(result1.metadata.edgeCount).toBe(result2.metadata.edgeCount);
  });

  it("produces deterministic graph edge counts", async () => {
    const page = await browser.newPage();
    await page.goto(`file://${resolve("fixtures/good-page.html")}`);
    const state = await captureState(page);
    await page.close();

    const result1 = analyze([state], genericMobileWebSrV0);
    const result2 = analyze([state], genericMobileWebSrV0);

    expect(result1.metadata.edgeCount).toBe(result2.metadata.edgeCount);
    expect(result1.metadata.targetCount).toBe(result2.metadata.targetCount);
    expect(result1.metadata.stateCount).toBe(result2.metadata.stateCount);
  });

  it("produces valid SARIF output", async () => {
    const page = await browser.newPage();
    await page.goto(`file://${resolve("fixtures/bad-page.html")}`);
    const state = await captureState(page);
    await page.close();

    const result = analyze([state], genericMobileWebSrV0, { name: "sarif-test" });
    const sarif = formatReport(result, "sarif");

    // Must be valid JSON
    const parsed = JSON.parse(sarif);

    // SARIF structure
    expect(parsed.$schema).toContain("sarif");
    expect(parsed.version).toBe("2.1.0");
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0].tool.driver.name).toBe("Tactual");
    expect(parsed.runs[0].results.length).toBeGreaterThan(0);

    // Each result should have required fields
    for (const r of parsed.runs[0].results) {
      expect(r.ruleId).toMatch(/^tactual\//);
      expect(r.level).toMatch(/^(error|warning|note)$/);
      expect(r.message.text.length).toBeGreaterThan(0);
    }
  });

  it("produces valid markdown output", async () => {
    const page = await browser.newPage();
    await page.goto(`file://${resolve("fixtures/good-page.html")}`);
    const state = await captureState(page);
    await page.close();

    const result = analyze([state], genericMobileWebSrV0);
    const md = formatReport(result, "markdown");

    expect(md).toContain("# Tactual Analysis");
    expect(md).toContain("## Summary");
    expect(md).toContain("| Severity | Count |");
  });
});
