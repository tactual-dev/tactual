import type { ScoreVector, SeverityBand } from "../core/types.js";
import { severityFromScore } from "../core/types.js";
import type { ATProfile } from "../profiles/types.js";

export interface ScoreInputs {
  discoverability: DiscoverabilityInputs;
  reachability: ReachabilityInputs;
  operability: OperabilityInputs;
  recovery: RecoveryInputs;
  interopRisk: number;
}

export interface DiscoverabilityInputs {
  /** Present under a task-relevant heading? */
  inHeadingStructure: boolean;
  /** Heading level (lower = more prominent) */
  headingLevel?: number;
  /** Present in a landmark/region? */
  inLandmark: boolean;
  /** Reachable via link/control navigation? */
  inControlNavigation: boolean;
  /** Has a clear accessible name? */
  hasAccessibleName: boolean;
  /** Has a clear role? */
  hasRole: boolean;
  /** Discoverable via find/search? */
  searchDiscoverable: boolean;
  /** Only exists after a hidden branch is opened? */
  requiresBranchOpen: boolean;
  /**
   * Quality of the branch trigger (only relevant when requiresBranchOpen is true).
   */
  branchTriggerQuality?: "well-labeled" | "labeled" | "unlabeled";
  /** Target has aria-keyshortcuts — SR announces the shortcut, boosting discoverability */
  hasKeyboardShortcut?: boolean;
}

export interface ReachabilityInputs {
  /** Shortest action path cost from a plausible entry point */
  shortestPathCost: number;
  /** Median path cost across plausible entry points */
  medianPathCost: number;
  /** Number of unrelated items passed on the shortest path */
  unrelatedItemsOnPath: number;
  /** Whether the path involves a context switch */
  involvesContextSwitch: boolean;
  /** Whether a hidden branch must be opened first */
  requiresBranchOpen: boolean;
  /** Quality of the branch trigger (scales the branch penalty) */
  branchTriggerQuality?: "well-labeled" | "labeled" | "unlabeled";
  /** Total number of targets in the state (for normalization) */
  totalTargets: number;
  /** Whether the best path uses skip navigation (headings/landmarks) */
  usesSkipNavigation: boolean;
}

export interface OperabilityInputs {
  /** Role is correct and semantically coherent? */
  roleCorrect: boolean;
  /** State changes are announced? */
  stateChangesAnnounced: boolean;
  /** Focus is placed correctly after activation? */
  focusCorrectAfterActivation: boolean;
  /** Keyboard/action compatible with the pattern? */
  keyboardCompatible: boolean;
}

export interface RecoveryInputs {
  /** Can the user dismiss/back out? */
  canDismiss: boolean;
  /** Does focus return to a logical place? */
  focusReturnsLogically: boolean;
  /** Can the user relocate previous context without large detour? */
  canRelocateContext: boolean;
  /** Are overlays/branches predictable? */
  branchesPredictable: boolean;
}

// ---------------------------------------------------------------------------
// Scoring functions
// ---------------------------------------------------------------------------

/**
 * Multiplicative discoverability scoring.
 *
 * Each structural signal is a factor > 1 (present) or < 1 (absent).
 * Factors compound: having heading + landmark + name is worth more than
 * the sum of the parts, and missing all three is worse than missing any one.
 *
 * The base starts at 40 (a bare element with nothing), and factors scale
 * it up toward 100 or down toward 0.
 */
