/**
 * Calibration runner.
 *
 * Compares Tactual's predictions against ground-truth observations
 * from human testers to measure scoring accuracy and identify
 * systematic bias in the model's weights.
 */

import type { AnalysisResult, Finding } from "../core/types.js";
import type { Target, PageState, NavigationAction } from "../core/types.js";
import { formFieldQuickNavTargets } from "../core/at-navigation.js";
import { buildGraph } from "../core/graph-builder.js";
import { collectEntryPoints, computePathsFromEntries } from "../core/path-analysis.js";
import { getProfile } from "../profiles/index.js";
import type { ATProfile } from "../profiles/types.js";
import { compareAnnouncementObservation } from "./announcement-comparison.js";
import type {
  AnnouncementCalibrationResult,
  AnnouncementObservation,
  CalibrationScoringSignal,
  GroundTruthObservation,
  CalibrationDataset,
  CalibrationResult,
  CalibrationReport,
} from "./types.js";

interface MatchedFinding {
  finding: Finding;
  state: PageState;
  target: Target;
}

interface MatchedTarget {
  state: PageState;
  target: Target;
}

/**
 * Map a 1-5 difficulty rating to an expected severity band.
 *
 * This is the bridge between subjective human ratings and Tactual's
 * scoring model. The mapping is:
 *   1 (trivial)    → strong    (90-100)
 *   2 (easy)       → acceptable (75-89)
 *   3 (moderate)   → moderate  (60-74)
 *   4 (hard)       → high      (40-59)
 *   5 (blocking)   → severe    (0-39)
 */
function difficultyToSeverity(rating: number): string {
  if (rating <= 1) return "strong";
  if (rating <= 2) return "acceptable";
  if (rating <= 3) return "moderate";
  if (rating <= 4) return "high";
  return "severe";
}

/**
 * Map a 1-5 difficulty rating to an expected midpoint score.
 */
function difficultyToExpectedScore(rating: number): number {
  // Midpoints of each severity band
  const scores: Record<number, number> = { 1: 95, 2: 82, 3: 67, 4: 50, 5: 20 };
  return scores[Math.round(Math.max(1, Math.min(5, rating)))] ?? 50;
}

/**
 * Find the best-matching finding for a ground-truth observation.
 *
 * Matches by target name (case-insensitive substring) or selector.
 */
function matchFinding(
  observation: AnnouncementObservation,
  result: AnalysisResult,
): MatchedFinding | null {
  const name = observation.targetName.toLowerCase();

  if (observation.targetId) {
    for (const state of result.states) {
      const target = state.targets.find((candidate) =>
        targetIdMatches(observation.targetId!, state.id, candidate.id),
      );
      if (target) {
        const finding = findFindingForTarget(result.findings, state, target);
        if (finding) return { finding, state, target };
      }
    }
  }

  // Try exact selector match first
  if (observation.targetSelector) {
    for (const state of result.states) {
      for (const target of state.targets) {
        if (target.selector === observation.targetSelector) {
          const finding = findFindingForTarget(result.findings, state, target);
          if (finding) return { finding, state, target };
        }
      }
    }
  }

  // Fall back to name match
  for (const finding of result.findings) {
    // targetId format is "stateId:target-kind-N" — try to match against
    // the actual target name from the states array
    for (const state of result.states) {
      const target = state.targets.find(
        (t) => finding.targetId === `${state.id}:${t.id}` || finding.targetId === t.id,
      );
      if (target && target.name.toLowerCase().includes(name)) {
        return { finding, state, target };
      }
    }

    // Last resort: match against targetId itself
    if (finding.targetId.toLowerCase().includes(name)) {
      const match = findTargetForFinding(result.states, finding);
      if (match) return { finding, ...match };
    }
  }

  return null;
}

