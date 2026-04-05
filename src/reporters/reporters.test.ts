import { describe, it, expect } from "vitest";
import { formatReport } from "./index.js";
import type { AnalysisResult } from "../core/types.js";

function makeResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    flow: {
      id: "flow-1",
      name: "Test Analysis",
      states: ["s1"],
      profile: "generic-mobile-web-sr-v0",
      timestamp: Date.now(),
    },
    states: [
      {
        id: "s1",
        url: "https://example.com",
        route: "/",
        snapshotHash: "abc",
        interactiveHash: "def",
        openOverlays: [],
        targets: [
          { id: "t1", kind: "button", role: "button", name: "Submit", requiresBranchOpen: false },
        ],
        timestamp: Date.now(),
        provenance: "scripted",
      },
    ],
    findings: [
      {
        targetId: "t1",
        profile: "generic-mobile-web-sr-v0",
        scores: {
          discoverability: 80,
          reachability: 60,
          operability: 90,
          recovery: 70,
          interopRisk: 0,
          overall: 72,
        },
        severity: "moderate",
        bestPath: ["nextItem: Submit"],
        alternatePaths: [["nextHeading: Form", "nextControl: Submit"]],
        penalties: ["Target is not under a heading"],
        suggestedFixes: ["Add a heading before the form"],
        confidence: 0.8,
      },
    ],
    diagnostics: [],
    metadata: {
      version: "0.1.0",
      profile: "generic-mobile-web-sr-v0",
      duration: 100,
      stateCount: 1,
      targetCount: 1,
      edgeCount: 5,
    },
    ...overrides,
  };
}

describe("formatReport", () => {
  describe("JSON format", () => {
    it("produces valid JSON", () => {
      const output = formatReport(makeResult(), "json");
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it("preserves all finding fields", () => {
      const output = formatReport(makeResult(), "json");
      const parsed = JSON.parse(output);
      const f = parsed.worstFindings[0];
      expect(f.targetId).toBe("t1");
      expect(f.overall).toBe(72);
      expect(f.severity).toBeDefined();
      expect(f.scores).toBeDefined();
      expect(f.penalties).toBeDefined();
      expect(f.suggestedFixes).toBeDefined();
      expect(f.bestPath).toBeDefined();
      expect(f.confidence).toBeDefined();
    });
  });

  describe("Markdown format", () => {
    it("includes title and summary", () => {
      const output = formatReport(makeResult(), "markdown");
      expect(output).toContain("# Tactual Analysis: Test Analysis");
      expect(output).toContain("## Summary");
    });

    it("includes score table", () => {
      const output = formatReport(makeResult(), "markdown");
      expect(output).toContain("D:80 R:60 O:90 Rec:70 IR:0");
    });

    it("includes penalties and fixes", () => {
      const output = formatReport(makeResult(), "markdown");
      expect(output).toContain("Target is not under a heading");
      expect(output).toContain("Add a heading before the form");
    });

    it("includes worst findings section", () => {
      const output = formatReport(makeResult(), "markdown");
      expect(output).toContain("## Worst Findings");
      expect(output).toContain("### t1");
    });

    it("includes severity in finding header", () => {
      const output = formatReport(makeResult(), "markdown");
      expect(output).toContain("72/100 [moderate]");
    });

    it("handles empty findings", () => {
      const output = formatReport(makeResult({ findings: [] }), "markdown");
      expect(output).toContain("No findings");
    });
  });

  describe("Console format", () => {
    it("includes severity and score", () => {
      const output = formatReport(makeResult(), "console");
      expect(output).toContain("72");
      expect(output).toContain("moderate");
    });

    it("includes score dimensions", () => {
      const output = formatReport(makeResult(), "console");
      expect(output).toContain("D:80");
      expect(output).toContain("R:60");
    });

    it("includes target ID", () => {
      const output = formatReport(makeResult(), "console");
      expect(output).toContain("t1");
    });
  });

  describe("SARIF format", () => {
    it("produces valid SARIF JSON", () => {
      const output = formatReport(makeResult(), "sarif");
      const parsed = JSON.parse(output);
      expect(parsed.$schema).toContain("sarif");
      expect(parsed.version).toBe("2.1.0");
    });

    it("maps severity to SARIF levels", () => {
      const output = formatReport(makeResult(), "sarif");
      const parsed = JSON.parse(output);
      expect(parsed.runs[0].results[0].level).toBe("warning");
    });

    it("skips strong findings", () => {
      const result = makeResult({
        findings: [
          {
            targetId: "t1",
            profile: "test",
            scores: { discoverability: 95, reachability: 95, operability: 95, recovery: 95, interopRisk: 0, overall: 95 },
            severity: "strong",
            bestPath: [],
            alternatePaths: [],
            penalties: [],
            suggestedFixes: [],
            confidence: 0.9,
          },
        ],
      });
      const output = formatReport(result, "sarif");
      const parsed = JSON.parse(output);
      expect(parsed.runs[0].results).toHaveLength(0);
    });

    it("includes tool information", () => {
      const output = formatReport(makeResult(), "sarif");
      const parsed = JSON.parse(output);
      expect(parsed.runs[0].tool.driver.name).toBe("Tactual");
      expect(parsed.runs[0].tool.driver.rules.length).toBeGreaterThan(0);
    });

    it("includes finding properties", () => {
      const output = formatReport(makeResult(), "sarif");
      const parsed = JSON.parse(output);
      const result = parsed.runs[0].results[0];
      expect(result.properties.scores).toBeDefined();
      expect(result.properties.confidence).toBe(0.8);
    });
  });

  describe("special characters", () => {
    it("handles targets with quotes in names", () => {
      const result = makeResult();
      result.findings[0].penalties = ['Button labeled "Click "here"" is ambiguous'];
      const json = formatReport(result, "json");
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it("handles empty penalties and fixes", () => {
      const result = makeResult();
      result.findings[0].penalties = [];
      result.findings[0].suggestedFixes = [];
      const md = formatReport(result, "markdown");
      expect(md).not.toContain("**Issues:**");
    });
  });
});