function scoreDiscoverability(inputs: DiscoverabilityInputs): number {
  let score = 40; // Bare minimum: element exists

  // Heading structure is the strongest signal (WebAIM 71.6%)
  score *= inputs.inHeadingStructure ? 1.55 : 0.55;

  // Higher-level headings compound the heading benefit
  if (inputs.inHeadingStructure && inputs.headingLevel !== undefined && inputs.headingLevel <= 2) {
    score *= 1.08;
  }

  // Landmark presence
  score *= inputs.inLandmark ? 1.25 : 0.80;

  // Control/link navigation
  score *= inputs.inControlNavigation ? 1.20 : 0.90;

  // Accessible name clarity
  score *= inputs.hasAccessibleName ? 1.20 : 0.60;

  // Role clarity
  score *= inputs.hasRole ? 1.10 : 0.75;

  // Search discoverability
  score *= inputs.searchDiscoverable ? 1.08 : 0.95;

  // Keyboard shortcut bonus — SR announces aria-keyshortcuts, making the
  // target discoverable via shortcut announcement and reachable via direct key
  if (inputs.hasKeyboardShortcut) score *= 1.15;

  // Hidden branch penalty — scaled by trigger quality.
  // A well-labeled trigger (aria-haspopup + name) dramatically reduces discovery cost.
  if (inputs.requiresBranchOpen) {
    const branchFactor = {
      "well-labeled": 0.85,
      "labeled": 0.75,
      "unlabeled": 0.55,
    }[inputs.branchTriggerQuality ?? "unlabeled"];
    score *= branchFactor;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Reachability scoring with median robustness.
 *
 * Two-factor scoring: absolute cost + navigation efficiency, plus a
 * robustness penalty when the median cost is much higher than the best.
 */
function scoreReachability(inputs: ReachabilityInputs, costSensitivity: number): number {
  // Absolute cost score (asymptotic decay, scaled by profile cost sensitivity).
  const decayCoefficient = 0.04 * costSensitivity;
  const absoluteScore = 100 * Math.exp(-decayCoefficient * Math.max(0, inputs.shortestPathCost - 1));

  // Navigation efficiency: how much of the page can you skip?
  const efficiency = inputs.totalTargets > 1
    ? Math.max(0, 1 - inputs.shortestPathCost / inputs.totalTargets)
    : 1;

  // Efficiency bonus: on large pages, good skip navigation should be rewarded.
  const efficiencyBonus = efficiency * 30;

  // Skip navigation bonus: if the best path uses heading/landmark navigation
  // rather than pure linear traversal, that indicates good page structure.
  const skipBonus = inputs.usesSkipNavigation ? 10 : 0;

  // Blend: absolute score (base) + efficiency bonus + skip bonus
  let score = absoluteScore * 0.6 + efficiencyBonus + skipBonus;

  // Robustness penalty: if the median path cost is much higher than the
  // shortest, the target is only cheaply reachable from one specific entry
  // point. This is fragile — a user starting anywhere else pays a lot more.
  // Ratio > 2 means the median is more than double the best.
  if (inputs.shortestPathCost > 0 && inputs.medianPathCost > inputs.shortestPathCost) {
    const robustnessRatio = inputs.medianPathCost / inputs.shortestPathCost;
    if (robustnessRatio > 2) {
      // Penalty scales with how fragile the reachability is, capped at -15
      score -= Math.min(15, (robustnessRatio - 2) * 5);
    }
  }

  // Unrelated content tax (linear traversal through irrelevant items)
  if (inputs.unrelatedItemsOnPath > 5) {
    score -= (inputs.unrelatedItemsOnPath - 5) * 1.5;
  }

  // Context switch penalty
  if (inputs.involvesContextSwitch) score -= 5;

  // Hidden branch penalty — scaled by trigger quality
  if (inputs.requiresBranchOpen) {
    const branchPenalty = {
      "well-labeled": 4,
      "labeled": 8,
      "unlabeled": 14,
    }[inputs.branchTriggerQuality ?? "unlabeled"];
    score -= branchPenalty;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreOperability(inputs: OperabilityInputs): number {
  let score = 0;
  if (inputs.roleCorrect) score += 30;
  if (inputs.stateChangesAnnounced) score += 25;
  if (inputs.focusCorrectAfterActivation) score += 25;
  if (inputs.keyboardCompatible) score += 20;
  return Math.max(0, Math.min(100, score));
}

function scoreRecovery(inputs: RecoveryInputs): number {
  let score = 0;
  if (inputs.canDismiss) score += 30;
  if (inputs.focusReturnsLogically) score += 30;
  if (inputs.canRelocateContext) score += 25;
  if (inputs.branchesPredictable) score += 15;
  return Math.max(0, Math.min(100, score));
}

/**
 * Compute the full score vector for a target under a profile.
 *
 * The composite uses a **weighted geometric mean** so that a zero (or near-zero)
 * in any dimension drags the overall down sharply. This models the real user
 * experience: you can't operate what you can't reach, and you can't reach
 * what you can't discover.
 *
 * To avoid log(0) issues, each dimension is floored at 1 before the
 * geometric mean. The result is then clamped to [0, 100].
 */
export function computeScores(inputs: ScoreInputs, profile: ATProfile): ScoreVector {
  const d = scoreDiscoverability(inputs.discoverability);
  const r = scoreReachability(inputs.reachability, profile.costSensitivity ?? 1.0);
  const o = scoreOperability(inputs.operability);
  const rec = scoreRecovery(inputs.recovery);
  const interop = inputs.interopRisk;

  // Weighted geometric mean: exp( sum(w_i * ln(s_i)) / sum(w_i) )
  // Floor each dimension at 1 to avoid log(0).
  const wd = profile.weights.discoverability;
  const wr = profile.weights.reachability;
  const wo = profile.weights.operability;
  const wrec = profile.weights.recovery;
  const wTotal = wd + wr + wo + wrec;

  const logSum =
    wd * Math.log(Math.max(1, d)) +
    wr * Math.log(Math.max(1, r)) +
    wo * Math.log(Math.max(1, o)) +
    wrec * Math.log(Math.max(1, rec));

  const geoMean = Math.exp(logSum / wTotal);

  const overall = Math.round(geoMean - interop);

  return {
    discoverability: Math.round(d),
    reachability: Math.round(r),
    operability: Math.round(o),
    recovery: Math.round(rec),
    interopRisk: Math.round(interop),
    overall: Math.max(0, Math.min(100, overall)),
  };
}

export function scoreSeverity(scores: ScoreVector): SeverityBand {
  return severityFromScore(scores.overall);
}