function matchTarget(
  observation: AnnouncementObservation,
  result: AnalysisResult,
): MatchedTarget | null {
  const name = observation.targetName.toLowerCase();

  if (observation.targetId) {
    for (const state of result.states) {
      const target = state.targets.find((candidate) =>
        targetIdMatches(observation.targetId!, state.id, candidate.id),
      );
      if (target) return { state, target };
    }
  }

  if (observation.targetSelector) {
    for (const state of result.states) {
      const target = state.targets.find((candidate) => candidate.selector === observation.targetSelector);
      if (target) return { state, target };
    }
  }

  for (const state of result.states) {
    const target = state.targets.find((candidate) => {
      const candidateName = candidate.name.toLowerCase();
      return candidateName.includes(name) || candidate.id.toLowerCase().includes(name);
    });
    if (target) return { state, target };
  }

  return null;
}

function targetIdMatches(observedTargetId: string, stateId: string, targetId: string): boolean {
  const normalized = observedTargetId.toLowerCase();
  return normalized === targetId.toLowerCase() || normalized === `${stateId}:${targetId}`.toLowerCase();
}

function findFindingForTarget(
  findings: Finding[],
  state: PageState,
  target: Target,
): Finding | undefined {
  return findings.find(
    (finding) => finding.targetId === target.id || finding.targetId === `${state.id}:${target.id}`,
  );
}

function findTargetForFinding(
  states: PageState[],
  finding: Finding,
): { state: PageState; target: Target } | null {
  for (const state of states) {
    const target = state.targets.find(
      (candidate) =>
        finding.targetId === candidate.id ||
        finding.targetId === `${state.id}:${candidate.id}`,
    );
    if (target) return { state, target };
  }
  return null;
}

/**
 * Run calibration for a single observation.
 */
function calibrateObservation(
  observation: GroundTruthObservation,
  result: AnalysisResult,
): CalibrationResult | null {
  const matched = matchFinding(observation, result);
  if (!matched) return null;
  const { finding, state, target } = matched;

  const predictedCost = computePredictedPathCost(observation, result, state, target, finding);
  const actualSteps = observation.actualStepsToReach;

  const reachabilityAccuracy =
    actualSteps > 0 && predictedCost > 0
      ? Math.min(predictedCost, actualSteps) / Math.max(predictedCost, actualSteps)
      : actualSteps === 0 && predictedCost === 0
        ? 1.0
        : 0;

  const wasQuicklyDiscovered = observation.timeToDiscoverSeconds <= 5;
  const groundTruthSeverity = difficultyToSeverity(observation.difficultyRating);
  const expectedScore = difficultyToExpectedScore(observation.difficultyRating);
  const announcementComparison = compareAnnouncementObservation(observation, target);

  return {
    targetName: observation.targetName,
    profileId: observation.profileId,
    url: observation.url,

    predictedPathCost: predictedCost,
    actualSteps,
    strategyUsed: observation.strategyUsed,
    requiredStrategySwitch: observation.requiredStrategySwitch,
    reachabilityAccuracy,
    predictedReachabilityScore: finding.scores.reachability,

    predictedDiscoverabilityScore: finding.scores.discoverability,
    wasQuicklyDiscovered,
    timeToDiscoverSeconds: observation.timeToDiscoverSeconds,

    predictedOverallScore: finding.scores.overall,
    predictedSeverity: finding.severity,
    groundTruthSeverity,
    severityMatch: finding.severity === groundTruthSeverity,

    overallScoreError: Math.abs(finding.scores.overall - expectedScore),
    expectedOverallScore: expectedScore,
    ...(announcementComparison
      ? {
          predictedAnnouncement: announcementComparison.predictedAnnouncement,
          modeledAnnouncement: announcementComparison.modeledAnnouncement,
          observedAnnouncement: announcementComparison.observedAnnouncement,
          actualAnnouncement: announcementComparison.actualAnnouncement,
          announcementSource: announcementComparison.announcementSource,
          announcementAccuracy: announcementComparison.announcementAccuracy,
          announcementMatch: announcementComparison.announcementMatch,
          missingAnnouncementTokens: announcementComparison.missingAnnouncementTokens,
          unexpectedAnnouncementTokens: announcementComparison.unexpectedAnnouncementTokens,
          announcementAssumptions: announcementComparison.announcementAssumptions,
        }
      : {}),
  };
}

