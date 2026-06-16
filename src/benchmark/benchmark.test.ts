import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "path";
import { existsSync } from "fs";
import { captureState } from "../playwright/capture.js";
import { analyze } from "../core/analyzer.js";
import { genericMobileWebSrV0 } from "../profiles/generic-mobile.js";
import { formatReport } from "../reporters/index.js";
import { runAnalyzeUrl } from "../pipeline/analyze-url.js";
import { runBenchmarkSuite, formatBenchmarkResults } from "./runner.js";
import { publicFixturesSuite } from "./suites/public-fixtures.js";
import { stressFixturesSuite } from "./suites/stress-fixtures.js";
import { multiProfileSuite } from "./suites/multi-profile.js";

const SPA_FRAME_HTML = `<!DOCTYPE html>
<html><body>
<main>
  <h2>Embedded checkout</h2>
  <div style="height: 850px;">Lazy prelude</div>
  <div id="lazy-zone" style="height: 40px;"></div>
</main>
<script>
  let added = 0;
  new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting || added) return;
    added = 1;
    const button = document.createElement("button");
    button.textContent = "Authorize embedded payment";
    document.querySelector("main").appendChild(button);
  }).observe(document.getElementById("lazy-zone"));
</script>
</body></html>`;

function spaShellHtml(frameUrl: string): string {
  return `<!DOCTYPE html>
<html><body>
<main>
  <h1>Admin shell</h1>
  <nav aria-label="Workspace navigation">
    ${Array.from({ length: 16 }, (_, i) => `<a href="#n-${i}">Workspace nav ${i + 1}</a>`).join("\n")}
  </nav>
  <button aria-controls="billing-panel" aria-expanded="true">Open billing tools</button>
  <section id="billing-panel" role="region" aria-label="Billing tools">
    <button>Rotate invoice token</button>
  </section>
  <div role="tablist" aria-label="Account sections">
    <button role="tab" aria-selected="true">Overview</button>
    <button role="tab" aria-selected="false">Invoices</button>
  </div>
  <iframe src="${frameUrl}" title="Embedded checkout"></iframe>
</main>
<script>setTimeout(() => history.replaceState({}, "", "/ready"), 25);</script>
</body></html>`;
}

describe("benchmark fixture packaging", () => {
  it("suites resolve fixture files independently of the current working directory", () => {
    for (const suite of [publicFixturesSuite, stressFixturesSuite, multiProfileSuite]) {
      for (const benchCase of suite.cases) {
        if (benchCase.source.type !== "file") continue;
        expect(benchCase.source.path).toMatch(/fixtures[/\\].+\.html$/);
        expect(existsSync(benchCase.source.path), benchCase.source.path).toBe(true);
      }
    }
  });
});

describe("benchmarks", { timeout: 120000 }, () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("public fixtures suite passes all cases and comparisons", async () => {
    const result = await runBenchmarkSuite(publicFixturesSuite, browser, undefined, 8);

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

describe("pipeline benchmark coverage", { timeout: 60000 }, () => {
  it("keeps hard SPA capture helpers working together", async () => {
    await withSpaBenchmarkServer(async ({ mainUrl, frameUrl }) => {
      const { result, routeChanges } = await runAnalyzeUrl({
        url: mainUrl,
        profileId: "generic-mobile-web-sr-v0",
        waitForSelector: "main",
        detectRoutes: true,
        descendFrames: true,
        autoScroll: true,
        checkVisibility: false,
        timeout: 10000,
      });

      const names = new Set(result.states[0].targets.map((target) => target.name));
      expect(names.has("Rotate invoice token")).toBe(true);
      expect(names.has("Invoices")).toBe(true);
      expect(names.has("Authorize embedded payment")).toBe(true);
      expect(
        result.states[0].targets.some((target) => {
          const frame = (target as Record<string, unknown>)._frame as
            | { url?: string }
            | undefined;
          return target.name === "Authorize embedded payment" && frame?.url === frameUrl;
        }),
      ).toBe(true);
      expect(routeChanges?.some((event) => event.kind === "replaceState")).toBe(true);
      expect(result.diagnostics.some((diagnostic) => diagnostic.code === "auto-scrolled")).toBe(true);
      expect(result.diagnostics.some((diagnostic) => diagnostic.code === "frames-descended")).toBe(true);
    });
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

async function withSpaBenchmarkServer<T>(
  fn: (urls: { mainUrl: string; frameUrl: string }) => Promise<T>,
): Promise<T> {
  const frameServer = createServer((req, res) => {
    if (req.url !== "/frame") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(SPA_FRAME_HTML);
  });

  let frameListening = false;
  let mainServer: Server | undefined;
  let mainListening = false;
  try {
    const frameOrigin = await listenServer(frameServer);
    frameListening = true;
    const frameUrl = `${frameOrigin}/frame`;
    mainServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(spaShellHtml(frameUrl));
    });
    const mainOrigin = await listenServer(mainServer);
    mainListening = true;

    return await fn({ mainUrl: `${mainOrigin}/`, frameUrl });
  } finally {
    await Promise.all([
      mainListening && mainServer ? closeServer(mainServer) : Promise.resolve(),
      frameListening ? closeServer(frameServer) : Promise.resolve(),
    ]);
  }
}

function listenServer(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
