import { describe, it, expect } from "vitest";
import { formatReport } from "./index.js";
import { formatJSON } from "./json.js";
import { formatMarkdown } from "./markdown.js";
import { formatConsole } from "./console.js";
import { formatSARIF } from "./sarif.js";
import type { AnalysisResult, Finding } from "../core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(findings: Finding[], overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    flow: { id: "f1", name: "test", states: ["s1"], profile: "generic-mobile-web-sr-v0", timestamp: Date.now() },
    states: [{
      id: "s1", url: "https://example.com", route: "/", snapshotHash: "h1",
      interactiveHash: "ih1", openOverlays: [], targets: [], timestamp: Date.now(), provenance: "scripted" as const,
    }],
    findings,
    diagnostics: [],
    metadata: {
      version: "0.1.0", profile: "generic-mobile-web-sr-v0", duration: 100,
      stateCount: 1, targetCount: findings.length, edgeCount: 0,
    },
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    targetId: overrides.targetId ?? "target-1",
    profile: "generic-mobile-web-sr-v0",
    scores: { discoverability: 80, reachability: 70, operability: 90, recovery: 85, interopRisk: 0, overall: 80 },
    severity: "acceptable" as const,
    bestPath: ["nextHeading: Main", "nextItem: Button"],
    alternatePaths: [],
    penalties: [],
    suggestedFixes: [],
    confidence: 0.8,
    ...overrides,
  };
}

/** Run a result through all four formatters and return their outputs. */
function allFormats(result: AnalysisResult) {
  return {
    json: formatJSON(result),
    markdown: formatMarkdown(result),
    console: formatConsole(result),
    sarif: formatSARIF(result),
  };
}

