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
      kind: t.name.startsWith("Heading") ? "heading" as const : "button" as const,
      role: t.name.startsWith("Heading") ? "heading" : "button",
      name: t.name,
      requiresBranchOpen: false,
      ...(t.name.startsWith("Heading") ? { headingLevel: 1 } : {}),
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
      findingCount: findings.length,
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

  it("computes reachability accuracy from graph-weighted path cost, not rendered path length", () => {
    const dataset: CalibrationDataset = {
      name: "test",
      collectedAt: new Date().toISOString(),
      observations: [makeObservation({ actualStepsToReach: 10 })],
    };

    // The finding has a 3-string rendered path, but the graph path through
    // this state costs 2 weighted actions: state -> Previous -> Submit.
    const finding = makeFinding({
      bestPath: ["nextHeading: h1", "nextItem: Submit", "activate: Submit"],
    });
    const state = makeState([
      { id: "target-button-0", name: "Previous" },
      { id: "target-button-1", name: "Submit" },
    ]);
    const analyses = new Map([["https://example.com", makeResult([finding], state)]]);

    const report = runCalibration(dataset, analyses);

    // predicted=2, actual=10 → accuracy = 2/10 = 0.2
    expect(report.results[0].predictedPathCost).toBe(2);
    expect(report.results[0].strategyUsed).toBe("heading");
    expect(report.results[0].requiredStrategySwitch).toBe(false);
    expect(report.results[0].reachabilityAccuracy).toBeCloseTo(0.2, 1);
    expect(report.reachabilityMAE).toBe(8);
    expect(report.dimensionBias.reachability).toBe(8);
    expect(report.scoringSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "reachability.ground-truth-fit",
          status: "review",
          dimension: "reachability",
        }),
      ]),
    );
  });

  it("predicts scripted Tab calibration from the ordered focusable sequence", () => {
    const dataset: CalibrationDataset = {
      name: "test",
      collectedAt: new Date().toISOString(),
      observations: [
        makeObservation({
          profileId: "nvda-desktop-v0",
          targetId: "s1:submit",
          targetName: "Submit",
          strategyUsed: "tab",
          actualStepsToReach: 3,
        }),
      ],
    };
    const state: PageState = {
      id: "s1",
      url: "https://example.com",
      route: "/",
      snapshotHash: "h1",
      interactiveHash: "ih1",
      openOverlays: [],
      targets: [
        { id: "title", kind: "heading", role: "heading", name: "Checkout", headingLevel: 1, requiresBranchOpen: false },
        { id: "previous", kind: "button", role: "button", name: "Previous", requiresBranchOpen: false },
        { id: "terms", kind: "link", role: "link", name: "Terms", requiresBranchOpen: false },
        { id: "submit", kind: "button", role: "button", name: "Submit", requiresBranchOpen: false },
      ],
      timestamp: Date.now(),
      provenance: "scripted",
    };
    const finding = makeFinding({ targetId: "s1:submit", profile: "nvda-desktop-v0" });
    const analyses = new Map([["https://example.com", makeResult([finding], state)]]);

    const report = runCalibration(dataset, analyses);

    expect(report.results[0].predictedPathCost).toBe(3);
    expect(report.results[0].reachabilityAccuracy).toBe(1);
  });

  it("predicts NVDA form-field calibration from the observed quick-nav subset", () => {
    const dataset: CalibrationDataset = {
      name: "test",
      collectedAt: new Date().toISOString(),
      observations: [
        makeObservation({
          profileId: "nvda-desktop-v0",
          targetId: "s1:spin",
          targetName: "Seats",
          strategyUsed: "form-field",
          actualStepsToReach: 2,
        }),
      ],
    };
    const state: PageState = {
      id: "s1",
      url: "https://example.com",
      route: "/",
      snapshotHash: "h1",
      interactiveHash: "ih1",
      openOverlays: [],
      targets: [
        {
          id: "custom-text",
          kind: "formField",
          role: "textbox",
          name: "Custom text",
          requiresBranchOpen: false,
        },
        {
          id: "email",
          kind: "formField",
          role: "textbox",
          name: "Email",
          requiresBranchOpen: false,
          _nativeHtmlControl: "input",
        },
        {
          id: "range",
          kind: "formField",
          role: "slider",
          name: "Priority",
          requiresBranchOpen: false,
          _nativeHtmlControl: "input",
        },
        {
          id: "spin",
          kind: "formField",
          role: "spinbutton",
          name: "Seats",
          requiresBranchOpen: false,
        },
      ],
      timestamp: Date.now(),
      provenance: "scripted",
    };
    const finding = makeFinding({ targetId: "s1:spin", profile: "nvda-desktop-v0" });
    const analyses = new Map([["https://example.com", makeResult([finding], state)]]);

    const report = runCalibration(dataset, analyses);

    expect(report.results[0].predictedPathCost).toBe(2);
    expect(report.results[0].reachabilityAccuracy).toBe(1);
  });

  it("computes score bias only from matched observations", () => {
    const dataset: CalibrationDataset = {
      name: "test",
      collectedAt: new Date().toISOString(),
      observations: [
        makeObservation({ targetName: "Submit", difficultyRating: 2 }),
        makeObservation({ targetName: "Missing", difficultyRating: 5 }),
      ],
    };
    const finding = makeFinding({
      scores: {
        discoverability: 80,
        reachability: 70,
        operability: 100,
        recovery: 85,
        interopRisk: 0,
        overall: 82,
      },
      severity: "acceptable",
    });
    const state = makeState([{ id: "target-button-1", name: "Submit" }]);
    const analyses = new Map([["https://example.com", makeResult([finding], state)]]);

    const report = runCalibration(dataset, analyses);

    expect(report.observationCount).toBe(1);
    expect(report.overallScoreBias).toBe(0);
  });

  it("compares observed announcement output against modeled tokens", () => {
    const dataset: CalibrationDataset = {
      name: "test",
      collectedAt: new Date().toISOString(),
      observations: [
        makeObservation({
          observedAnnouncement: "Submit, link",
          announcementAt: "nvda",
        }),
      ],
    };
    const finding = makeFinding();
    const state = makeState([{ id: "target-button-1", name: "Submit" }]);
    const analyses = new Map([["https://example.com", makeResult([finding], state)]]);

    const report = runCalibration(dataset, analyses);

    expect(report.announcementObservationCount).toBe(1);
    expect(report.results[0].predictedAnnouncement).toBe("Submit, button");
    expect(report.results[0].announcementMatch).toBe(false);
    expect(report.results[0].missingAnnouncementTokens).toEqual(["button"]);
    expect(report.results[0].announcementAssumptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "announcement.nvda.name.accessible-name",
          status: "confirmed",
          expected: "submit",
        }),
        expect.objectContaining({
          id: "announcement.nvda.role.button",
          kind: "role",
          status: "missing",
          expected: "button",
        }),
      ]),
    );
    expect(report.announcementResults[0]).toMatchObject({
      modeledAnnouncement: "Submit, button",
      observedAnnouncement: "Submit, link",
      announcementSource: "manual-sr",
      announcementMatch: false,
    });
    expect(report.announcementResults[0].announcementAssumptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "announcement.nvda.role.button",
          status: "missing",
        }),
      ]),
    );
    expect(report.announcementAccuracy).toBe(0.5);
    expect(report.recommendations.some((r) => r.includes("Observed announcements"))).toBe(true);
    expect(report.scoringSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "announcement.mapper-drift",
          status: "review",
          dimension: "confidence",
        }),
      ]),
    );
  });

  it("surfaces strategy-switch observations as scoring signals", () => {
    const dataset: CalibrationDataset = {
      name: "test",
      collectedAt: new Date().toISOString(),
      observations: [
        makeObservation({
          actualStepsToReach: 8,
          strategyUsed: "mixed",
          requiredStrategySwitch: true,
        }),
      ],
    };
    const finding = makeFinding();
    const state = makeState([{ id: "target-button-1", name: "Submit" }]);
    const analyses = new Map([["https://example.com", makeResult([finding], state)]]);

    const report = runCalibration(dataset, analyses);

    expect(report.scoringSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "navigation.strategy-switch-pressure",
          kind: "strategy-switch",
          status: "review",
          dimension: "reachability",
        }),
      ]),
    );
  });

  it("accepts semantic observed announcement tokens when exact phrasing is noisy", () => {
    const dataset: CalibrationDataset = {
      name: "test",
      collectedAt: new Date().toISOString(),
      observations: [
        makeObservation({
          observedAnnouncementTokens: ["Submit", "button"],
          announcementAt: "nvda",
        }),
      ],
    };
    const finding = makeFinding();
    const state = makeState([{ id: "target-button-1", name: "Submit" }]);
    const analyses = new Map([["https://example.com", makeResult([finding], state)]]);

    const report = runCalibration(dataset, analyses);

    expect(report.results[0].announcementMatch).toBe(true);
    expect(report.results[0].announcementAccuracy).toBe(1);
  });

  it("does not treat extra NVDA context tokens as mapper drift", () => {
    const dataset: CalibrationDataset = {
      name: "test",
      collectedAt: new Date().toISOString(),
      observations: [
        makeObservation({
          observedAnnouncementTokens: ["main landmark", "Checkout", "region", "Submit", "button"],
          announcementAt: "nvda",
        }),
      ],
    };
    const finding = makeFinding();
    const state = makeState([{ id: "target-button-1", name: "Submit" }]);
    const analyses = new Map([["https://example.com", makeResult([finding], state)]]);

    const report = runCalibration(dataset, analyses);

    expect(report.results[0]).toMatchObject({
      announcementMatch: true,
      announcementAccuracy: 1,
      missingAnnouncementTokens: [],
      unexpectedAnnouncementTokens: ["main landmark", "checkout", "region"],
    });
    expect(report.scoringSignals).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "announcement.mapper-drift" }),
      ]),
    );
  });

  it("normalizes observed punctuation separators before announcement comparison", () => {
    const dataset: CalibrationDataset = {
      name: "test",
      collectedAt: new Date().toISOString(),
      observations: [],
      announcementObservations: [
        {
          url: "https://example.com",
          profileId: "nvda-desktop-v0",
          targetName: "Search:",
          observedAnnouncement: "Search: edit blank",
          announcementSource: "fixture",
          timestamp: "2026-06-11T12:00:00Z",
        },
      ],
    };
    const state = makeState();
    state.targets = [
      {
        id: "searchbox-1",
        kind: "formField",
        role: "searchbox",
        name: "Search:",
        requiresBranchOpen: false,
      },
    ];
    const analyses = new Map([["https://example.com", makeResult([], state)]]);

    const report = runCalibration(dataset, analyses);

    expect(report.announcementResults[0]).toMatchObject({
      modeledAnnouncement: "Search:, edit",
      announcementMatch: true,
      missingAnnouncementTokens: [],
    });
    expect(report.announcementAccuracy).toBe(1);
  });

  it("accepts announcement-only observations without reachability data", () => {
    const dataset: CalibrationDataset = {
      name: "test",
      collectedAt: new Date().toISOString(),
      observations: [],
      announcementObservations: [
        {
          url: "https://example.com",
          profileId: "nvda-desktop-v0",
          targetName: "Submit",
          observedAnnouncement: "Submit, button",
          announcementSource: "fixture",
          timestamp: "2026-06-11T12:00:00Z",
        },
      ],
    };
    const state = makeState([{ id: "target-button-1", name: "Submit" }]);
    const analyses = new Map([["https://example.com", makeResult([], state)]]);

    const report = runCalibration(dataset, analyses);

    expect(report.observationCount).toBe(0);
    expect(report.announcementObservationCount).toBe(1);
    expect(report.announcementResults[0]).toMatchObject({
      modeledAnnouncement: "Submit, button",
      observedAnnouncement: "Submit, button",
      announcementSource: "fixture",
      announcementMatch: true,
    });
    expect(report.announcementAccuracy).toBe(1);
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
    expect(report.scoringSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "score.overall-bias",
          kind: "score-bias",
          dimension: "overall",
        }),
      ]),
    );
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
    expect(text).toContain("Scoring Signals");
    expect(text).toContain("Severity Accuracy");
    expect(text).toContain("Severity Confusion Matrix");
  });

  it("formats challenged AT mapper assumptions for announcement mismatches", () => {
    const dataset: CalibrationDataset = {
      name: "test",
      collectedAt: new Date().toISOString(),
      observations: [
        makeObservation({
          observedAnnouncement: "Submit, link",
          announcementAt: "nvda",
        }),
      ],
    };
    const finding = makeFinding();
    const state = makeState([{ id: "target-button-1", name: "Submit" }]);
    const analyses = new Map([["https://example.com", makeResult([finding], state)]]);

    const report = runCalibration(dataset, analyses);
    const text = formatCalibrationReport(report);

    expect(text).toContain("AT Mapper Assumptions To Review");
    expect(text).toContain("announcement.nvda.role.button");
  });
});
