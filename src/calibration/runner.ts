/**
 * Calibration runner.
 *
 * Compares Tactual's predictions against ground-truth observations
 * from human testers to measure scoring accuracy and identify
 * systematic bias in the model's weights.
 */

import type { AnalysisResult, Finding } from "../core/types.js";
import type {
  GroundTruthObservation,
  CalibrationDataset,
  CalibrationResult,
  CalibrationReport,
} from "./types.js";

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
  observation: GroundTruthObservation,
  result: AnalysisResult,
): Finding | null {
  const name = observation.targetName.toLowerCase();

  // Try exact selector match first
  if (observation.targetSelector) {
    for (const state of result.states) {
      for (const target of state.targets) {
        if (target.selector === observation.targetSelector) {
          const finding = result.findings.find((f) => f.targetId === target.id);
          if (finding) return finding;
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
        return finding;
      }
    }

    // Last resort: match against targetId itself
    if (finding.targetId.toLowerCase().includes(name)) {
      return finding;
    }
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
  const finding = matchFinding(observation, result);
  if (!finding) return null;

  const predictedCost = finding.bestPath.length;
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

  return {
    targetName: observation.targetName,
    profileId: observation.profileId,
    url: observation.url,

    predictedPathCost: predictedCost,
    actualSteps,
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

  for (const obs of dataset.observations) {
    const analysis = analyses.get(obs.url);
    if (!analysis) continue;

    const result = calibrateObservation(obs, analysis);
    if (result) results.push(result);
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
  const expectedScores = dataset.observations
    .map((o) => difficultyToExpectedScore(o.difficultyRating));
  const predictedScores = results.map((r) => r.predictedOverallScore);
  const overallScoreBias =
    results.length > 0
      ? (predictedScores.reduce((a, b) => a + b, 0) -
          expectedScores.slice(0, results.length).reduce((a, b) => a + b, 0)) /
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

  // Reachability bias
  const reachabilityBias = results.length > 0
    ? results.reduce((s, r) => {
        // If actual steps > predicted, the model is optimistic (positive bias)
        return s + (r.predictedPathCost - r.actualSteps);
      }, 0) / results.length
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
    dimensionBias: {
      discoverability: discoverabilityBias,
      reachability: reachabilityBias,
    },
    recommendations,
  };
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
  lines.push("");

  lines.push("## Dimension Bias");
  lines.push(`Discoverability: ${report.dimensionBias.discoverability > 0 ? "+" : ""}${report.dimensionBias.discoverability.toFixed(1)}`);
  lines.push(`Reachability: ${report.dimensionBias.reachability > 0 ? "+" : ""}${report.dimensionBias.reachability.toFixed(1)}`);
  lines.push("");

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

  return lines.join("\n");
}
