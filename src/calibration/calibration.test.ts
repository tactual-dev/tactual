import { describe, it, expect } from "vitest";
import { runCalibration, formatCalibrationReport } from "./runner.js";
import type { CalibrationDataset, GroundTruthObservation } from "./types.js";
import type { AnalysisResult, Finding, PageState } from "../core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeObservation(overrides: Partial<GroundTruthObservation> = {}): GroundTruthObservation {
  return {
    url: "https://example.com",
    profileId: "generic-mobile-web-sr-v0",
    targetName: "Submit",
    actualStepsToReach: 5,
    strategyUsed: "heading",
    requiredStrategySwitch: false,
    knewTargetExisted: true,
    timeToDiscoverSeconds: 2,
    discoveryMethod: "heading-nav",
    couldOperate: true,
    couldRecover: true,
    difficultyRating: 2,
    testerId: "tester-1",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    targetId: "s1:target-button-1",
    profile: "generic-mobile-web-sr-v0",
    scores: {
      discoverability: 80,
      reachability: 70,
      operability: 100,
      recovery: 85,
      interopRisk: 0,
      overall: 82,
    },
    severity: "acceptable",
    bestPath: ["nextHeading: h1", "nextItem: Submit", "nextItem: button"],
    alternatePaths: [],
    penalties: [],
    suggestedFixes: [],
    confidence: 0.8,
    ...overrides,
  };
}

function makeState(targets: Array<{ id: string; name: string }> = []): PageState {
  return {
    id: "s1",
    url: "https://example.com",
    route: "/",
    snapshotHash: "h1",
    interactiveHash: "ih1",
    openOverlays: [],
    targets: targets.map((t) => ({
      id: t.id,
      kind: "button" as const,
      role: "button",
      name: t.name,
      requiresBranchOpen: false,
    })),
    timestamp: Date.now(),
    provenance: "scripted" as const,
  };
}