function computePredictedPathCost(
  observation: GroundTruthObservation,
  result: AnalysisResult,
  state: PageState,
  target: Target,
  finding: Finding,
): number {
  const profile = getProfile(observation.profileId) ?? getProfile(finding.profile) ?? getProfile(result.metadata.profile);
  if (!profile) return finding.bestPath.length;

  const strategyCost = computeObservedStrategyCost(observation, state, target, profile);
  if (strategyCost !== null) return strategyCost;

  try {
    const graph = buildGraph(result.states, profile);
    const nodeId = `${state.id}:${target.id}`;
    if (!graph.hasNode(nodeId) || !graph.hasNode(state.id)) return finding.bestPath.length;
    const paths = computePathsFromEntries(graph, collectEntryPoints(state, graph), nodeId);
    return paths[0]?.totalCost ?? finding.bestPath.length;
  } catch {
    // Calibration should not fail entirely because a legacy result lacks a
    // graphable state shape. Fall back to the historical path-step count.
    return finding.bestPath.length;
  }
}

function computeObservedStrategyCost(
  observation: GroundTruthObservation,
  state: PageState,
  target: Target,
  profile: ATProfile,
): number | null {
  const strategy = normalizeStrategy(observation.strategyUsed);
  if (!strategy) return null;

  const sequence = sequenceForStrategy(strategy, state.targets, profile);
  if (!sequence) return null;

  const index = sequence.targets.findIndex((candidate) => candidate.id === target.id);
  if (index < 0) return null;

  /**
   * Scripted VM observations record how many real keypresses it took NVDA to
   * reach a target from the page start. The navigation graph intentionally
   * computes the best available path for scoring, including structural entry
   * points and rotor-like jumps, so using it here compares a measured
   * single-strategy run against a different strategy. For calibration, the
   * apples-to-apples prediction is the 1-based position in the same ordered
   * quick-nav / Tab sequence multiplied by that profile's action cost.
   */
  return (index + 1) * profile.actionCosts[sequence.action];
}

function normalizeStrategy(strategy: string | undefined): string | null {
  const normalized = strategy?.toLowerCase().trim();
  if (!normalized) return null;
  if (normalized === "formfield" || normalized === "form_field") return "form-field";
  if (normalized === "linear-scan" || normalized === "linear") return "linear";
  if (normalized === "heading-nav") return "heading";
  if (normalized === "landmark-nav") return "landmark";
  return normalized;
}

function sequenceForStrategy(
  strategy: string,
  targets: Target[],
  profile: ATProfile,
): { action: NavigationAction; targets: Target[] } | null {
  switch (strategy) {
    case "linear":
      return { action: "nextItem", targets };
    case "tab":
      return { action: "nextItem", targets: targets.filter(isTabNavigationTarget) };
    case "heading":
      return { action: "nextHeading", targets: targets.filter(isHeadingTarget) };
    case "link":
      return { action: "nextLink", targets: targets.filter(isLinkTarget) };
    case "button":
      return { action: "nextButton", targets: targets.filter(isButtonQuickNavTarget) };
    case "form-field":
      return { action: "nextFormField", targets: formFieldQuickNavTargets(targets, profile.id) };
    case "landmark":
      return { action: "nextLandmark", targets: targets.filter(isLandmarkQuickNavTarget) };
    default:
      return null;
  }
}

function isTabNavigationTarget(target: Target): boolean {
  return new Set([
    "button",
    "link",
    "formField",
    "menuTrigger",
    "menuItem",
    "tab",
    "search",
    "pagination",
    "disclosure",
  ]).has(target.kind);
}

