import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { runBenchmarkSuite, formatBenchmarkResults } from "./runner.js";
import { stressFixturesSuite } from "./suites/stress-fixtures.js";
import { multiProfileSuite } from "./suites/multi-profile.js";

describe("stress fixtures", { timeout: 120000 }, () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("stress fixtures suite passes all cases and comparisons", async () => {
    const result = await runBenchmarkSuite(stressFixturesSuite, browser, undefined, 8);

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

describe("multi-profile", { timeout: 120000 }, () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("multi-profile suite passes all cases", async () => {
    const result = await runBenchmarkSuite(multiProfileSuite, browser, undefined, 8);

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
