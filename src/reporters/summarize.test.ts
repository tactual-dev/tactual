import { describe, it, expect } from "vitest";
import { summarize } from "./summarize.js";
import type { AnalysisResult, Finding, PageState } from "../core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<Finding> & { targetId: string }): Finding {
  return {
    profile: "generic-mobile-web-sr-v0",
    scores: {
      discoverability: 80, reachability: 80, operability: 80,
      recovery: 80, interopRisk: 90, overall: 80,
    },
    severity: "acceptable",
    bestPath: ["s1:entry", overrides.targetId],
    alternatePaths: [],
    penalties: [],
    suggestedFixes: [],
    confidence: 0.9,
    ...overrides,
  };
}

function makeResult(
  findings: Finding[],
  diagnostics: AnalysisResult["diagnostics"] = [],
): AnalysisResult {
  const dummyState: PageState = {
    id: "s1", url: "https://example.com", route: "/",
    snapshotHash: "a", interactiveHash: "b",
    openOverlays: [], targets: [], timestamp: Date.now(),
    provenance: "scripted",
  };
  return {
    flow: { id: "f1", name: "Test Flow", states: ["s1"], profile: "generic-mobile-web-sr-v0", timestamp: Date.now() },
    states: [dummyState],
    findings,
    diagnostics,
    metadata: {
      version: "0.6.0", profile: "generic-mobile-web-sr-v0",
      duration: 1000, stateCount: 1, targetCount: findings.length,
      edgeCount: findings.length * 2,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("summarize", () => {
  it("returns clean result for empty findings", () => {
    const result = summarize(makeResult([]));
    expect(result.stats.averageScore).toBe(0);
    expect(result.stats.worstScore).toBe(0);
    expect(result.stats.bestScore).toBe(0);
    expect(result.totalFindings).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.truncationNote).toBeNull();
    expect(result.worstFindings).toHaveLength(0);
    expect(result.issueGroups).toHaveLength(0);
  });

  it("computes correct stats for a few findings", () => {
    const findings = [
      makeFinding({ targetId: "t1", scores: { discoverability: 90, reachability: 90, operability: 90, recovery: 90, interopRisk: 90, overall: 90 }, severity: "strong" }),
      makeFinding({ targetId: "t2", scores: { discoverability: 60, reachability: 60, operability: 60, recovery: 60, interopRisk: 60, overall: 60 }, severity: "moderate" }),
      makeFinding({ targetId: "t3", scores: { discoverability: 30, reachability: 30, operability: 30, recovery: 30, interopRisk: 30, overall: 30 }, severity: "severe" }),
    ];
    const result = summarize(makeResult(findings));
    expect(result.stats.averageScore).toBe(60);
    expect(result.stats.worstScore).toBe(30);
    expect(result.stats.bestScore).toBe(90);
    expect(result.totalFindings).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.truncationNote).toBeNull();
  });

  it("counts severity bands correctly", () => {
    const findings = [
      makeFinding({ targetId: "t1", severity: "severe" }),
      makeFinding({ targetId: "t2", severity: "severe" }),
      makeFinding({ targetId: "t3", severity: "high" }),
      makeFinding({ targetId: "t4", severity: "moderate" }),
      makeFinding({ targetId: "t5", severity: "acceptable" }),
      makeFinding({ targetId: "t6", severity: "strong" }),
    ];
    const result = summarize(makeResult(findings));
    expect(result.severityCounts.severe).toBe(2);
    expect(result.severityCounts.high).toBe(1);
    expect(result.severityCounts.moderate).toBe(1);
    expect(result.severityCounts.acceptable).toBe(1);
    expect(result.severityCounts.strong).toBe(1);
  });

  it("truncates when findings exceed MAX_DETAILED_FINDINGS", () => {
    const findings = Array.from({ length: 25 }, (_, i) =>
      makeFinding({
        targetId: `t${i}`,
        scores: { discoverability: 50, reachability: 50, operability: 50, recovery: 50, interopRisk: 50, overall: 50 - i },
        severity: i < 5 ? "severe" : i < 10 ? "high" : "moderate",
      }),
    );
    const result = summarize(makeResult(findings));
    expect(result.truncated).toBe(true);
    expect(result.totalFindings).toBe(25);
    expect(result.worstFindings).toHaveLength(15);
    expect(result.truncationNote).not.toBeNull();
    expect(result.truncationNote!.shown).toBe(15);
    expect(result.truncationNote!.omitted).toBe(10);
    expect(result.truncationNote!.message).toContain("Showing 15 of 25");
    expect(result.truncationNote!.howToSeeMore).toContain("Fix the worst");
  });

  it("worst findings are sorted worst-first", () => {
    const findings = [
      makeFinding({ targetId: "good", scores: { discoverability: 95, reachability: 95, operability: 95, recovery: 95, interopRisk: 95, overall: 95 }, severity: "strong" }),
      makeFinding({ targetId: "bad", scores: { discoverability: 20, reachability: 20, operability: 20, recovery: 20, interopRisk: 20, overall: 20 }, severity: "severe" }),
      makeFinding({ targetId: "mid", scores: { discoverability: 60, reachability: 60, operability: 60, recovery: 60, interopRisk: 60, overall: 60 }, severity: "moderate" }),
    ];
    const result = summarize(makeResult(findings));
    expect(result.worstFindings[0].targetId).toBe("bad");
    expect(result.worstFindings[1].targetId).toBe("mid");
    expect(result.worstFindings[2].targetId).toBe("good");
  });

  it("groups findings by shared penalty pattern", () => {
    const sharedPenalty = "11 controls precede this target";
    const findings = [
      makeFinding({ targetId: "t1", penalties: [sharedPenalty], suggestedFixes: ["Add skip link"] }),
      makeFinding({ targetId: "t2", penalties: ["33 controls precede this target"], suggestedFixes: ["Add skip link"] }),
      makeFinding({ targetId: "t3", penalties: [sharedPenalty], suggestedFixes: ["Add skip link"] }),
    ];
    const result = summarize(makeResult(findings));
    // All 3 should land in the same group because numbers are normalized
    expect(result.issueGroups).toHaveLength(1);
    expect(result.issueGroups[0].count).toBe(3);
    expect(result.issueGroups[0].fix).toBe("Add skip link");
    expect(result.issueGroups[0].examples.length).toBeLessThanOrEqual(3);
  });

  it("does not create issue groups for single occurrences", () => {
    const findings = [
      makeFinding({ targetId: "t1", penalties: ["Unique penalty A"] }),
      makeFinding({ targetId: "t2", penalties: ["Unique penalty B"] }),
    ];
    const result = summarize(makeResult(findings));
    expect(result.issueGroups).toHaveLength(0);
  });

  it("filters out info-level and ok diagnostics", () => {
    const result = summarize(makeResult([], [
      { level: "info", code: "ok", message: "All good" },
      { level: "info", code: "possible-cookie-wall", message: "Cookie detected" },
      { level: "warning", code: "no-headings", message: "No headings found" },
      { level: "error", code: "empty-page", message: "No targets" },
    ]));
    // info-level and ok are filtered out
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics[0].level).toBe("warning");
    expect(result.diagnostics[1].level).toBe("error");
  });

  it("includes matchingTargets in stats when present", () => {
    const r = makeResult([makeFinding({ targetId: "t1" })]);
    (r.metadata as Record<string, unknown>).matchingTargets = 5;
    const result = summarize(r);
    expect(result.stats.matchingTargets).toBe(5);
  });

  it("omits matchingTargets from stats when absent", () => {
    const result = summarize(makeResult([makeFinding({ targetId: "t1" })]));
    expect(result.stats.matchingTargets).toBeUndefined();
  });

  it("preserves flow name and profile in output", () => {
    const result = summarize(makeResult([]));
    expect(result.name).toBe("Test Flow");
    expect(result.profile).toBe("generic-mobile-web-sr-v0");
  });

  it("detailed findings include all score dimensions", () => {
    const findings = [makeFinding({
      targetId: "t1",
      scores: { discoverability: 10, reachability: 20, operability: 30, recovery: 40, interopRisk: 50, overall: 25 },
      penalties: ["P1"],
      suggestedFixes: ["F1"],
      bestPath: ["s1:entry", "t1"],
      confidence: 0.85,
    })];
    const result = summarize(makeResult(findings));
    const d = result.worstFindings[0];
    expect(d.scores.discoverability).toBe(10);
    expect(d.scores.reachability).toBe(20);
    expect(d.scores.operability).toBe(30);
    expect(d.scores.recovery).toBe(40);
    expect(d.scores.interopRisk).toBe(50);
    expect(d.overall).toBe(25);
    expect(d.penalties).toEqual(["P1"]);
    expect(d.suggestedFixes).toEqual(["F1"]);
    expect(d.confidence).toBe(0.85);
  });

  it("truncation note includes severity breakdown of omitted findings", () => {
    // Create 20 findings sorted worst-first by overall score.
    // Sorted: i=19 (overall 61, moderate) ... i=8 (72, moderate) i=7 (73, high) ... i=0 (80, severe)
    // Shown 15 (worst): i=19..5 → 12 moderate + 3 high
    // Omitted 5 (best):  i=4 (76, high), i=3 (77, high), i=2 (78, severe), i=1 (79, severe), i=0 (80, severe)
    const findings = Array.from({ length: 20 }, (_, i) =>
      makeFinding({
        targetId: `t${i}`,
        scores: { discoverability: 50, reachability: 50, operability: 50, recovery: 50, interopRisk: 50, overall: 80 - i },
        severity: i < 3 ? "severe" : i < 8 ? "high" : "moderate",
      }),
    );
    const result = summarize(makeResult(findings));
    expect(result.truncationNote).not.toBeNull();
    expect(result.truncationNote!.omitted).toBe(5);
    // Omitted 5 are the best-scoring: 3 severe + 2 high
    expect(result.truncationNote!.omittedBySeverity.severe).toBe(3);
    expect(result.truncationNote!.omittedBySeverity.high).toBe(2);
  });
});
