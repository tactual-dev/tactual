import type { Target, Finding } from "./types.js";
import type { CaptureDiagnostic, DiagnosticCode } from "./diagnostics.js";
import { globToRegex } from "./glob.js";

/**
 * Analysis filter configuration.
 *
 * Controls which targets are analyzed, which findings are reported,
 * and which diagnostics are surfaced.
 */
export interface AnalysisFilter {
  /** Glob patterns matching target names to exclude (case-insensitive) */
  exclude?: string[];
  /** CSS selectors — elements matching these were excluded during capture */
  excludeSelectors?: string[];
  /** Only analyze targets within these landmark roles or names */
  focus?: string[];
  /** Diagnostic codes to suppress */
  suppress?: DiagnosticCode[];
  /** Priority overrides: pattern → priority level */
  priority?: Record<string, "critical" | "normal" | "low" | "ignore">;
  /** Minimum severity to include in output (default: all) */
  minSeverity?: "severe" | "high" | "moderate" | "acceptable" | "strong";
  /** Maximum number of findings to include (default: all) */
  maxFindings?: number;
  /** Score threshold — analysis fails if average is below this */
  threshold?: number;
}

/**
 * Filter targets before analysis based on exclude/focus patterns.
 */
export function filterTargets(targets: Target[], filter: AnalysisFilter): Target[] {
  let result = targets;

  // Apply exclusions
  if (filter.exclude && filter.exclude.length > 0) {
    const patterns = filter.exclude.map((p) => globToRegex(p));
    result = result.filter((t) => {
      const name = t.name?.toLowerCase() ?? "";
      const role = t.role?.toLowerCase() ?? "";
      const kind = t.kind?.toLowerCase() ?? "";
      return !patterns.some(
        (re) => re.test(name) || re.test(role) || re.test(kind),
      );
    });
  }

  // Apply focus (only include targets in specified landmarks/contexts)
  if (filter.focus && filter.focus.length > 0) {
    const focusPatterns = filter.focus.map((p) => globToRegex(p));
    // Find landmark targets matching focus patterns
    const focusLandmarks = targets.filter(
      (t) =>
        (t.kind === "landmark" || t.kind === "search") &&
        focusPatterns.some(
          (re) =>
            re.test(t.name?.toLowerCase() ?? "") ||
            re.test(t.role?.toLowerCase() ?? ""),
        ),
    );

    if (focusLandmarks.length > 0) {
      // Include the landmarks themselves + all targets between them and
      // the next landmark (simple positional containment)
      const focusIndices = new Set<number>();
      for (const landmark of focusLandmarks) {
        const startIdx = targets.indexOf(landmark);
        if (startIdx < 0) continue;
        focusIndices.add(startIdx);

        // Include all targets after this landmark until the next landmark
        for (let i = startIdx + 1; i < targets.length; i++) {
          if (targets[i].kind === "landmark" && !focusLandmarks.includes(targets[i])) break;
          focusIndices.add(i);
        }
      }

      const targetIndexMap = new Map(targets.map((t, i) => [t, i]));
      result = result.filter((t) => {
        const idx = targetIndexMap.get(t);
        return idx !== undefined && focusIndices.has(idx);
      });
    }
  }

  return result;
}

/**
 * Filter findings after analysis based on severity, priority, and count limits.
 */
export function filterFindings(
  findings: Finding[],
  filter: AnalysisFilter,
): Finding[] {
  let result = [...findings];

  // Apply exclusions to findings
  if (filter.exclude && filter.exclude.length > 0) {
    const patterns = filter.exclude.map((p) => globToRegex(p));
    result = result.filter((f) => {
      const id = f.targetId.toLowerCase();
      return !patterns.some((re) => re.test(id));
    });
  }

  // Apply minimum severity filter.
  // "minSeverity" means "show findings at this severity level or worse."
  // Ranking: severe(1) < high(2) < moderate(3) < acceptable(4) < strong(5).
  // --min-severity moderate keeps severe, high, and moderate (ranks 1-3).
  if (filter.minSeverity) {
    const minRank = severityRank(filter.minSeverity);
    result = result.filter((f) => severityRank(f.severity) <= minRank);
  }

  // Apply priority overrides — remove "ignore" priority findings
  if (filter.priority) {
    const priorityPatterns = Object.entries(filter.priority).map(
      ([pattern, level]) => ({ regex: globToRegex(pattern), level }),
    );
    result = result.filter((f) => {
      const id = f.targetId.toLowerCase();
      for (const { regex, level } of priorityPatterns) {
        if (regex.test(id) && level === "ignore") return false;
      }
      return true;
    });
  }

  // Apply count limit
  if (filter.maxFindings !== undefined && filter.maxFindings > 0) {
    result = result.slice(0, filter.maxFindings);
  }

  return result;
}

/**
 * Filter diagnostics by suppression list.
 */
export function filterDiagnostics(
  diagnostics: CaptureDiagnostic[],
  filter: AnalysisFilter,
): CaptureDiagnostic[] {
  if (!filter.suppress || filter.suppress.length === 0) return diagnostics;
  return diagnostics.filter((d) => !filter.suppress!.includes(d.code as DiagnosticCode));
}

/**
 * Check if analysis passes the score threshold.
 */
export function checkThreshold(
  findings: Finding[],
  threshold: number,
): { passed: boolean; average: number } {
  // No findings = page may be blocked/empty. Fail the threshold to surface the issue.
  if (findings.length === 0) return { passed: false, average: 0 };
  const average =
    findings.reduce((sum, f) => sum + f.scores.overall, 0) / findings.length;
  return { passed: average >= threshold, average };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function severityRank(severity: string): number {
  const ranks: Record<string, number> = {
    severe: 1,
    high: 2,
    moderate: 3,
    acceptable: 4,
    strong: 5,
  };
  return ranks[severity] ?? 3;
}
