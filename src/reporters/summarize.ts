import type { AnalysisResult, Finding, EvidenceItem, EvidenceSummary } from "../core/types.js";
import { summarizeEvidence } from "../core/evidence.js";

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
  /** Diagnostics (errors/warnings only). Structured fields (affectedCount,
   *  totalCount, affectedTargetIds, representativeFix) are preserved for
   *  diagnostics that carry them (e.g., no-skip-link, redundant-tab-stops,
   *  shared-structural-issue) so programmatic consumers can quantify
   *  impact without parsing the message text. */
  diagnostics: Array<{
    level: string;
    code: string;
    message: string;
    affectedCount?: number;
    totalCount?: number;
    affectedTargetIds?: string[];
    representativeFix?: string;
  }>;
  /** Common issue patterns grouped with affected target count */
  issueGroups: IssueGroup[];
  /** High-leverage clusters that point to repeated, reviewable fixes. */
  remediationCandidates: RemediationCandidate[];
  /** Worst N findings with full detail */
  worstFindings: DetailedFinding[];
  /** Whether output was truncated */
  truncated: boolean;
  /** Total findings before truncation */
  totalFindings: number;
  /** Virtual-screen-reader validation results when --validate was set. */
  validation?: {
    strategy: string;
    totalValidated: number;
    reachable: number;
    unreachable: number;
    meanAccuracy: number | null;
    results: unknown[];
  };
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
  /** Average overall score of affected targets (lower = more fixable impact). */
  averageScore: number;
  /** Estimated aggregate score improvement if the root cause is fixed.
   *  A heuristic: each affected target recovers the difference between
   *  (worst-plausible fixed score = 90) and its current score, summed.
   *  Useful for prioritizing fixes — a group with 12 affected targets at
   *  avg score 55 gives ~420 points of upside, beating an isolated
   *  severe finding at −35 from perfect. */
  estimatedScoreUplift: number;
  /** Average finding confidence for this issue group. */
  confidence: number;
  /** Aggregated evidence across affected findings. */
  evidenceSummary: EvidenceSummary;
}

export interface RemediationCandidate {
  title: string;
  category: string;
  issue: string;
  rationale: string;
  affectedCount: number;
  examples: string[];
  primaryFix: string;
  averageScore?: number;
  worstScore?: number;
  estimatedScoreUplift?: number;
  confidence: number;
  evidenceSummary: EvidenceSummary;
  suggestedValidation: string[];
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
  evidence: EvidenceItem[];
  evidenceSummary: EvidenceSummary;
}

/**
 * Summarize an analysis result for compact output.
 *
 * Groups findings by shared penalty patterns, keeps full detail only
 * for the worst N findings, and computes aggregate statistics.
 */
