import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

const script = resolve(__dirname, "../../scripts/known-pages-corpus.mjs");
const outDir = resolve(__dirname, "../../__test_known_pages_corpus");

describe("known-pages corpus script", () => {
  afterEach(() => {
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("shows help without running live pages", () => {
    const stdout = execFileSync(process.execPath, [script, "--help"], {
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });

    expect(stdout).toContain("Known-pages live benchmark");
    expect(stdout).toContain("--include-capture-probes");
    expect(stdout).toContain("--report-from");
  });

  it("regenerates a categorized report from saved run results", () => {
    mkdirSync(outDir, { recursive: true });
    const runPath = resolve(outDir, "run-results.json");
    writeFileSync(runPath, JSON.stringify(makeRunFixture(), null, 2));

    const stdout = execFileSync(process.execPath, [
      script,
      "--report-from",
      runPath,
      "--out",
      outDir,
    ], {
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });

    const report = readFileSync(resolve(outDir, "REPORT.md"), "utf-8");
    expect(stdout).toContain("Known-pages report written");
    expect(report).toContain("Finding Category Rollup");
    expect(report).toContain("component-implementation: 1");
    expect(report).toContain("composite-widget-interop: 1");
    expect(report).toContain("docs-shell-navigation: 1");
    expect(report).toContain("Diagnostic Category Rollup");
    expect(report).toContain("capture-helper");
    expect(report).toContain("Capture-Quality Runs");
    expect(report).toContain("blocked-by-bot-protection");
  });
});

function makeRunFixture(): unknown {
  return {
    schema: "tactual-known-pages-corpus@1",
    generatedAt: "2026-06-16T00:00:00.000Z",
    results: [
      {
        name: "component-docs",
        url: "https://example.test/component",
        category: "component-library-docs",
        focus: "combobox",
        status: "completed",
        seconds: 1.2,
        analysis: {
          states: [
            {
              id: "initial",
              targets: [
                { id: "main", kind: "landmark", role: "main", name: "Main" },
                { id: "combo", kind: "formField", role: "combobox", name: "Choose" },
                { id: "icon", kind: "button", role: "button", name: "" },
              ],
            },
          ],
          findings: [
            {
              targetId: "icon",
              severity: "high",
              scores: { overall: 42 },
              penalties: ["Target has no accessible name - screen-reader users cannot identify it"],
              suggestedFixes: ["Add an aria-label."],
            },
            {
              targetId: "combo",
              severity: "moderate",
              scores: { overall: 61 },
              penalties: ["Interop risk: combobox behavior varies across AT/browser pairs"],
              suggestedFixes: ["Verify critical flows."],
            },
            {
              targetId: "main",
              severity: "acceptable",
              scores: { overall: 82 },
              penalties: ["Target is not efficiently reachable via heading or landmark navigation"],
              suggestedFixes: ["Add a heading near the target."],
            },
          ],
          diagnostics: [
            { level: "info", code: "auto-scrolled", message: "Auto-scrolled before capture." },
            { level: "info", code: "spa-route-changes", message: "Detected route changes." },
            { level: "warning", code: "no-skip-link", message: "No skip-to-content link found." },
          ],
          metadata: {
            targetCount: 3,
            findingCount: 3,
          },
        },
      },
      {
        name: "apg-live",
        url: "https://www.w3.org/WAI/ARIA/apg/",
        category: "capture-quality-probe",
        focus: "dialog",
        captureQualityOnly: true,
        status: "completed",
        seconds: 0.5,
        analysis: {
          states: [{ id: "initial", targets: [{ id: "blocked", kind: "heading", name: "Just a moment" }] }],
          findings: [],
          diagnostics: [
            {
              level: "error",
              code: "blocked-by-bot-protection",
              message: "Page appears to be a bot-protection challenge.",
            },
          ],
          metadata: { targetCount: 1, findingCount: 0 },
        },
      },
    ],
  };
}