function isHeadingTarget(target: Target): boolean {
  return target.kind === "heading" || target.role === "heading";
}

function isLinkTarget(target: Target): boolean {
  return target.kind === "link" || target.role === "link";
}

function isButtonQuickNavTarget(target: Target): boolean {
  return target.kind === "button" || target.kind === "menuTrigger" || target.kind === "disclosure" || target.role === "button";
}

function isLandmarkQuickNavTarget(target: Target): boolean {
  const role = target.role.toLowerCase();
  return (
    target.kind === "landmark" ||
    target.kind === "search" ||
    new Set([
      "banner",
      "navigation",
      "main",
      "contentinfo",
      "complementary",
      "region",
      "form",
      "search",
    ]).has(role)
  );
}

function calibrateAnnouncementObservation(
  observation: AnnouncementObservation,
  result: AnalysisResult,
): AnnouncementCalibrationResult | null {
  const matched = matchTarget(observation, result);
  if (!matched) return null;

  const comparison = compareAnnouncementObservation(observation, matched.target);
  if (!comparison) return null;

  return {
    targetName: observation.targetName,
    profileId: observation.profileId,
    url: observation.url,
    modeledAnnouncement: comparison.modeledAnnouncement,
    predictedAnnouncement: comparison.predictedAnnouncement,
    observedAnnouncement: comparison.observedAnnouncement,
    actualAnnouncement: comparison.actualAnnouncement,
    announcementSource: comparison.announcementSource,
    announcementAccuracy: comparison.announcementAccuracy,
    announcementMatch: comparison.announcementMatch,
    missingAnnouncementTokens: comparison.missingAnnouncementTokens,
    unexpectedAnnouncementTokens: comparison.unexpectedAnnouncementTokens,
    announcementAssumptions: comparison.announcementAssumptions,
  };
}

/**
 * Compute Pearson correlation coefficient between two arrays.
 */
function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let denX = 0;
  let denY = 0;

  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
}

/**
 * Run full calibration and produce a report.
 *
 * @param dataset - Ground-truth observations from human testers
 * @param analyses - Map of URL → AnalysisResult (run Tactual on each URL first)
 */
