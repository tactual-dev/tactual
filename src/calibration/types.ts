/**
 * Calibration data types.
 *
 * These types define the ground-truth data format that human testers
 * produce and the analysis results that Tactual produces. The calibration
 * runner compares them to measure prediction accuracy and identify
 * where the scoring model's weights need adjustment.
 */

import type { ATKind } from "../playwright/sr-simulator.js";
import type { AnnouncementPartKind } from "../playwright/sr-simulator.js";

export type AnnouncementSource =
  | "manual-sr"
  | "nvda-vm"
  | "virtual-sr"
  | "fixture"
  | "aria-at"
  | "other";

/**
 * A lightweight observation for comparing Tactual's modeled speech tokens
 * with output a tester heard, a fixture asserted, or a virtual SR produced.
 *
 * Prefer this shape when the reviewer only needs to record announcement
 * evidence. A full GroundTruthObservation is still useful when the same
 * session also captured reachability, discoverability, operability, and
 * recovery data.
 */
export interface AnnouncementObservation {
  /** URL of the page tested */
  url: string;
  /** Which AT profile was used (maps to Tactual profile ID) */
  profileId: string;
  /** Which target on the page (matched by name or selector) */
  targetName: string;
  /** Optional stable target id, preferably stateId:targetId from full analysis JSON. */
  targetId?: string;
  /** Optional CSS selector for precise matching */
  targetSelector?: string;
  /** Optional AT override for announcement comparison. Defaults from profileId when possible. */
  announcementAt?: ATKind;
  /** Preferred field: output observed during review or produced by a deterministic fixture. */
  observedAnnouncement?: string;
  /**
   * Preferred token field. Use this when exact phrasing is noisy but the
   * important role/name/state terms are known.
   */
  observedAnnouncementTokens?: string[];
  /**
   * Compatibility alias for pre-release datasets. Prefer observedAnnouncement
   * for new data; "actual" can imply a level of AT-version/context certainty
   * Tactual cannot guarantee.
   */
  actualAnnouncement?: string;
  /** Compatibility alias for pre-release datasets. Prefer observedAnnouncementTokens. */
  actualAnnouncementTokens?: string[];
  /** Where the observed announcement came from. Defaults to manual-sr. */
  announcementSource?: AnnouncementSource;
  /** AT software and version */
  atVersion?: string;
  /** Browser and version */
  browser?: string;
  /** Tester identifier (anonymous) */
  testerId?: string;
  /** ISO timestamp */
  timestamp: string;
  /** Free-form notes about verbosity settings, mode, page state, or uncertainty. */
  announcementNotes?: string;
}

/**
 * A single ground-truth observation: a human tester reports how many
 * actions it actually took to reach and operate a specific target
 * using a specific AT.
 */
export interface GroundTruthObservation extends AnnouncementObservation {
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

  /**
   * Optional provenance for full observations. `nvda-vm-scripted` means the
   * record was derived from a deterministic VM sequence: useful for
   * reachability/action-cost calibration, but not a substitute for manual
   * subjective testing of operability, recovery, or perceived difficulty.
   */
  observationSource?: "manual-sr" | "nvda-vm-scripted" | "fixture-derived" | "other";

  /** Per-dimension interpretation hints for mixed-quality calibration evidence. */
  observationUse?: {
    reachability?: boolean;
    announcement?: boolean;
    discoverability?: boolean | "proxy";
    severity?: boolean | "proxy";
    operability?: boolean;
    recovery?: boolean;
    notes?: string;
  };
}

/**
 * A calibration dataset: a set of ground-truth observations for specific pages.
 */
export interface CalibrationDataset {
  /** Dataset name/version */
  name: string;
  /** When collected */
  collectedAt: string;
  /** Full navigation-cost observations */
  observations: GroundTruthObservation[];
  /** Optional announcement-only observations */
  announcementObservations?: AnnouncementObservation[];
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
  /** Navigation strategy the tester used for this target. */
  strategyUsed?: string;
  /** Whether the tester had to switch strategies before reaching the target. */
  requiredStrategySwitch?: boolean;
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
  /** Score implied by the ground-truth difficulty rating. */
  expectedOverallScore: number;
  /** Tactual's modeled announcement for this target and AT, when observed output was supplied. */
  predictedAnnouncement?: string;
  /** Compatibility alias for modeled announcement. */
  modeledAnnouncement?: string;
  /** Preferred field: observed announcement text supplied by the calibration observation. */
  observedAnnouncement?: string;
  /** Compatibility alias for pre-release result consumers. */
  actualAnnouncement?: string;
  /** Where the observed announcement came from. */
  announcementSource?: AnnouncementSource;
  /** Fraction of modeled announcement tokens observed in tested output. */
  announcementAccuracy?: number;
  /** Whether all predicted announcement tokens were observed; extra AT context is tracked separately. */
  announcementMatch?: boolean;
  /** Modeled role/name/state tokens missing from the observed announcement. */
  missingAnnouncementTokens?: string[];
  /** Supplied actual tokens that the simulator did not predict. */
  unexpectedAnnouncementTokens?: string[];
  /** Per-token mapper assumptions confirmed or challenged by observed output. */
  announcementAssumptions?: AnnouncementAssumptionResult[];
}

