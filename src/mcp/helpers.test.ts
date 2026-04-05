import { describe, it, expect } from "vitest";
import { deduplicateFindings } from "./helpers.js";
import type { AnalysisResult, Finding } from "../core/types.js";

/**
 * Tests for mcp/helpers.ts — deduplicateFindings.
 * extractFindings and getOverallScore are already tested in mcp.test.ts
 * (imported via re-export from index.ts).
 */

// ---------------------------------------------------------------------------
// Test data factory
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<Finding> & { targetId: string }): Finding {
  return {
    profile: "generic-mobile-web-sr-v0",
    scores: { overall: 70, discoverability: 70, reachability: 70, operability: 70, recovery: 70, interopRisk: 0 },
    severity: "moderate" as const,
    penalties: [],
    suggestedFixes: [],
    bestPath: [],
    alternatePaths: [],
    confidence: 0.8,
    ...overrides,
  };
}

function makeResult(findings: Finding[]): AnalysisResult {
  return {
    flow: { id: "f1", name: "test", states: ["s1"], profile: "generic-mobile-web-sr-v0", timestamp: Date.now() },
    states: [{
      id: "s1", url: "http://test.example", route: "/", snapshotHash: "h1",
      interactiveHash: "ih1", openOverlays: [], targets: [], timestamp: Date.now(),
      provenance: "scripted" as const,
    }],
    findings,
    metadata: {
      targetCount: findings.length,
      matchingTargets: findings.length,
      stateCount: 1,
      edgeCount: 0,
      version: "test",
      profile: "generic-mobile-web-sr-v0",
      duration: 0,
    },
    diagnostics: [],
  };
}

// ---------------------------------------------------------------------------
// deduplicateFindings
// ---------------------------------------------------------------------------

describe("deduplicateFindings", () => {
  it("returns unchanged result for single finding", () => {
    const f = makeFinding({ targetId: "t1" });
    const result = makeResult([f]);
    const deduped = deduplicateFindings(result);
    expect(deduped.findings).toHaveLength(1);
    expect(deduped.findings[0].targetId).toBe("t1");
  });

  it("keeps small groups (≤2) intact", () => {
    const findings = [
      makeFinding({ targetId: "t1", penalties: ["P1"], severity: "moderate" }),
      makeFinding({ targetId: "t2", penalties: ["P1"], severity: "moderate" }),
    ];
    const deduped = deduplicateFindings(makeResult(findings));
    expect(deduped.findings).toHaveLength(2);
  });

  it("deduplicates groups of 3+ identical-penalty findings", () => {
    const findings = [
      makeFinding({ targetId: "t1", penalties: ["tab-interop"], severity: "moderate", scores: { overall: 60, discoverability: 60, reachability: 60, operability: 60, recovery: 60, interopRisk: 0 } }),
      makeFinding({ targetId: "t2", penalties: ["tab-interop"], severity: "moderate", scores: { overall: 65, discoverability: 65, reachability: 65, operability: 65, recovery: 65, interopRisk: 0 } }),
      makeFinding({ targetId: "t3", penalties: ["tab-interop"], severity: "moderate", scores: { overall: 62, discoverability: 62, reachability: 62, operability: 62, recovery: 62, interopRisk: 0 } }),
      makeFinding({ targetId: "t4", penalties: ["tab-interop"], severity: "moderate", scores: { overall: 70, discoverability: 70, reachability: 70, operability: 70, recovery: 70, interopRisk: 0 } }),
    ];
    const deduped = deduplicateFindings(makeResult(findings));
    // Should collapse 4 into 1 representative
    expect(deduped.findings).toHaveLength(1);
    // Worst score (t1: 60) should be the representative
    expect(deduped.findings[0].scores.overall).toBe(60);
    // Should have a count annotation
    expect(deduped.findings[0].penalties).toContain("tab-interop");
    expect(deduped.findings[0].penalties.some((p) => p.includes("4 similar targets"))).toBe(true);
  });

  it("keeps different penalty groups separate", () => {
    const findings = [
      makeFinding({ targetId: "t1", penalties: ["no-name"], severity: "high" }),
      makeFinding({ targetId: "t2", penalties: ["no-name"], severity: "high" }),
      makeFinding({ targetId: "t3", penalties: ["no-name"], severity: "high" }),
      makeFinding({ targetId: "t4", penalties: ["deep-nesting"], severity: "moderate" }),
    ];
    const deduped = deduplicateFindings(makeResult(findings));
    // 3 no-name → 1, 1 deep-nesting → 1
    expect(deduped.findings).toHaveLength(2);
  });

  it("updates matchingTargets in metadata", () => {
    const findings = Array.from({ length: 5 }, (_, i) =>
      makeFinding({ targetId: `t${i}`, penalties: ["same-penalty"], severity: "moderate" }),
    );
    const deduped = deduplicateFindings(makeResult(findings));
    expect(deduped.metadata.matchingTargets).toBe(deduped.findings.length);
  });

  it("sorts deduplicated findings worst-first", () => {
    const findings = [
      makeFinding({ targetId: "good", penalties: ["p1"], severity: "moderate", scores: { overall: 80, discoverability: 80, reachability: 80, operability: 80, recovery: 80, interopRisk: 0 } }),
      makeFinding({ targetId: "bad1", penalties: ["p2"], severity: "high", scores: { overall: 30, discoverability: 30, reachability: 30, operability: 30, recovery: 30, interopRisk: 0 } }),
      makeFinding({ targetId: "bad2", penalties: ["p2"], severity: "high", scores: { overall: 25, discoverability: 25, reachability: 25, operability: 25, recovery: 25, interopRisk: 0 } }),
      makeFinding({ targetId: "bad3", penalties: ["p2"], severity: "high", scores: { overall: 35, discoverability: 35, reachability: 35, operability: 35, recovery: 35, interopRisk: 0 } }),
    ];
    const deduped = deduplicateFindings(makeResult(findings));
    // bad group (worst=25) should come before good (80)
    expect(deduped.findings[0].scores.overall).toBeLessThan(deduped.findings[deduped.findings.length - 1].scores.overall);
  });
});