export function runCalibration(
  dataset: CalibrationDataset,
  analyses: Map<string, AnalysisResult>,
): CalibrationReport {
  const results: CalibrationResult[] = [];
  const announcementResults: AnnouncementCalibrationResult[] = [];

  for (const obs of dataset.observations) {
    const analysis = analyses.get(obs.url);
    if (!analysis) continue;

    const result = calibrateObservation(obs, analysis);
    if (result) results.push(result);
    const announcementResult = calibrateAnnouncementObservation(obs, analysis);
    if (announcementResult) announcementResults.push(announcementResult);
  }

  for (const obs of dataset.announcementObservations ?? []) {
    const analysis = analyses.get(obs.url);
    if (!analysis) continue;

    const result = calibrateAnnouncementObservation(obs, analysis);
    if (result) announcementResults.push(result);
  }

  // Aggregate metrics
  const predictedCosts = results.map((r) => r.predictedPathCost);
  const actualSteps = results.map((r) => r.actualSteps);
  const reachabilityMAE =
    results.length > 0
      ? results.reduce((s, r) => s + Math.abs(r.predictedPathCost - r.actualSteps), 0) / results.length
      : 0;

  const overallErrors = results.map((r) => r.overallScoreError);
  const overallScoreMAE =
    results.length > 0 ? overallErrors.reduce((a, b) => a + b, 0) / results.length : 0;

  // Bias: positive = Tactual too optimistic (scores too high)
  const predictedScores = results.map((r) => r.predictedOverallScore);
  const overallScoreBias =
    results.length > 0
      ? (predictedScores.reduce((a, b) => a + b, 0) -
          results.reduce((a, b) => a + b.expectedOverallScore, 0)) /
        results.length
      : 0;

  // Severity confusion matrix
  const bands = ["severe", "high", "moderate", "acceptable", "strong"];
  const severityConfusion: Record<string, Record<string, number>> = {};
  for (const b of bands) {
    severityConfusion[b] = {};
    for (const b2 of bands) severityConfusion[b][b2] = 0;
  }
  for (const r of results) {
    const predicted = r.predictedSeverity;
    const actual = r.groundTruthSeverity;
    if (severityConfusion[predicted]?.[actual] !== undefined) {
      severityConfusion[predicted][actual]++;
    }
  }

  const severityAccuracy =
    results.length > 0 ? results.filter((r) => r.severityMatch).length / results.length : 0;

  // Discoverability bias: positive = Tactual overestimates discoverability
  const discoverabilityBias = results.length > 0
    ? results.reduce((s, r) => {
        const expected = r.wasQuicklyDiscovered ? 80 : 40;
        return s + (r.predictedDiscoverabilityScore - expected);
      }, 0) / results.length
    : 0;

  // Reachability bias. Positive means the model predicted fewer/easier
  // steps than the tester recorded, so Tactual is optimistic.
  const reachabilityBias = results.length > 0
    ? results.reduce((s, r) => {
        return s + (r.actualSteps - r.predictedPathCost);
      }, 0) / results.length
    : 0;

  const announcementAccuracy = announcementResults.length > 0
    ? announcementResults.reduce((sum, result) => sum + (result.announcementAccuracy ?? 0), 0) /
      announcementResults.length
    : 0;

  // Recommendations
  const recommendations: string[] = [];

  if (overallScoreBias > 10) {
    recommendations.push(
      `Model is systematically optimistic (bias +${overallScoreBias.toFixed(1)}). ` +
      `Consider increasing multiplicative penalties or lowering base scores.`,
    );
  } else if (overallScoreBias < -10) {
    recommendations.push(
      `Model is systematically pessimistic (bias ${overallScoreBias.toFixed(1)}). ` +
      `Consider reducing penalties or raising base scores.`,
    );
  }

  if (discoverabilityBias > 15) {
    recommendations.push(
      `Discoverability is overestimated (bias +${discoverabilityBias.toFixed(1)}). ` +
      `Consider reducing the heading/landmark factor weights.`,
    );
  }

  if (reachabilityMAE > 5) {
    recommendations.push(
      `Reachability path cost prediction has high error (MAE ${reachabilityMAE.toFixed(1)} steps). ` +
      `Graph model may be missing navigation paths that real users take.`,
    );
  }

  if (reachabilityBias > 3) {
    recommendations.push(
      `Reachability is optimistic by ${reachabilityBias.toFixed(1)} steps on average. ` +
      `Increase path costs or add missing detours/mode switches for this profile.`,
    );
  } else if (reachabilityBias < -3) {
    recommendations.push(
      `Reachability is pessimistic by ${Math.abs(reachabilityBias).toFixed(1)} steps on average. ` +
      `The graph may be over-counting actions or missing efficient AT shortcuts.`,
    );
  }

  if (severityAccuracy < 0.5) {
    recommendations.push(
      `Severity predictions match ground truth only ${(severityAccuracy * 100).toFixed(0)}% of the time. ` +
      `Severity band thresholds may need adjustment.`,
    );
  }

  if (results.length < 30) {
    recommendations.push(
      `Only ${results.length} observations matched. Collect more data for ` +
      `statistically meaningful calibration (target: 50+ per profile).`,
    );
  }

  if (announcementResults.some((result) => result.announcementMatch === false)) {
    recommendations.push(
      `Observed announcements diverged from the simulator for ${
        announcementResults.filter((result) => result.announcementMatch === false).length
      } target(s). Review missing/extra tokens before tuning announcement phrasing.`,
    );
  }

  const scoringSignals = buildCalibrationScoringSignals({
    results,
    announcementResults,
    overallScoreBias,
    discoverabilityBias,
    reachabilityMAE,
    reachabilityBias,
    severityAccuracy,
  });

  return {
    datasetName: dataset.name,
    observationCount: results.length,
    results,
    reachabilityMAE,
    reachabilityCorrelation: pearsonCorrelation(predictedCosts, actualSteps),
    severityAccuracy,
    severityConfusion,
    overallScoreMAE,
    overallScoreBias,
    announcementObservationCount: announcementResults.length,
    announcementAccuracy,
    announcementResults,
    scoringSignals,
    dimensionBias: {
      discoverability: discoverabilityBias,
      reachability: reachabilityBias,
    },
    recommendations,
  };
}