function makeResult(findings: Finding[], state?: PageState): AnalysisResult {
  const s = state ?? makeState([{ id: "target-button-1", name: "Submit" }]);
  return {
    flow: {
      id: "f1",
      name: "test",
      states: [s.id],
      profile: "generic-mobile-web-sr-v0",
      timestamp: Date.now(),
    },
    states: [s],
    findings,
    diagnostics: [],
    metadata: {
      version: "0.1.0",
      profile: "generic-mobile-web-sr-v0",
      duration: 100,
      stateCount: 1,
      targetCount: findings.length,
      edgeCount: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("calibration runner", () => {
  it("produces a report from matching observations and analyses", () => {
    const dataset: CalibrationDataset = {
      name: "test-dataset",
      collectedAt: new Date().toISOString(),
      observations: [makeObservation()],
    };

    const finding = makeFinding();
    const state = makeState([{ id: "target-button-1", name: "Submit" }]);
    const analyses = new Map([["https://example.com", makeResult([finding], state)]]);

    const report = runCalibration(dataset, analyses);

    expect(report.observationCount).toBe(1);
    expect(report.results).toHaveLength(1);
    expect(report.results[0].targetName).toBe("Submit");
    expect(report.results[0].severityMatch).toBe(true); // both "acceptable"
    expect(report.reachabilityMAE).toBeGreaterThanOrEqual(0);
    expect(report.severityAccuracy).toBe(1.0);
  });

  it("handles unmatched observations gracefully", () => {
    const dataset: CalibrationDataset = {
      name: "test",
      collectedAt: new Date().toISOString(),
      observations: [makeObservation({ targetName: "Nonexistent Button" })],
    };

    const analyses = new Map([["https://example.com", makeResult([])]]);
    const report = runCalibration(dataset, analyses);

    expect(report.observationCount).toBe(0);
    expect(report.results).toHaveLength(0);
  });

  it("handles missing URL in analyses", () => {
    const dataset: CalibrationDataset = {
      name: "test",
      collectedAt: new Date().toISOString(),
      observations: [makeObservation({ url: "https://missing.com" })],
    };

    const analyses = new Map([["https://example.com", makeResult([])]]);
    const report = runCalibration(dataset, analyses);

    expect(report.observationCount).toBe(0);
  });

  it("detects severity mismatch when model is too optimistic", () => {
    const dataset: CalibrationDataset = {
      name: "test",
      collectedAt: new Date().toISOString(),
      observations: [makeObservation({ difficultyRating: 5 })], // blocking
    };

    // Finding says "acceptable" but tester says "blocking" (severity 5 → severe)
    const finding = makeFinding({ severity: "acceptable" });
    const state = makeState([{ id: "target-button-1", name: "Submit" }]);
    const analyses = new Map([["https://example.com", makeResult([finding], state)]]);

    const report = runCalibration(dataset, analyses);

    expect(report.results[0].severityMatch).toBe(false);
    expect(report.results[0].groundTruthSeverity).toBe("severe");
    expect(report.results[0].predictedSeverity).toBe("acceptable");
    expect(report.severityAccuracy).toBe(0);
  });

  it("computes reachability accuracy as min/max ratio", () => {
    const dataset: CalibrationDataset = {
      name: "test",
      collectedAt: new Date().toISOString(),
      observations: [makeObservation({ actualStepsToReach: 10 })],
    };

    // Finding has 3-step best path
    const finding = makeFinding({
      bestPath: ["nextHeading: h1", "nextItem: Submit", "activate: Submit"],
    });
    const state = makeState([{ id: "target-button-1", name: "Submit" }]);
    const analyses = new Map([["https://example.com", makeResult([finding], state)]]);

    const report = runCalibration(dataset, analyses);

    // predicted=3, actual=10 → accuracy = 3/10 = 0.3
    expect(report.results[0].reachabilityAccuracy).toBeCloseTo(0.3, 1);
    expect(report.reachabilityMAE).toBe(7); // |3 - 10|
  });

  it("produces a confusion matrix", () => {
    const observations = [
      makeObservation({ targetName: "Btn1", difficultyRating: 1 }),
      makeObservation({ targetName: "Btn2", difficultyRating: 3 }),
      makeObservation({ targetName: "Btn3", difficultyRating: 5 }),
    ];

    const dataset: CalibrationDataset = {
      name: "test",
      collectedAt: new Date().toISOString(),
      observations,
    };

    const state = makeState([
      { id: "target-button-1", name: "Btn1" },
      { id: "target-button-2", name: "Btn2" },
      { id: "target-button-3", name: "Btn3" },
    ]);
    const findings = [
      makeFinding({ targetId: "s1:target-button-1", severity: "acceptable" }),
      makeFinding({ targetId: "s1:target-button-2", severity: "moderate" }),
      makeFinding({ targetId: "s1:target-button-3", severity: "acceptable" }),
    ];
    const analyses = new Map([["https://example.com", makeResult(findings, state)]]);

    const report = runCalibration(dataset, analyses);

    expect(report.observationCount).toBe(3);
    expect(report.severityConfusion).toBeDefined();
    // "acceptable" predicted for ground-truth "strong" (Btn1, rating 1)
    expect(report.severityConfusion["acceptable"]["strong"]).toBe(1);
    // "moderate" predicted for ground-truth "moderate" (Btn2, rating 3)
    expect(report.severityConfusion["moderate"]["moderate"]).toBe(1);
  });

  it("generates recommendations for biased models", () => {
    // Many observations where model is very optimistic
    const observations = Array.from({ length: 10 }, (_, i) =>
      makeObservation({
        targetName: `Btn${i}`,
        difficultyRating: 5, // blocking
      }),
    );

    const dataset: CalibrationDataset = {
      name: "test",
      collectedAt: new Date().toISOString(),
      observations,
    };

    const state = makeState(
      Array.from({ length: 10 }, (_, i) => ({
        id: `target-button-${i}`,
        name: `Btn${i}`,
      })),
    );
    const findings = Array.from({ length: 10 }, (_, i) =>
      makeFinding({
        targetId: `s1:target-button-${i}`,
        severity: "strong",
        scores: {
          discoverability: 95,
          reachability: 95,
          operability: 100,
          recovery: 100,
          interopRisk: 0,
          overall: 97,
        },
      }),
    );
    const analyses = new Map([["https://example.com", makeResult(findings, state)]]);

    const report = runCalibration(dataset, analyses);

    expect(report.overallScoreBias).toBeGreaterThan(10);
    expect(report.recommendations.some((r) => r.includes("optimistic"))).toBe(true);
  });

  it("formats a report as readable text", () => {
    const dataset: CalibrationDataset = {
      name: "test",
      collectedAt: new Date().toISOString(),
      observations: [makeObservation()],
    };

    const finding = makeFinding();
    const state = makeState([{ id: "target-button-1", name: "Submit" }]);
    const analyses = new Map([["https://example.com", makeResult([finding], state)]]);

    const report = runCalibration(dataset, analyses);
    const text = formatCalibrationReport(report);

    expect(text).toContain("Calibration Report");
    expect(text).toContain("Overall Score MAE");
    expect(text).toContain("Severity Accuracy");
    expect(text).toContain("Severity Confusion Matrix");
  });
});
