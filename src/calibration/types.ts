/**
 * Calibration data types.
 *
 * These types define the ground-truth data format that human testers
 * produce and the analysis results that Tactual produces. The calibration
 * runner compares them to measure prediction accuracy and identify
 * where the scoring model's weights need adjustment.
 */

/**
 * A single ground-truth observation: a human tester reports how many
 * actions it actually took to reach and operate a specific target
 * using a specific AT.
 */
export interface GroundTruthObservation {
  /** URL of the page tested */
  url: string;
  /** Which AT profile was used (maps to Tactual profile ID) */
  profileId: string;
  /** Which target on the page (matched by name or selector) */
  targetName: string;
  /** Optional CSS selector for precise matching */
  targetSelector?: string;

  // --- Reachability ground truth ---
  /** Actual number of discrete actions to reach the target from page load */
  actualStepsToReach: number;
  /** Navigation strategy used: "linear" (swipe), "heading", "landmark", "search", "mixed" */
  strategyUsed: string;
  /** Whether the tester needed to try multiple strategies before reaching the target */
  requiredStrategySwitch: boolean;

  // --- Discoverability ground truth ---
  /** Did the tester know the target existed before looking for it? */
  knewTargetExisted: boolean;
  /** How many seconds to find the target (0 = immediately obvious) */
  timeToDiscoverSeconds: number;
  /** Method of discovery: "heading-nav", "landmark-nav", "linear-scan", "search", "guessed" */
  discoveryMethod: string;

  // --- Operability ground truth ---
  /** Was the tester able to activate/operate the target? */
  couldOperate: boolean;
  /** Any issues encountered (free text) */
  operabilityNotes?: string;

  // --- Recovery ground truth ---
  /** After operating, could the tester return to where they were? */
  couldRecover: boolean;
  /** How many actions to return to a known position? */
  recoverySteps?: number;

  // --- Overall subjective rating ---
  /** 1-5 difficulty rating (1 = trivial, 5 = blocking) */
  difficultyRating: 1 | 2 | 3 | 4 | 5;

  // --- Metadata ---
  /** Tester identifier (anonymous) */
  testerId: string;
  /** AT software and version */
  atVersion?: string;
  /** Browser and version */
  browser?: string;
  /** ISO timestamp */
  timestamp: string;
}

/**
 * A calibration dataset: a set of ground-truth observations for specific pages.
 */
export interface CalibrationDataset {
  /** Dataset name/version */
  name: string;
  /** When collected */
  collectedAt: string;
  /** Observations */
  observations: GroundTruthObservation[];
}

/**
 * Result of comparing Tactual predictions against ground truth for one target.
 */
export interface CalibrationResult {
  /** Target identifier */
  targetName: string;
  /** Profile used */
  profileId: string;
  /** URL tested */
  url: string;

  // --- Reachability comparison ---
  /** Tactual's predicted path cost (from graph) */
  predictedPathCost: number;
  /** Actual steps from ground truth */
  actualSteps: number;
  /** Ratio: predicted / actual. 1.0 = perfect calibration */
  reachabilityAccuracy: number;
  /** Tactual's reachability score (0-100) */
  predictedReachabilityScore: number;

  // --- Discoverability comparison ---
  /** Tactual's discoverability score (0-100) */
  predictedDiscoverabilityScore: number;
  /** Ground truth: was it quickly discovered? */
  wasQuicklyDiscovered: boolean;
  /** Ground truth time to discover */
  timeToDiscoverSeconds: number;

  // --- Severity comparison ---
  /** Tactual's overall score */
  predictedOverallScore: number;
  /** Tactual's severity band */
  predictedSeverity: string;
  /** Expected severity from difficulty rating mapping */
  groundTruthSeverity: string;
  /** Do they agree? */
  severityMatch: boolean;

  // --- Error metrics ---
  /** Absolute error in overall score (vs difficulty-mapped expected score) */
  overallScoreError: number;
}

/**
 * Aggregate calibration statistics across a full dataset.
 */
export interface CalibrationReport {
  datasetName: string;
  observationCount: number;
  results: CalibrationResult[];

  // --- Aggregate reachability ---
  /** Mean absolute error between predicted path cost and actual steps */
  reachabilityMAE: number;
  /** Pearson correlation between predicted cost and actual steps */
  reachabilityCorrrelation: number;

  // --- Aggregate severity ---
  /** Fraction of targets where predicted severity matches ground truth */
  severityAccuracy: number;
  /** Confusion matrix: predicted × actual severity band */
  severityConfusion: Record<string, Record<string, number>>;

  // --- Aggregate score ---
  /** Mean absolute error in overall score */
  overallScoreMAE: number;
  /** Bias: positive = Tactual is too optimistic, negative = too pessimistic */
  overallScoreBias: number;

  // --- Per-dimension bias ---
  /** Average direction of error per dimension */
  dimensionBias: {
    discoverability: number;
    reachability: number;
  };

  // --- Recommendations ---
  recommendations: string[];
}