function buildCalibrationScoringSignals(args: {
  results: CalibrationResult[];
  announcementResults: AnnouncementCalibrationResult[];
  overallScoreBias: number;
  discoverabilityBias: number;
  reachabilityMAE: number;
  reachabilityBias: number;
  severityAccuracy: number;
}): CalibrationScoringSignal[] {
  const signals: CalibrationScoringSignal[] = [];

  if (args.results.length > 0) {
    const reachabilityStatus =
      args.reachabilityMAE <= 2 && Math.abs(args.reachabilityBias) <= 1.5
        ? "confirmed"
        : "review";
    signals.push({
      id: "reachability.ground-truth-fit",
      kind: "observed-reachability",
      dimension: "reachability",
      status: reachabilityStatus,
      confidence: boundedConfidence(1 - Math.min(1, args.reachabilityMAE / 12)),
      summary:
        reachabilityStatus === "confirmed"
          ? `Predicted path costs fit observed steps with MAE ${args.reachabilityMAE.toFixed(1)}`
          : `Predicted path costs diverge from observed steps with MAE ${args.reachabilityMAE.toFixed(1)} and bias ${formatSigned(args.reachabilityBias)}`,
      scoringImplication:
        reachabilityStatus === "confirmed"
          ? "Use this dataset as regression evidence for current profile action costs."
          : "Review action costs, missing detours, and calibrated quick-nav reachability before tuning score weights.",
      evidence: {
        count: args.results.length,
        examples: args.results.slice(0, 4).map((result) =>
          `${result.targetName}: predicted ${result.predictedPathCost}, observed ${result.actualSteps}`,
        ),
      },
    });

    const switchCount = args.results.filter((result) => result.requiredStrategySwitch === true).length;
    if (switchCount > 0) {
      signals.push({
        id: "navigation.strategy-switch-pressure",
        kind: "strategy-switch",
        dimension: "reachability",
        status: "review",
        confidence: boundedConfidence(0.45 + switchCount / Math.max(10, args.results.length * 2)),
        summary: `${switchCount} observation(s) required a strategy switch`,
        scoringImplication: "Add or tune mode-transition costs when users need to abandon the modeled best path.",
        evidence: {
          count: switchCount,
          examples: args.results.filter((result) => result.requiredStrategySwitch === true).slice(0, 4).map((result) =>
            `${result.targetName}: ${result.strategyUsed ?? "unknown strategy"}`,
          ),
        },
      });
    }

    if (Math.abs(args.overallScoreBias) > 10 || args.severityAccuracy < 0.5) {
      signals.push({
        id: "score.overall-bias",
        kind: "score-bias",
        dimension: "overall",
        status: "review",
        confidence: boundedConfidence(Math.min(1, Math.abs(args.overallScoreBias) / 25)),
        summary: `Overall score bias is ${formatSigned(args.overallScoreBias)} with ${(args.severityAccuracy * 100).toFixed(0)}% severity accuracy`,
        scoringImplication: "Tune score weights or severity bands only after checking whether the underlying reachability/discoverability signals explain the bias.",
        evidence: {
          count: args.results.length,
          examples: args.results.slice(0, 4).map((result) =>
            `${result.targetName}: predicted ${result.predictedOverallScore}, expected ${result.expectedOverallScore}`,
          ),
        },
      });
    }

    if (Math.abs(args.discoverabilityBias) > 15) {
      signals.push({
        id: "score.discoverability-bias",
        kind: "score-bias",
        dimension: "discoverability",
        status: "review",
        confidence: boundedConfidence(Math.min(1, Math.abs(args.discoverabilityBias) / 30)),
        summary: `Discoverability bias is ${formatSigned(args.discoverabilityBias)}`,
        scoringImplication: "Review heading, landmark, name, search, and branch-open factors against observed discovery time.",
        evidence: {
          count: args.results.length,
          examples: args.results.slice(0, 4).map((result) =>
            `${result.targetName}: predicted discoverability ${result.predictedDiscoverabilityScore}`,
          ),
        },
      });
    }
  }

  const announcementMisses = args.announcementResults.filter((result) => result.announcementMatch === false);
  if (announcementMisses.length > 0) {
    signals.push({
      id: "announcement.mapper-drift",
      kind: "mapper-phrasing",
      dimension: "confidence",
      status: "review",
      confidence: boundedConfidence(0.5 + announcementMisses.length / Math.max(10, args.announcementResults.length * 2)),
      summary: `${announcementMisses.length} observed announcement(s) diverged from modeled speech`,
      scoringImplication: "Lower confidence in affected findings until repeated mapper drift is resolved or marked AT-version-specific.",
      evidence: {
        count: announcementMisses.length,
        examples: announcementMisses.slice(0, 4).map((result) =>
          `${result.targetName}: missing ${result.missingAnnouncementTokens.join("|") || "none"}`,
        ),
      },
    });
  }

  if (signals.length === 0) {
    signals.push({
      id: "calibration.no-actionable-scoring-signal",
      kind: "no-actionable-signal",
      dimension: "confidence",
      status: "confirmed",
      confidence: 1,
      summary: "No scoring-relevant drift detected in matched calibration observations",
      scoringImplication: "Use this dataset as regression evidence, but do not tune weights from it.",
      evidence: { count: 0, examples: [] },
    });
  }

  return signals;
}

function boundedConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

function formatSigned(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

/**
 * Format a calibration report for human consumption.
 */
export function formatCalibrationReport(report: CalibrationReport): string {
  const lines: string[] = [];

  lines.push(`# Calibration Report: ${report.datasetName}`);
  lines.push(`Observations: ${report.observationCount}`);
  lines.push("");

  lines.push("## Aggregate Metrics");
  lines.push(`Overall Score MAE: ${report.overallScoreMAE.toFixed(1)} points`);
  lines.push(`Overall Score Bias: ${report.overallScoreBias > 0 ? "+" : ""}${report.overallScoreBias.toFixed(1)} (positive = too optimistic)`);
  lines.push(`Severity Accuracy: ${(report.severityAccuracy * 100).toFixed(0)}%`);
  lines.push(`Reachability MAE: ${report.reachabilityMAE.toFixed(1)} steps`);
  lines.push(`Reachability Correlation: ${report.reachabilityCorrelation.toFixed(3)}`);
  if (report.announcementObservationCount > 0) {
    lines.push(
      `Announcement Accuracy: ${(report.announcementAccuracy * 100).toFixed(0)}% ` +
      `(${report.announcementObservationCount} observed)`,
    );
  }
  lines.push("");

  lines.push("## Dimension Bias");
  lines.push(`Discoverability: ${report.dimensionBias.discoverability > 0 ? "+" : ""}${report.dimensionBias.discoverability.toFixed(1)}`);
  lines.push(`Reachability: ${report.dimensionBias.reachability > 0 ? "+" : ""}${report.dimensionBias.reachability.toFixed(1)} (positive = too optimistic)`);
  lines.push("");

  if (report.scoringSignals.length > 0) {
    lines.push("## Scoring Signals");
    for (const signal of report.scoringSignals) {
      lines.push(
        `- ${signal.id} [${signal.status} ${signal.kind}/${signal.dimension}]: ` +
          `${signal.summary} (${Math.round(signal.confidence * 100)}% confidence)`,
      );
      lines.push(`  Implication: ${signal.scoringImplication}`);
    }
    lines.push("");
  }

  lines.push("## Severity Confusion Matrix");
  lines.push("(rows = predicted, columns = ground truth)");
  lines.push("");
  const bands = ["severe", "high", "moderate", "acceptable", "strong"];
  lines.push(`| | ${bands.join(" | ")} |`);
  lines.push(`|---|${bands.map(() => "---").join("|")}|`);
  for (const predicted of bands) {
    const row = bands.map((actual) => String(report.severityConfusion[predicted]?.[actual] ?? 0));
    lines.push(`| **${predicted}** | ${row.join(" | ")} |`);
  }
  lines.push("");

  if (report.recommendations.length > 0) {
    lines.push("## Recommendations");
    for (const rec of report.recommendations) {
      lines.push(`- ${rec}`);
    }
    lines.push("");
  }

  // Per-target details (worst predictions first)
  const sorted = [...report.results].sort((a, b) => b.overallScoreError - a.overallScoreError);
  lines.push("## Worst Predictions");
  for (const r of sorted.slice(0, 10)) {
    lines.push(
      `- **${r.targetName}** (${r.url}): predicted=${r.predictedOverallScore} ` +
      `(${r.predictedSeverity}), ground-truth=${r.groundTruthSeverity}, ` +
      `error=${r.overallScoreError}, reach predicted=${r.predictedPathCost} actual=${r.actualSteps}`,
    );
  }

  const announcementMismatches = report.announcementResults.filter((r) => r.announcementMatch === false);
  if (announcementMismatches.length > 0) {
    lines.push("");
    lines.push("## Announcement Mismatches");
    for (const r of announcementMismatches.slice(0, 10)) {
      const missing = r.missingAnnouncementTokens?.join(", ") || "none";
      const unexpected = r.unexpectedAnnouncementTokens?.join(", ") || "none";
      lines.push(`- **${r.targetName}**: modeled="${r.modeledAnnouncement}" observed="${r.observedAnnouncement ?? "(tokens only)"}" source=${r.announcementSource} missing=[${missing}] unexpected=[${unexpected}]`);
    }
  }

  const challengedAssumptions = summarizeChallengedAssumptions(report.announcementResults);
  if (challengedAssumptions.length > 0) {
    lines.push("");
    lines.push("## AT Mapper Assumptions To Review");
    for (const item of challengedAssumptions.slice(0, 10)) {
      lines.push(
        `- ${item.id}: ${item.count} ${item.status} ` +
          `(${item.kind}, expected="${item.expected || "(none)"}", source=${item.source ?? "unknown"})`,
      );
    }
  }

  return lines.join("\n");
}

function summarizeChallengedAssumptions(
  results: AnnouncementCalibrationResult[],
): Array<{
  id: string;
  status: "missing" | "unexpected";
  kind: string;
  expected: string;
  source?: string;
  count: number;
}> {
  const groups = new Map<string, {
    id: string;
    status: "missing" | "unexpected";
    kind: string;
    expected: string;
    source?: string;
    count: number;
  }>();

  for (const result of results) {
    for (const assumption of result.announcementAssumptions ?? []) {
      if (assumption.status === "confirmed") continue;
      const status = assumption.status;
      const key = `${assumption.id}|${status}|${assumption.expected}|${assumption.observed ?? ""}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        groups.set(key, {
          id: assumption.id,
          status,
          kind: assumption.kind,
          expected: assumption.expected || assumption.observed || "",
          source: assumption.source,
          count: 1,
        });
      }
    }
  }

  return [...groups.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}