export function summarize(result: AnalysisResult, options?: { maxDetailedFindings?: number }): SummarizedResult {
  const maxDetailed = options?.maxDetailedFindings ?? MAX_DETAILED_FINDINGS;
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
    ? sortedScores[Math.max(0, Math.ceil(sortedScores.length * 0.1) - 1)]
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
    .slice(0, maxDetailed)
    .map(toDetailed);

  // Diagnostics (skip info-level and "ok"). Preserve `code` so
  // programmatic consumers (LLMs, CI scripts) can filter by code
  // rather than fragile message-text matching.
  const diagnostics = (result.diagnostics ?? [])
    .filter((d) => d.level !== "info" && d.code !== "ok")
    .map((d) => {
      const entry: {
        level: string;
        code: string;
        message: string;
        affectedCount?: number;
        totalCount?: number;
        affectedTargetIds?: string[];
        representativeFix?: string;
      } = { level: d.level, code: d.code, message: d.message };
      if (d.affectedCount !== undefined) entry.affectedCount = d.affectedCount;
      if (d.totalCount !== undefined) entry.totalCount = d.totalCount;
      if (d.affectedTargetIds !== undefined) entry.affectedTargetIds = d.affectedTargetIds;
      if (d.representativeFix !== undefined) entry.representativeFix = d.representativeFix;
      return entry;
    });
  const remediationCandidates = buildRemediationCandidates(issueGroups, diagnostics);

  const isTruncated = findings.length > maxDetailed;
  let truncationNote: TruncationNote | null = null;

  if (isTruncated) {
    const omitted = sorted.slice(maxDetailed);
    const omittedBySeverity: Record<string, number> = {};
    for (const f of omitted) {
      omittedBySeverity[f.severity] = (omittedBySeverity[f.severity] ?? 0) + 1;
    }

    const sevParts = Object.entries(omittedBySeverity)
      .filter(([, c]) => c > 0)
      .map(([s, c]) => `${c} ${s}`)
      .join(", ");

    truncationNote = {
      message: `Showing ${maxDetailed} of ${findings.length} findings (worst first). ${omitted.length} omitted: ${sevParts}.`,
      shown: maxDetailed,
      omitted: omitted.length,
      omittedBySeverity,
      howToSeeMore: "Fix the worst issues and re-run to surface lower-priority findings, or use --min-severity to focus on a specific band.",
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
    remediationCandidates,
    worstFindings,
    truncated: isTruncated,
    totalFindings: findings.length,
    ...((result as Record<string, unknown>).validation
      ? {
          validation: (result as Record<string, unknown>).validation as
            SummarizedResult["validation"],
        }
      : {}),
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
      const groupKey = penalty.replace(/(?<=\s|^)\d+(?=\s|$)/g, "N");
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
    if (representative.match(/^\d+\s+/)) {
      issue = representative.replace(/^\d+\s+/, "");
      // Capitalize first letter
      issue = issue.charAt(0).toUpperCase() + issue.slice(1);
    }

    const scores = affected.map((f) => f.scores.overall);
    const averageScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    // Heuristic upside: assume fixing the shared cause lifts each target
    // to a baseline of 90 (not 100 — residual per-target issues likely
    // remain). Sum of (90 - current_score) gives aggregate points.
    // Negative would mean the group is already above 90; clamp at 0.
    const FIX_CEILING = 90;
    const estimatedScoreUplift = Math.max(
      0,
      scores.reduce((sum, s) => sum + Math.max(0, FIX_CEILING - s), 0),
    );

    groups.push({
      issue,
      count: affected.length,
      fix,
      worstScore,
      examples,
      averageScore: Math.round(averageScore),
      estimatedScoreUplift: Math.round(estimatedScoreUplift),
      confidence: Math.round((affected.reduce((sum, f) => sum + f.confidence, 0) / affected.length) * 100) / 100,
      evidenceSummary: summarizeEvidence(affected.flatMap((f) => f.evidence ?? [])),
    });
  }

  // Sort by impact (uplift) descending — highest-leverage fixes first.
  // Falls back to count for ties.
  groups.sort((a, b) =>
    b.estimatedScoreUplift - a.estimatedScoreUplift || b.count - a.count,
  );
  return groups;
}

function buildRemediationCandidates(
  issueGroups: IssueGroup[],
  diagnostics: SummarizedResult["diagnostics"],
): RemediationCandidate[] {
  const candidates: RemediationCandidate[] = issueGroups
    .filter((g) => g.count >= 2 && (g.estimatedScoreUplift > 0 || g.worstScore < 75))
    .map((g) => {
      const category = classifyIssue(g.issue, g.fix);
      return {
        title: makeCandidateTitle(category, g),
        category,
        issue: g.issue,
        rationale:
          `${g.count} targets share this issue. This is likely one reusable component, ` +
          `layout pattern, or navigation structure fix rather than ${g.count} independent fixes.`,
        affectedCount: g.count,
        examples: g.examples,
        primaryFix: g.fix,
        averageScore: g.averageScore,
        worstScore: g.worstScore,
        estimatedScoreUplift: g.estimatedScoreUplift,
        confidence: g.confidence,
        evidenceSummary: g.evidenceSummary,
        suggestedValidation: validationStepsFor(category, g.examples),
      };
    });

  for (const d of diagnostics) {
    if (d.code !== "redundant-tab-stops") continue;
    candidates.push({
      title: "Consolidate repeated links to the same destination",
      category: "navigation-cost",
      issue: d.message,
      rationale:
        "Multiple focusable links reach the same destination, so keyboard and screen-reader users spend extra navigation steps on repeated targets.",
      affectedCount: d.affectedCount ?? 0,
      examples: d.affectedTargetIds ?? [],
      primaryFix:
        d.representativeFix ??
        'Consolidate duplicate anchors or remove redundant anchors from Tab order with tabindex="-1" when a single accessible link remains.',
      confidence: 0.9,
      evidenceSummary: { measured: 1, validated: 0, modeled: 0, heuristic: 0 },
      suggestedValidation: [
        "Re-run Tactual and confirm redundant-tab-stops is gone or reduced.",
        "Tab through the affected region and confirm each destination appears once in the keyboard order.",
      ],
    });
  }

  candidates.sort((a, b) =>
    (b.estimatedScoreUplift ?? 0) - (a.estimatedScoreUplift ?? 0) ||
    b.affectedCount - a.affectedCount ||
    a.title.localeCompare(b.title),
  );
  return candidates.slice(0, 10);
}

function classifyIssue(issue: string, fix: string): string {
  const text = `${issue} ${fix}`.toLowerCase();
  if (/menu|arrowdown|outside click/.test(text)) return "menu-contract";
  if (/dialog|modal|focus trap|shift\+tab/.test(text)) return "dialog-contract";
  if (/heading|landmark|skip|controls precede|linear traversal/.test(text)) return "navigation-structure";
  if (/tabindex|nested focusable|tab order|tab stop/.test(text)) return "keyboard-order";
  if (/aria-label|accessible name|label/.test(text)) return "accessible-name";
  if (/contrast|forced colors|hcm|icon/.test(text)) return "visual-mode";
  if (/combobox|listbox|option/.test(text)) return "composite-widget";
  return "component-pattern";
}

function makeCandidateTitle(category: string, group: IssueGroup): string {
  const labels: Record<string, string> = {
    "menu-contract": "Fix repeated menu keyboard contract failures",
    "dialog-contract": "Fix repeated dialog focus contract failures",
    "navigation-structure": "Reduce repeated screen-reader navigation cost",
    "keyboard-order": "Fix repeated keyboard order issues",
    "accessible-name": "Fix repeated accessible naming issues",
    "visual-mode": "Fix repeated visual-mode accessibility issues",
    "composite-widget": "Fix repeated composite widget contract issues",
    "component-pattern": "Fix repeated accessibility component pattern",
    "navigation-cost": "Reduce repeated keyboard navigation cost",
  };
  return `${labels[category] ?? labels["component-pattern"]} (${group.count} targets)`;
}

function validationStepsFor(category: string, examples: string[]): string[] {
  const steps = [
    "Re-run Tactual with the same profile and compare the affected target examples.",
  ];
  if (examples.length > 0) {
    steps.push(`Spot-check examples: ${examples.slice(0, 3).join(", ")}.`);
  }
  if (category === "menu-contract") {
    steps.push("Keyboard-test Enter, ArrowDown, Escape, and outside click on the menu trigger.");
  } else if (category === "dialog-contract") {
    steps.push("Keyboard-test Tab, Shift+Tab, Escape, initial focus, and focus return for the dialog.");
  } else if (category === "navigation-structure") {
    steps.push("Verify heading and landmark navigation reaches the affected region before long linear Tab traversal.");
  } else if (category === "keyboard-order") {
    steps.push("Tab through the affected region and confirm the DOM order matches the visual/task order.");
  } else if (category === "visual-mode") {
    steps.push("Verify normal, dark, and forced-colors modes with the visibility probe or Edge high contrast.");
  }
  return steps;
}

function toDetailed(f: Finding): DetailedFinding {
  // Strip shared-cause penalties (promoted to page-level diagnostics)
  // so individual findings show only what's unique to them
  const sharedCause = (f as Record<string, unknown>)._sharedCause as string[] | undefined;
  const penalties = sharedCause
    ? f.penalties.filter((p) => !sharedCause.includes(p))
    : f.penalties;

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
    penalties: penalties.length > 0 ? penalties : ["See page-level diagnostics for shared structural issues"],
    suggestedFixes: f.suggestedFixes,
    bestPath: f.bestPath,
    confidence: f.confidence,
    evidence: f.evidence ?? [],
    evidenceSummary: f.evidenceSummary ?? summarizeEvidence(f.evidence ?? []),
  };
}
