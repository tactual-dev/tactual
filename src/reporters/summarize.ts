import type { AnalysisResult, Finding } from "../core/types.js";

/**
 * Maximum detailed findings in summarized output.
 * The rest are grouped by issue pattern.
 */
const MAX_DETAILED_FINDINGS = 15;

export interface SummarizedResult {
  /** If truncated, this note should be rendered first in any output format */
  truncationNote: TruncationNote | null;
  /** Page/flow name */
  name: string;
  /** Profile used */
  profile: string;
  /** High-level stats */
  stats: {
    stateCount: number;
    targetCount: number;
    matchingTargets?: number;
    edgeCount: number;
    averageScore: number;
    /** 10th percentile score — "the worst 10% of targets score this or lower."
     * More meaningful than average for site comparison because it isn't
     * dominated by trivially-reachable elements. */
    p10Score: number;
    /** Median (50th percentile) score */
    medianScore: number;
    worstScore: number;
    bestScore: number;
  };
  /** Score distribution across the 0-100 range (buckets of 10) */
  scoreDistribution: number[];
  /** Count by severity band */
  severityCounts: Record<string, number>;
  /** Diagnostics (errors/warnings only) */
  diagnostics: Array<{ level: string; message: string }>;
  /** Common issue patterns grouped with affected target count */
  issueGroups: IssueGroup[];
  /** Worst N findings with full detail */
  worstFindings: DetailedFinding[];
  /** Whether output was truncated */
  truncated: boolean;
  /** Total findings before truncation */
  totalFindings: number;
}

export interface TruncationNote {
  /** Human-readable summary of what was truncated */
  message: string;
  /** How many findings are shown */
  shown: number;
  /** How many findings were omitted */
  omitted: number;
  /** Severity breakdown of omitted findings */
  omittedBySeverity: Record<string, number>;
  /** How to see the omitted findings */
  howToSeeMore: string;
}

export interface IssueGroup {
  /** The shared penalty description */
  issue: string;
  /** How many targets are affected */
  count: number;
  /** The shared suggested fix */
  fix: string;
  /** Worst score in this group */
  worstScore: number;
  /** Example target IDs (up to 3) */
  examples: string[];
}

export interface DetailedFinding {
  targetId: string;
  selector?: string;
  severity: string;
  actionType?: string;
  overall: number;
  scores: {
    discoverability: number;
    reachability: number;
    operability: number;
    recovery: number;
    interopRisk: number;
  };
  penalties: string[];
  suggestedFixes: string[];
  bestPath: string[];
  confidence: number;
}

/**
 * Summarize an analysis result for compact output.
 *
 * Groups findings by shared penalty patterns, keeps full detail only
 * for the worst N findings, and computes aggregate statistics.
 */
export function summarize(result: AnalysisResult): SummarizedResult {
  const findings = result.findings;

  // Severity counts
  const severityCounts: Record<string, number> = {
    severe: 0, high: 0, moderate: 0, acceptable: 0, strong: 0,
  };
  for (const f of findings) severityCounts[f.severity]++;

  // Stats
  const scores = findings.map((f) => f.scores.overall);
  const sortedScores = [...scores].sort((a, b) => a - b);
  const averageScore = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10
    : 0;
  const worstScore = scores.length > 0 ? Math.min(...scores) : 0;
  const bestScore = scores.length > 0 ? Math.max(...scores) : 0;
  const p10Score = scores.length >= 5
    ? sortedScores[Math.floor(sortedScores.length * 0.1)]
    : worstScore;
  const medianScore = scores.length > 0
    ? sortedScores[Math.floor(sortedScores.length * 0.5)]
    : 0;

  // Score distribution: 10 buckets (0-9, 10-19, ..., 90-100)
  const scoreDistribution = new Array(10).fill(0);
  for (const s of scores) {
    const bucket = Math.min(9, Math.floor(s / 10));
    scoreDistribution[bucket]++;
  }

  // Group findings by penalty pattern
  const issueGroups = groupByIssue(findings);

  // Worst N with full detail
  const sorted = [...findings].sort((a, b) => a.scores.overall - b.scores.overall);
  const worstFindings: DetailedFinding[] = sorted
    .slice(0, MAX_DETAILED_FINDINGS)
    .map(toDetailed);

  // Diagnostics (skip info-level and "ok")
  const diagnostics = (result.diagnostics ?? [])
    .filter((d) => d.level !== "info" && d.code !== "ok")
    .map((d) => ({ level: d.level, message: d.message }));

  const isTruncated = findings.length > MAX_DETAILED_FINDINGS;
  let truncationNote: TruncationNote | null = null;

  if (isTruncated) {
    const omitted = sorted.slice(MAX_DETAILED_FINDINGS);
    const omittedBySeverity: Record<string, number> = {};
    for (const f of omitted) {
      omittedBySeverity[f.severity] = (omittedBySeverity[f.severity] ?? 0) + 1;
    }

    const sevParts = Object.entries(omittedBySeverity)
      .filter(([, c]) => c > 0)
      .map(([s, c]) => `${c} ${s}`)
      .join(", ");

    truncationNote = {
      message: `Showing ${MAX_DETAILED_FINDINGS} of ${findings.length} findings (worst first). ${omitted.length} omitted: ${sevParts}.`,
      shown: MAX_DETAILED_FINDINGS,
      omitted: omitted.length,
      omittedBySeverity,
      howToSeeMore: "Fix the worst issues and re-run to surface lower-priority findings, or use minSeverity to focus on a specific band.",
    };
  }

  return {
    truncationNote,
    name: result.flow.name,
    profile: result.metadata.profile,
    stats: {
      stateCount: result.metadata.stateCount,
      targetCount: result.metadata.targetCount,
      ...(result.metadata.matchingTargets != null && {
        matchingTargets: result.metadata.matchingTargets,
      }),
      edgeCount: result.metadata.edgeCount,
      averageScore,
      p10Score,
      medianScore,
      worstScore,
      bestScore,
    },
    severityCounts,
    scoreDistribution,
    diagnostics,
    issueGroups,
    worstFindings,
    truncated: isTruncated,
    totalFindings: findings.length,
  };
}