export type AnnouncementAssumptionStatus = "confirmed" | "missing" | "unexpected";

export interface AnnouncementAssumptionResult {
  /** Stable mapper assumption ID, for example `announcement.nvda.role.button`. */
  id: string;
  /** Which announcement part the assumption produced. */
  kind: AnnouncementPartKind | "unexpected";
  /** Evidence status after comparing modeled output with observed/tested output. */
  status: AnnouncementAssumptionStatus;
  /** Normalized modeled token, when this is a modeled assumption. */
  expected: string;
  /** Original modeled text before normalization. */
  expectedText?: string;
  /** Normalized observed token that was not modeled. */
  observed?: string;
  /** Pre-evidence mapper confidence in the assumption. */
  confidence?: number;
  /** Short provenance label for the assumption. */
  source?: string;
}

export interface AnnouncementCalibrationResult {
  targetName: string;
  profileId: string;
  url: string;
  modeledAnnouncement: string;
  /** Compatibility alias for modeledAnnouncement. */
  predictedAnnouncement: string;
  observedAnnouncement?: string;
  /** Compatibility alias for observedAnnouncement. */
  actualAnnouncement?: string;
  announcementSource: AnnouncementSource;
  announcementAccuracy: number;
  announcementMatch: boolean;
  missingAnnouncementTokens: string[];
  unexpectedAnnouncementTokens: string[];
  /** Per-token mapper assumptions confirmed or challenged by observed output. */
  announcementAssumptions: AnnouncementAssumptionResult[];
}

export type CalibrationScoringSignalKind =
  | "observed-reachability"
  | "score-bias"
  | "strategy-switch"
  | "context-verbosity"
  | "target-name-coalescing"
  | "mapper-phrasing"
  | "value-speech"
  | "harness-health"
  | "no-actionable-signal";

export type CalibrationScoringDimension =
  | "overall"
  | "discoverability"
  | "reachability"
  | "operability"
  | "recovery"
  | "interopRisk"
  | "confidence";

export type CalibrationScoringSignalStatus =
  | "confirmed"
  | "review"
  | "blocked"
  | "observed-only";

export interface CalibrationScoringSignal {
  /** Stable signal ID, for example `speech.context-verbosity`. */
  id: string;
  /** Evidence category the scoring layer can reason about. */
  kind: CalibrationScoringSignalKind;
  /** Score dimension this signal may affect after review. */
  dimension: CalibrationScoringDimension;
  /**
   * Whether this signal confirms the current model, needs review before
   * changing weights, is harness-blocked, or should remain target-specific
   * observation data only.
   */
  status: CalibrationScoringSignalStatus;
  /** Confidence in the evidence extraction, not a score-weight multiplier. */
  confidence: number;
  /** Short human-readable evidence summary. */
  summary: string;
  /** How a future scoring pass should interpret this evidence. */
  scoringImplication: string;
  /** Count and examples from the underlying batch/review artifacts. */
  evidence: {
    count: number;
    examples: string[];
  };
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
  reachabilityCorrelation: number;

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
  /** Observations with observedAnnouncement/observedAnnouncementTokens or compatibility aliases. */
  announcementObservationCount: number;
  /** Average announcement-token accuracy across observations with tested announcements. */
  announcementAccuracy: number;
  /** Announcement-only and full-observation announcement comparisons. */
  announcementResults: AnnouncementCalibrationResult[];
  /** Structured calibration evidence that can guide future scoring changes. */
  scoringSignals: CalibrationScoringSignal[];

  // --- Per-dimension bias ---
  /** Average direction of error per dimension */
  dimensionBias: {
    discoverability: number;
    /** Positive means Tactual predicted fewer/easier steps than were observed. */
    reachability: number;
  };

  // --- Recommendations ---
  recommendations: string[];
}
