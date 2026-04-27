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
        evidence: [
          {
            kind: "measured",
            source: "keyboard-probe",
            description: "Runtime keyboard probe completed successfully.",
            confidence: 0.95,
          },
        ],
        evidenceSummary: { measured: 1, validated: 0, modeled: 0, heuristic: 0 },
      },
    ],
    diagnostics: [],
    metadata: {
      version: "0.1.0",
      profile: "generic-mobile-web-sr-v0",
      duration: 100,
      stateCount: 1,
      targetCount: 1,
      findingCount: 1,
      edgeCount: 5,
    },
    ...overrides,
  };
}

function makeRemediationCandidateResult(): AnalysisResult {
  const base = makeResult();
  return {
    ...base,
    findings: [
      {
        ...base.findings[0],
        targetId: "t1",
        scores: { ...base.findings[0].scores, overall: 40 },
        severity: "high",
        penalties: ["12 controls precede this target"],
        suggestedFixes: ["Add skip navigation"],
      },
      {
        ...base.findings[0],
        targetId: "t2",
        scores: { ...base.findings[0].scores, overall: 45 },
        severity: "high",
        penalties: ["20 controls precede this target"],
        suggestedFixes: ["Add skip navigation"],
      },
    ],
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
      expect(f.evidence).toHaveLength(1);
      expect(f.evidenceSummary.measured).toBe(1);
    });

    it("keeps the summarized JSON contract compact and structured", () => {
      const base = makeResult();
      const findings = Array.from({ length: 20 }, (_, i) => ({
        ...base.findings[0],
        targetId: `t${i}`,
        scores: { ...base.findings[0].scores, overall: 20 + i },
        severity: i < 3 ? "severe" as const : "high" as const,
        penalties: [`${10 + i} controls precede this target`],
      }));
      const output = formatReport(
        makeResult({
          findings,
          diagnostics: [
            { level: "info", code: "ok", message: "healthy" },
            { level: "warning", code: "no-skip-link", message: "No skip link" },
          ],
        }),
        "json",
      );
      const parsed = JSON.parse(output);

      expect(parsed).toMatchObject({
        name: "Test Analysis",
        profile: "generic-mobile-web-sr-v0",
        truncated: true,
        totalFindings: 20,
      });
      expect(parsed.states).toBeUndefined();
      expect(parsed.worstFindings).toHaveLength(15);
      expect(parsed.truncationNote).toMatchObject({ shown: 15, omitted: 5 });
      expect(parsed.diagnostics).toEqual([
        { level: "warning", code: "no-skip-link", message: "No skip link" },
      ]);
      expect(parsed.issueGroups[0]).toMatchObject({
        issue: "Controls precede this target",
        count: 20,
      });
      expect(parsed.remediationCandidates).toEqual(expect.any(Array));
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

    it("includes evidence summary", () => {
      const output = formatReport(makeResult(), "markdown");
      expect(output).toContain("**Evidence:** measured: 1");
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

    it("includes remediation candidates for repeated issues", () => {
      const output = formatReport(makeRemediationCandidateResult(), "markdown");
      expect(output).toContain("## Remediation Candidates");
      expect(output).toContain("Reduce repeated screen-reader navigation cost");
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

    it("includes compact evidence summary", () => {
      const output = formatReport(makeResult(), "console");
      expect(output).toContain("Evidence: measured 1");
    });

    it("includes compact remediation candidates", () => {
      const output = formatReport(makeRemediationCandidateResult(), "console");
      expect(output).toContain("Remediation Candidates");
      expect(output).toContain("Reduce repeated screen-reader navigation cost");
    });

    it("includes target ID", () => {
      const output = formatReport(makeResult(), "console");
      expect(output).toContain("t1");
    });

    it("renders compacted bestPath as an SR-command line", () => {
      // nextItem × 3 should collapse to "Tab ×3" and then "Enter" after activate.
      const output = formatReport(makeResult({
        findings: [{
          ...makeResult().findings[0],
          bestPath: ["nextItem: Nav 1", "nextItem: Nav 2", "nextItem: Submit", "activate: Submit"],
        }],
      }), "console");
      expect(output).toContain("Tab ×3");
      expect(output).toContain("Enter");
    });

    it("renders heading-skip commands as H", () => {
      const output = formatReport(makeResult({
        findings: [{
          ...makeResult().findings[0],
          bestPath: ["nextHeading: Cart", "nextItem: Checkout", "activate: Checkout"],
        }],
      }), "console");
      expect(output).toContain("H");
      expect(output).toContain('"Cart"');
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
      expect(result.properties.evidence).toHaveLength(1);
      expect(result.properties.evidenceSummary.measured).toBe(1);
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