/** Assert basic validity across all four format outputs. */
function assertAllValid(outputs: ReturnType<typeof allFormats>) {
  for (const [name, output] of Object.entries(outputs)) {
    expect(output, `${name} output should be a non-empty string`).toBeTruthy();
    expect(typeof output, `${name} output should be a string`).toBe("string");
    expect(output.length, `${name} output should not be empty`).toBeGreaterThan(0);
  }
  // JSON and SARIF must be parseable
  expect(() => JSON.parse(outputs.json), "JSON output should be parseable").not.toThrow();
  expect(() => JSON.parse(outputs.sarif), "SARIF output should be parseable").not.toThrow();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reporters edge cases", () => {

  // -------------------------------------------------------------------------
  // Empty / minimal results
  // -------------------------------------------------------------------------

  describe("empty and minimal results", () => {
    it("handles empty findings without crashing", () => {
      const result = makeResult([]);
      const outputs = allFormats(result);
      assertAllValid(outputs);

      // Markdown should say "No findings."
      expect(outputs.markdown).toContain("No findings");

      // SARIF should have zero results
      const sarif = JSON.parse(outputs.sarif);
      expect(sarif.runs[0].results).toHaveLength(0);

      // JSON should have zero total findings
      const json = JSON.parse(outputs.json);
      expect(json.worstFindings).toHaveLength(0);
      expect(json.totalFindings).toBe(0);
    });

    it("handles a single finding through all formats", () => {
      const result = makeResult([makeFinding()]);
      const outputs = allFormats(result);
      assertAllValid(outputs);

      // JSON preserves the finding in worstFindings
      const json = JSON.parse(outputs.json);
      expect(json.worstFindings).toHaveLength(1);
      expect(json.worstFindings[0].targetId).toBe("target-1");

      // Console mentions the target
      expect(outputs.console).toContain("target-1");

      // Markdown mentions the target
      expect(outputs.markdown).toContain("target-1");
    });
  });

  // -------------------------------------------------------------------------
  // Special characters in target names/IDs
  // -------------------------------------------------------------------------

  describe("special characters in target names", () => {
    it("handles pipe characters without breaking markdown tables", () => {
      const finding = makeFinding({ targetId: "nav | main" });
      const result = makeResult([finding]);
      const outputs = allFormats(result);
      assertAllValid(outputs);

      // The markdown score table rows should each have exactly 5 data columns.
      // Split lines, find the data row (the one after the alignment row :-:).
      const lines = outputs.markdown.split("\n");
      const scoreTableDataRows = lines.filter(
        (line) => line.includes("| 80 |") || line.includes("| 70 |") || line.includes("| 90 |"),
      );
      for (const row of scoreTableDataRows) {
        // A proper 5-column table row starts and ends with |, giving 6 segments when split.
        // If the pipe in the targetId leaked into a score row it would create extra columns.
        const cells = row.split("|").filter((c) => c.trim() !== "");
        expect(cells.length).toBe(5);
      }
    });

    it("handles quotes and angle brackets (XSS-like input)", () => {
      const finding = makeFinding({ targetId: '<script>alert("xss")</script>' });
      const result = makeResult([finding]);
      const outputs = allFormats(result);
      assertAllValid(outputs);

      // JSON should properly escape the string
      const json = JSON.parse(outputs.json);
      expect(json.worstFindings[0].targetId).toBe('<script>alert("xss")</script>');

      // SARIF should also be valid JSON with the target preserved
      const sarif = JSON.parse(outputs.sarif);
      const logicalLoc = sarif.runs[0].results[0]?.locations?.[0]?.logicalLocations?.[0];
      if (logicalLoc) {
        expect(logicalLoc.name).toBe('<script>alert("xss")</script>');
      }

      // Console and markdown should not throw
      expect(outputs.console).toContain("xss");
      expect(outputs.markdown).toContain("xss");
    });

    it("handles newlines in target names", () => {
      const finding = makeFinding({ targetId: "line1\nline2" });
      const result = makeResult([finding]);
      const outputs = allFormats(result);
      assertAllValid(outputs);

      // JSON must escape the newline
      const json = JSON.parse(outputs.json);
      expect(json.worstFindings[0].targetId).toBe("line1\nline2");
    });

    it("handles emoji in target names", () => {
      const finding = makeFinding({ targetId: "Submit \u{1F680}" });
      const result = makeResult([finding]);
      const outputs = allFormats(result);
      assertAllValid(outputs);

      expect(outputs.console).toContain("Submit \u{1F680}");
      expect(outputs.markdown).toContain("Submit \u{1F680}");

      const json = JSON.parse(outputs.json);
      expect(json.worstFindings[0].targetId).toBe("Submit \u{1F680}");
    });

    it("handles a very long target name (500 chars)", () => {
      const longName = "a".repeat(500);
      const finding = makeFinding({ targetId: longName });
      const result = makeResult([finding]);
      const outputs = allFormats(result);
      assertAllValid(outputs);

      // The full name should appear in JSON
      const json = JSON.parse(outputs.json);
      expect(json.worstFindings[0].targetId).toHaveLength(500);
    });

    it("handles empty targetId", () => {
      const finding = makeFinding({ targetId: "" });
      const result = makeResult([finding]);
      const outputs = allFormats(result);
      assertAllValid(outputs);
    });
  });

  // -------------------------------------------------------------------------
  // Score edge cases
  // -------------------------------------------------------------------------

  describe("score edge cases", () => {
    it("maps all-zero scores to severe severity", () => {
      const finding = makeFinding({
        scores: { discoverability: 0, reachability: 0, operability: 0, recovery: 0, interopRisk: 0, overall: 0 },
        severity: "severe",
      });
      const result = makeResult([finding]);
      const outputs = allFormats(result);
      assertAllValid(outputs);

      // Console should show severe icon
      expect(outputs.console).toContain("[!!]");
      expect(outputs.console).toContain("[severe]");

      // SARIF should report as error
      const sarif = JSON.parse(outputs.sarif);
      expect(sarif.runs[0].results).toHaveLength(1);
      expect(sarif.runs[0].results[0].ruleId).toBe("tactual/severe");
      expect(sarif.runs[0].results[0].level).toBe("error");
    });

    it("maps all-100 scores to strong severity and SARIF skips it", () => {
      const finding = makeFinding({
        scores: { discoverability: 100, reachability: 100, operability: 100, recovery: 100, interopRisk: 100, overall: 100 },
        severity: "strong",
      });
      const result = makeResult([finding]);
      const outputs = allFormats(result);
      assertAllValid(outputs);

      // Console severity overview should mention strong
      expect(outputs.console).toContain("strong: 1");

      // SARIF should skip strong findings
      const sarif = JSON.parse(outputs.sarif);
      expect(sarif.runs[0].results).toHaveLength(0);
    });

    it("assigns correct severity at exact boundary scores", () => {
      const boundaries = [
        { overall: 39, expectedSeverity: "severe", expectedIcon: "[!!]", expectedSarifRule: "tactual/severe", expectedSarifLevel: "error" },
        { overall: 40, expectedSeverity: "high", expectedIcon: "[! ]", expectedSarifRule: "tactual/high", expectedSarifLevel: "error" },
        { overall: 59, expectedSeverity: "high", expectedIcon: "[! ]", expectedSarifRule: "tactual/high", expectedSarifLevel: "error" },
        { overall: 60, expectedSeverity: "moderate", expectedIcon: "[~ ]", expectedSarifRule: "tactual/moderate", expectedSarifLevel: "warning" },
        { overall: 74, expectedSeverity: "moderate", expectedIcon: "[~ ]", expectedSarifRule: "tactual/moderate", expectedSarifLevel: "warning" },
        { overall: 75, expectedSeverity: "acceptable", expectedIcon: "[ok]", expectedSarifRule: "tactual/acceptable", expectedSarifLevel: "note" },
        { overall: 89, expectedSeverity: "acceptable", expectedIcon: "[ok]", expectedSarifRule: "tactual/acceptable", expectedSarifLevel: "note" },
        { overall: 90, expectedSeverity: "strong", expectedIcon: "[++]", sarifSkipped: true },
      ];

      for (const b of boundaries) {
        const finding = makeFinding({
          scores: { discoverability: b.overall, reachability: b.overall, operability: b.overall, recovery: b.overall, interopRisk: 0, overall: b.overall },
          severity: b.expectedSeverity as Finding["severity"],
        });
        const result = makeResult([finding]);

        // Console format — strong findings are filtered from "Worst Findings"
        // but appear in the severity overview line
        const consoleOut = formatConsole(result);
        if (b.sarifSkipped) {
          // Strong: check severity overview line instead of finding icon
          expect(consoleOut, `console severity overview at score ${b.overall}`).toContain(`${b.expectedSeverity}: 1`);
        } else {
          expect(consoleOut, `console at score ${b.overall}`).toContain(b.expectedIcon);
          expect(consoleOut, `console severity label at score ${b.overall}`).toContain(`[${b.expectedSeverity}]`);
        }

        // SARIF format
        const sarifOut = formatSARIF(result);
        const sarif = JSON.parse(sarifOut);

        if (b.sarifSkipped) {
          expect(sarif.runs[0].results, `SARIF should skip strong at score ${b.overall}`).toHaveLength(0);
        } else {
          expect(sarif.runs[0].results, `SARIF should have 1 result at score ${b.overall}`).toHaveLength(1);
          expect(sarif.runs[0].results[0].ruleId, `SARIF ruleId at score ${b.overall}`).toBe(b.expectedSarifRule);
          expect(sarif.runs[0].results[0].level, `SARIF level at score ${b.overall}`).toBe(b.expectedSarifLevel);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Large result sets
  // -------------------------------------------------------------------------

  describe("large result sets", () => {
    it("handles 100 findings across all formats", () => {
      const findings = Array.from({ length: 100 }, (_, i) =>
        makeFinding({ targetId: `target-${i}`, scores: { discoverability: 50, reachability: 50, operability: 50, recovery: 50, interopRisk: 0, overall: 50 }, severity: "high" }),
      );
      const result = makeResult(findings);
      const outputs = allFormats(result);
      assertAllValid(outputs);

      const json = JSON.parse(outputs.json);
      // Summarized output caps detailed findings at 15
      expect(json.worstFindings.length).toBeLessThanOrEqual(15);
      expect(json.totalFindings).toBe(100);
    });

    it("truncates JSON output at 600 findings and includes truncation metadata", () => {
      const findings = Array.from({ length: 600 }, (_, i) =>
        makeFinding({ targetId: `target-${i}`, scores: { discoverability: 30, reachability: 30, operability: 30, recovery: 30, interopRisk: 0, overall: 30 }, severity: "severe" }),
      );
      const result = makeResult(findings);

      const jsonOut = formatJSON(result);
      expect(jsonOut).toBeTruthy();

      const parsed = JSON.parse(jsonOut);
      expect(parsed.truncated).toBe(true);
      expect(parsed.totalFindings).toBe(600);
      expect(parsed.worstFindings.length).toBeLessThanOrEqual(15);

      // Other formats should still work without crashing
      const mdOut = formatMarkdown(result);
      expect(mdOut.length).toBeGreaterThan(0);

      const consoleOut = formatConsole(result);
      expect(consoleOut.length).toBeGreaterThan(0);

      const sarifOut = formatSARIF(result);
      expect(() => JSON.parse(sarifOut)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  describe("diagnostics", () => {
    it("renders mixed diagnostics with correct prefixes", () => {
      const result = makeResult([makeFinding()], {
        diagnostics: [
          { level: "error", code: "no-landmarks", message: "Page has no landmarks" },
          { level: "warning", code: "low-heading", message: "Heading structure is weak" },
          { level: "info", code: "perf-note", message: "Analysis took 500ms" },
        ],
      });

      const mdOut = formatMarkdown(result);
      expect(mdOut).toContain("## Diagnostics");
      expect(mdOut).toContain("**ERROR**");
      expect(mdOut).toContain("Page has no landmarks");
      expect(mdOut).toContain("**WARNING**");
      expect(mdOut).toContain("Heading structure is weak");
      // Info-level diagnostics are filtered out in summarized output
      expect(mdOut).not.toContain("Analysis took 500ms");

      const consoleOut = formatConsole(result);
      expect(consoleOut).toContain("!!!");
      expect(consoleOut).toContain("Page has no landmarks");
      expect(consoleOut).toContain(" ! ");
      expect(consoleOut).toContain("Heading structure is weak");
      // Info-level diagnostics are filtered out in summarized output
      expect(consoleOut).not.toContain("Analysis took 500ms");
    });
  });

  // -------------------------------------------------------------------------
  // SARIF-specific
  // -------------------------------------------------------------------------

  describe("SARIF-specific edge cases", () => {
    it("handles empty states array without crashing", () => {
      const result = makeResult([makeFinding()], { states: [] });

      const sarifOut = formatSARIF(result);
      expect(sarifOut).toBeTruthy();
      expect(() => JSON.parse(sarifOut)).not.toThrow();

      const sarif = JSON.parse(sarifOut);
      // With no states, the URL should fall back to empty string.
      // physicalLocation should be omitted (undefined) when URL is empty.
      const loc = sarif.runs[0].results[0]?.locations?.[0];
      expect(loc).toBeDefined();
      // Either no physicalLocation or an empty URI
      if (loc.physicalLocation) {
        expect(loc.physicalLocation.artifactLocation.uri).toBe("");
      }
    });

    it("maps multiple severities to correct SARIF ruleIds and levels", () => {
      const findings = [
        makeFinding({ targetId: "t-severe", scores: { discoverability: 10, reachability: 10, operability: 10, recovery: 10, interopRisk: 0, overall: 10 }, severity: "severe" }),
        makeFinding({ targetId: "t-high", scores: { discoverability: 50, reachability: 50, operability: 50, recovery: 50, interopRisk: 0, overall: 50 }, severity: "high" }),
        makeFinding({ targetId: "t-moderate", scores: { discoverability: 65, reachability: 65, operability: 65, recovery: 65, interopRisk: 0, overall: 65 }, severity: "moderate" }),
        makeFinding({ targetId: "t-acceptable", scores: { discoverability: 80, reachability: 80, operability: 80, recovery: 80, interopRisk: 0, overall: 80 }, severity: "acceptable" }),
        makeFinding({ targetId: "t-strong", scores: { discoverability: 95, reachability: 95, operability: 95, recovery: 95, interopRisk: 0, overall: 95 }, severity: "strong" }),
      ];
      const result = makeResult(findings);

      const sarifOut = formatSARIF(result);
      const sarif = JSON.parse(sarifOut);

      // "strong" is skipped, so 4 results
      expect(sarif.runs[0].results).toHaveLength(4);

      const resultsByTarget = new Map(
        sarif.runs[0].results.map((r: { locations: Array<{ logicalLocations: Array<{ name: string }> }>; ruleId: string; level: string }) => [
          r.locations[0].logicalLocations[0].name,
          r,
        ]),
      );

      const severe = resultsByTarget.get("t-severe") as { ruleId: string; level: string };
      expect(severe.ruleId).toBe("tactual/severe");
      expect(severe.level).toBe("error");

      const high = resultsByTarget.get("t-high") as { ruleId: string; level: string };
      expect(high.ruleId).toBe("tactual/high");
      expect(high.level).toBe("error");

      const moderate = resultsByTarget.get("t-moderate") as { ruleId: string; level: string };
      expect(moderate.ruleId).toBe("tactual/moderate");
      expect(moderate.level).toBe("warning");

      const acceptable = resultsByTarget.get("t-acceptable") as { ruleId: string; level: string };
      expect(acceptable.ruleId).toBe("tactual/acceptable");
      expect(acceptable.level).toBe("note");

      expect(resultsByTarget.has("t-strong")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Penalties and fixes with special characters
  // -------------------------------------------------------------------------

  describe("penalties and fixes with special characters", () => {
    it("handles markdown syntax in penalty text without breaking output", () => {
      const finding = makeFinding({
        penalties: ['Target **bold** text [link](url)'],
        suggestedFixes: ['Use `aria-label` on the <button> element'],
      });
      const result = makeResult([finding]);
      const outputs = allFormats(result);
      assertAllValid(outputs);

      // Markdown should include the penalty text (even if it renders as markdown)
      expect(outputs.markdown).toContain("Target **bold** text [link](url)");
      expect(outputs.markdown).toContain("Use `aria-label` on the <button> element");

      // JSON must preserve the text exactly
      const json = JSON.parse(outputs.json);
      expect(json.worstFindings[0].penalties[0]).toBe('Target **bold** text [link](url)');
      expect(json.worstFindings[0].suggestedFixes[0]).toBe('Use `aria-label` on the <button> element');
    });

    it("does not output empty Issues or Suggested fixes sections", () => {
      const finding = makeFinding({ penalties: [], suggestedFixes: [] });
      const result = makeResult([finding]);

      const mdOut = formatMarkdown(result);
      expect(mdOut).not.toContain("**Issues:**");
      expect(mdOut).not.toContain("**Suggested fixes:**");

      // Console should not have stray dashes from empty penalties
      const consoleOut = formatConsole(result);
      const lines = consoleOut.split("\n");
      const penaltyLines = lines.filter((l) => l.match(/^\s+- /));
      expect(penaltyLines).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // formatReport dispatcher
  // -------------------------------------------------------------------------

  describe("formatReport dispatcher", () => {
    it("dispatches to each format correctly", () => {
      const result = makeResult([makeFinding()]);

      const jsonOut = formatReport(result, "json");
      expect(() => JSON.parse(jsonOut)).not.toThrow();

      const mdOut = formatReport(result, "markdown");
      expect(mdOut).toContain("# Tactual Analysis");

      const consoleOut = formatReport(result, "console");
      expect(consoleOut).toContain("Tactual Analysis");

      const sarifOut = formatReport(result, "sarif");
      const sarif = JSON.parse(sarifOut);
      expect(sarif.version).toBe("2.1.0");
    });
  });
});