/**
 * Group findings by their penalty patterns into issue groups.
 *
 * This collapses "30 tabs with the same interop warning" into one
 * group instead of 30 findings. Parameterized penalties (where only
 * the number differs, like "11 controls precede" vs "33 controls precede")
 * are normalized to the same group key.
 */
function groupByIssue(findings: Finding[]): IssueGroup[] {
  const penaltyMap = new Map<string, { findings: Finding[]; fix: string; representative: string }>();

  for (const f of findings) {
    for (let i = 0; i < f.penalties.length; i++) {
      const penalty = f.penalties[i];
      const fix = f.suggestedFixes[i] ?? f.suggestedFixes[0] ?? "";
      // Normalize numbers out of the group key so "11 controls precede"
      // and "33 controls precede" land in the same group.
      const groupKey = penalty.replace(/\d+/g, "N");
      const existing = penaltyMap.get(groupKey);
      if (existing) {
        existing.findings.push(f);
      } else {
        penaltyMap.set(groupKey, { findings: [f], fix, representative: penalty });
      }
    }
  }

  // Convert to groups, sorted by count descending
  const groups: IssueGroup[] = [];
  for (const [, { findings: affected, fix, representative }] of penaltyMap) {
    // Skip groups with only 1 target — those show up in detailed findings
    if (affected.length < 2) continue;

    const worstScore = Math.min(...affected.map((f) => f.scores.overall));

    // Deduplicate example target IDs (same element can appear in
    // multiple explore states)
    const seen = new Set<string>();
    const examples: string[] = [];
    for (const f of affected) {
      if (!seen.has(f.targetId) && examples.length < 3) {
        seen.add(f.targetId);
        examples.push(f.targetId);
      }
    }

    // For parameterized penalties ("42 controls precede..."), strip the
    // leading number to avoid redundancy with the Nx count prefix.
    let issue = representative;
    if (representative.match(/^\d+\s/)) {
      issue = representative.replace(/^\d+\s+/, "");
      // Capitalize first letter
      issue = issue.charAt(0).toUpperCase() + issue.slice(1);
    }

    groups.push({ issue, count: affected.length, fix, worstScore, examples });
  }

  groups.sort((a, b) => b.count - a.count);
  return groups;
}

function toDetailed(f: Finding): DetailedFinding {
  return {
    targetId: f.targetId,
    selector: f.selector,
    severity: f.severity,
    actionType: f.actionType,
    overall: f.scores.overall,
    scores: {
      discoverability: f.scores.discoverability,
      reachability: f.scores.reachability,
      operability: f.scores.operability,
      recovery: f.scores.recovery,
      interopRisk: f.scores.interopRisk,
    },
    penalties: f.penalties,
    suggestedFixes: f.suggestedFixes,
    bestPath: f.bestPath,
    confidence: f.confidence,
  };
}
